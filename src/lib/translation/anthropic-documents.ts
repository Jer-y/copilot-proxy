import type { LookupFunction } from 'node:net'
import type {
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicTextDocumentSource,
  AnthropicUserContentBlock,
} from './types'

import { Buffer } from 'node:buffer'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import process from 'node:process'
import { Readable } from 'node:stream'

import consola from 'consola'
import { JSONResponseError } from '~/lib/error'
import { isRuntimeProxyEnvironmentEnabled } from '~/lib/upstream-fetch'
import { logLossyAnthropicCompatibility, throwAnthropicInvalidRequestError } from './anthropic-compat'

const MAX_DOCUMENT_SIZE = 32 * 1024 * 1024 // 32 MB
const MAX_DOCUMENT_AGGREGATE_SIZE = 32 * 1024 * 1024 // Match the Messages request budget
const MAX_DOCUMENTS_PER_REQUEST = 16
const MAX_GLOBAL_DOCUMENT_EXPANSIONS = 6
const URL_FETCH_TIMEOUT = 30_000 // 30 seconds
const MAX_REDIRECTS = 5
export const DOCUMENT_URL_FETCH_ENV = 'COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH'

// RFC 4648 §4 – only A-Z a-z 0-9 + / = are legal, padding must form valid quartets.
function isValidBase64(data: string): boolean {
  // Strip whitespace for validation (Buffer.from also ignores whitespace)
  const stripped = data.replace(/\s/g, '')
  if (stripped.length === 0) {
    return false
  }
  // Must only contain base64 chars + valid padding
  if (!/^[A-Z0-9+/]*={0,2}$/i.test(stripped)) {
    return false
  }
  // Total length (with padding) must be a multiple of 4
  if (stripped.length % 4 !== 0) {
    return false
  }
  return true
}

/**
 * Parse a Content-Type / media_type string into base type and optional charset.
 * e.g. "text/plain; charset=iso-8859-1" → { mediaType: "text/plain", charset: "iso-8859-1" }
 */
function parseContentType(raw: string): { mediaType: string, charset?: string } {
  const parts = raw.split(';')
  const mediaType = parts[0].trim().toLowerCase()
  let charset: string | undefined
  for (let i = 1; i < parts.length; i++) {
    const param = parts[i].trim()
    if (param.toLowerCase().startsWith('charset=')) {
      charset = param.slice(8).trim().replace(/^["']|["']$/g, '')
    }
  }
  return { mediaType, charset }
}

export interface DocumentResolvedAddress {
  address: string
  family: number
}

type DocumentHostnameLookup = (hostname: string) => Promise<Array<DocumentResolvedAddress>>

interface DocumentUrlFetchResult {
  response: Response
  dispose: () => Promise<void>
}

type DocumentUrlFetcher = (
  url: string,
  addresses: ReadonlyArray<DocumentResolvedAddress>,
) => Promise<DocumentUrlFetchResult>

let documentHostnameLookup: DocumentHostnameLookup = async (hostname: string) => {
  return await lookup(hostname, { all: true, verbatim: true })
}

let documentUrlFetcher: DocumentUrlFetcher = fetchDocumentUrlAtVerifiedAddresses
let activeDocumentExpansions = 0

interface DocumentExpansionBudget {
  usedBytes: number
}

const blockedTransitionV6 = new BlockList()
blockedTransitionV6.addSubnet('64:ff9b::', 96, 'ipv6')
blockedTransitionV6.addSubnet('64:ff9b:1::', 48, 'ipv6')
blockedTransitionV6.addSubnet('2002::', 16, 'ipv6')
blockedTransitionV6.addSubnet('2001::', 32, 'ipv6')
blockedTransitionV6.addSubnet('::', 96, 'ipv6')
blockedTransitionV6.addSubnet('fec0::', 10, 'ipv6')

export function setDocumentUrlResolverForTesting(resolver: DocumentHostnameLookup): () => void {
  const previous = documentHostnameLookup
  documentHostnameLookup = resolver
  return () => {
    documentHostnameLookup = previous
  }
}

export function setDocumentUrlFetcherForTesting(
  fetcher: (url: string, addresses: ReadonlyArray<DocumentResolvedAddress>) => Promise<Response>,
): () => void {
  const previous = documentUrlFetcher
  documentUrlFetcher = async (url, addresses) => ({
    response: await fetcher(url, addresses),
    dispose: async () => {},
  })
  return () => {
    documentUrlFetcher = previous
  }
}

// Hostnames that must never be fetched. URL document fetching is disabled by
// default; when enabled, these names, private IP literals, DNS results, and
// redirect targets are still rejected before any body is downloaded.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '[::1]',
  '0.0.0.0',
  '::',
  'metadata.google.internal',
  // Common /etc/hosts aliases for loopback (Debian, WSL, etc.)
  'ip6-localhost',
  'ip6-loopback',
  // Container-local hostnames (Docker, Kubernetes)
  'host.docker.internal',
  'gateway.docker.internal',
  'kubernetes.default',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
])

// Matches a bare IPv4 address like "10.0.0.1" (no port, no hostname chars)
const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

function isDocumentUrlFetchEnabled(): boolean {
  const value = process.env[DOCUMENT_URL_FETCH_ENV]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function isBlockedHost(hostname: string): boolean {
  // Normalize: strip trailing dot (DNS root)
  let h = hostname.toLowerCase()
  if (h.endsWith('.')) {
    h = h.slice(0, -1)
  }

  if (BLOCKED_HOSTNAMES.has(h)) {
    return true
  }

  // Block *.localhost subdomains (treated as loopback in modern runtimes)
  if (h.endsWith('.localhost')) {
    return true
  }

  // Block local/private DNS suffixes that commonly resolve only inside a LAN,
  // container, or corporate network.
  if (h.endsWith('.local') || h.endsWith('.internal')) {
    return true
  }

  // Block Kubernetes cluster-internal service DNS names (*.svc, *.svc.cluster.local, etc.)
  if (h.endsWith('.svc') || h.endsWith('.svc.cluster.local')) {
    return true
  }

  // Strip IPv6 brackets for address checks
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h

  // --- IPv6 checks ---
  if (bare.includes(':')) {
    if (isIP(bare) === 6 && blockedTransitionV6.check(bare, 'ipv6'))
      return true
    // Loopback
    if (bare === '::1')
      return true
    // IPv6-mapped IPv4: URL parsers normalize to hex form (e.g. ::ffff:7f00:1)
    // Handle both dotted-decimal (::ffff:127.0.0.1) and hex (::ffff:7f00:1) forms
    const v4DottedMatch = bare.match(/^::ffff:(?:0:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (v4DottedMatch) {
      return isPrivateIPv4(v4DottedMatch[1])
    }
    const v4HexMatch = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (v4HexMatch) {
      const hi = Number.parseInt(v4HexMatch[1], 16)
      const lo = Number.parseInt(v4HexMatch[2], 16)
      const ip = `${hi >> 8}.${hi & 0xFF}.${lo >> 8}.${lo & 0xFF}`
      return isPrivateIPv4(ip)
    }
    // Unspecified
    if (bare === '::')
      return true
    // Unique local (fc00::/7 → fc and fd prefixes)
    if (bare.startsWith('fc') || bare.startsWith('fd'))
      return true
    // Link-local (fe80::/10 → fe80 through febf)
    if (/^fe[89ab][0-9a-f]:/.test(bare))
      return true
    // Multicast
    if (bare.startsWith('ff'))
      return true
    // Documentation and discard-only prefixes
    if (bare.startsWith('2001:db8:') || bare.startsWith('2001:0db8:') || bare === '2001:db8::')
      return true
    if (bare.startsWith('100:'))
      return true
    return false
  }

  // --- IPv4 checks (only for actual IP addresses, not hostnames like 10.example.com) ---
  if (IPV4_PATTERN.test(bare)) {
    return isPrivateIPv4(bare)
  }

  return false
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(part => Number.parseInt(part, 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }

  const [a, b, c] = parts

  // 0.0.0.0/8 current network
  if (a === 0)
    return true
  // 10.0.0.0/8 private
  if (a === 10)
    return true
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127)
    return true
  // 127.0.0.0/8 loopback
  if (a === 127)
    return true
  // 169.254.0.0/16 link-local / cloud metadata
  if (a === 169 && b === 254)
    return true
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31)
    return true
  // 192.0.0.0/24, 192.0.2.0/24 TEST-NET-1, 192.88.99.0/24 6to4 relay
  if (a === 192 && b === 0 && (c === 0 || c === 2))
    return true
  if (a === 192 && b === 88 && c === 99)
    return true
  // 192.168.0.0/16 private
  if (a === 192 && b === 168)
    return true
  // 198.18.0.0/15 benchmarking, 198.51.100.0/24 TEST-NET-2
  if (a === 198 && (b === 18 || b === 19))
    return true
  if (a === 198 && b === 51 && c === 100)
    return true
  // 203.0.113.0/24 TEST-NET-3
  if (a === 203 && b === 0 && c === 113)
    return true
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, including 255.255.255.255
  if (a >= 224)
    return true

  return false
}

/**
 * Fetches a URL with manual redirect following, re-checking each hop against
 * the SSRF blocklist. This allows legitimate redirects (301/302/307) while
 * preventing redirects to internal hosts.
 */
async function fetchWithSsrfCheck(initialUrl: string): Promise<DocumentUrlFetchResult> {
  let url = initialUrl

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = new URL(url)
    const addresses = await assertDocumentUrlFetchTargetAllowed(parsed, i > 0)
    const fetched = await documentUrlFetcher(url, addresses)
    const { response } = fetched

    // 3xx redirect — extract Location and re-check
    if (response.status >= 300 && response.status < 400) {
      try {
        const location = response.headers.get('location')
        if (!location) {
          throwAnthropicInvalidRequestError('Document URL redirect missing Location header')
        }
        // Resolve relative URLs
        url = new URL(location, url).href
      }
      finally {
        await cancelResponseBody(response)
        await fetched.dispose()
      }
      continue
    }

    return fetched
  }

  throwAnthropicInvalidRequestError(`Document URL exceeded maximum of ${MAX_REDIRECTS} redirects`)
}

async function assertDocumentUrlFetchTargetAllowed(
  url: URL,
  isRedirect: boolean,
): Promise<Array<DocumentResolvedAddress>> {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throwAnthropicInvalidRequestError(
      isRedirect
        ? 'Document URL redirected to a non-http(s) URL'
        : 'Document URL must use http or https protocol',
    )
  }

  if (isBlockedHost(url.hostname)) {
    throwAnthropicInvalidRequestError(
      isRedirect
        ? 'Document URL redirected to a blocked address. URLs targeting localhost, private networks, or cloud metadata endpoints are not allowed.'
        : 'Document URL points to a blocked address. URLs targeting localhost, private networks, or cloud metadata endpoints are not allowed.',
    )
  }

  return await resolveDocumentHostnamePublicAddresses(url.hostname, isRedirect)
}

async function resolveDocumentHostnamePublicAddresses(
  hostname: string,
  isRedirect: boolean,
): Promise<Array<DocumentResolvedAddress>> {
  const lookupHostname = normalizeLookupHostname(hostname)
  let addresses: Array<{ address: string, family: number }>

  try {
    addresses = await documentHostnameLookup(lookupHostname)
  }
  catch (error) {
    throwAnthropicInvalidRequestError(
      `Failed to resolve document URL hostname '${lookupHostname}': ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (addresses.length === 0) {
    throwAnthropicInvalidRequestError(`Failed to resolve document URL hostname '${lookupHostname}': no addresses returned`)
  }

  const invalidAddress = addresses.find(result => isIP(result.address) === 0)
  if (invalidAddress) {
    throwAnthropicInvalidRequestError(
      `Failed to resolve document URL hostname '${lookupHostname}': resolver returned an invalid IP address`,
    )
  }

  const blockedAddress = addresses.find(result => isBlockedHost(result.address))
  if (!blockedAddress) {
    return addresses.map(result => ({
      address: result.address,
      family: isIP(result.address),
    }))
  }

  throwAnthropicInvalidRequestError(
    isRedirect
      ? `Document URL redirected to a hostname that resolves to a blocked address (${blockedAddress.address}). URLs targeting localhost, private networks, or cloud metadata endpoints are not allowed.`
      : `Document URL hostname resolves to a blocked address (${blockedAddress.address}). URLs targeting localhost, private networks, or cloud metadata endpoints are not allowed.`,
  )
}

async function fetchDocumentUrlAtVerifiedAddresses(
  url: string,
  addresses: ReadonlyArray<DocumentResolvedAddress>,
): Promise<DocumentUrlFetchResult> {
  return await fetchDocumentUrlUnderNode(url, addresses)
}

async function fetchDocumentUrlUnderNode(
  url: string,
  addresses: ReadonlyArray<DocumentResolvedAddress>,
): Promise<DocumentUrlFetchResult> {
  if (isRuntimeProxyEnvironmentEnabled()) {
    throw new Error('Document URL fetching is disabled when --proxy-env is enabled because a proxy-safe DNS-pinned connector is not available.')
  }

  const target = new URL(url)
  const requestFn = target.protocol === 'https:' ? httpsRequest : httpRequest

  return await new Promise<DocumentUrlFetchResult>((resolve, reject) => {
    let responseReceived = false
    let timeout: ReturnType<typeof setTimeout> | undefined

    const request = requestFn(target, {
      method: 'GET',
      lookup: createPinnedDocumentLookup(addresses),
      headers: {
        'Accept': 'application/pdf, text/*;q=0.9, application/octet-stream;q=0.5',
        'User-Agent': 'copilot-proxy-document-fetch/1',
      },
    }, (incoming) => {
      responseReceived = true
      try {
        const status = incoming.statusCode ?? 502
        if (status < 200 || status > 599)
          throw new Error(`Document URL returned unsupported HTTP status ${status}`)

        const body = status === 204 || status === 205 || status === 304
          ? null
          : Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>
        const response = new Response(body, {
          status,
          statusText: incoming.statusMessage,
          headers: headersFromRawPairs(incoming.rawHeaders),
        })

        resolve({
          response,
          dispose: async () => {
            if (timeout)
              clearTimeout(timeout)
            incoming.destroy()
            request.destroy()
          },
        })
      }
      catch (error) {
        if (timeout)
          clearTimeout(timeout)
        incoming.destroy()
        request.destroy()
        reject(error)
      }
    })

    timeout = setTimeout(() => {
      request.destroy(new Error(`Document URL fetch timed out after ${URL_FETCH_TIMEOUT}ms`))
    }, URL_FETCH_TIMEOUT)
    timeout.unref?.()

    request.once('error', (error) => {
      if (timeout)
        clearTimeout(timeout)
      if (!responseReceived)
        reject(error)
    })
    request.end()
  })
}

function headersFromRawPairs(rawHeaders: string[]): Headers {
  const headers = new Headers()
  for (let index = 0; index + 1 < rawHeaders.length; index += 2)
    headers.append(rawHeaders[index], rawHeaders[index + 1])
  return headers
}

function createPinnedDocumentLookup(
  addresses: ReadonlyArray<DocumentResolvedAddress>,
): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = options.family === 4 || options.family === 6
      ? options.family
      : undefined
    const candidates = requestedFamily
      ? addresses.filter(address => address.family === requestedFamily)
      : [...addresses]

    if (candidates.length === 0) {
      const error = Object.assign(new Error('No verified document URL address matches the requested family'), {
        code: 'ENOTFOUND',
      }) as NodeJS.ErrnoException
      callback(error, '')
      return
    }

    if (options.all) {
      callback(null, candidates.map(candidate => ({
        address: candidate.address,
        family: candidate.family,
      })))
      return
    }

    const selected = candidates[0]
    callback(null, selected.address, selected.family)
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

function normalizeLookupHostname(hostname: string): string {
  let h = hostname.toLowerCase()
  if (h.endsWith('.')) {
    h = h.slice(0, -1)
  }
  if (h.startsWith('[') && h.endsWith(']')) {
    h = h.slice(1, -1)
  }
  return h
}

/**
 * Reads a fetch Response body in chunks, aborting as soon as the
 * accumulated size exceeds `maxBytes`. This prevents a malicious or
 * oversized URL response from exhausting process memory.
 */
async function readResponseWithSizeLimit(
  response: Response,
  maxBytes: number,
  budget?: DocumentExpansionBudget,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    // Fallback: no streaming body, read all at once (shouldn't happen in practice)
    const buf = await response.arrayBuffer()
    if (buf.byteLength > maxBytes) {
      throwAnthropicInvalidRequestError('Document exceeds maximum size of 32MB')
    }
    consumeDocumentBudget(budget, buf.byteLength)
    return new Uint8Array(buf)
  }

  const chunks: Uint8Array[] = []
  let totalSize = 0
  let completed = false

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      totalSize += value.byteLength
      if (totalSize > maxBytes) {
        throwAnthropicInvalidRequestError('Document exceeds maximum size of 32MB')
      }
      consumeDocumentBudget(budget, value.byteLength)
      chunks.push(value)
    }
    completed = true
  }
  finally {
    if (!completed) {
      await reader.cancel().catch(() => {})
    }
    reader.releaseLock()
  }

  // Concatenate chunks into a single Uint8Array
  const result = new Uint8Array(totalSize)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/**
 * Pre-processes an Anthropic Messages payload, expanding all `document`
 * content blocks into `text` blocks by extracting text from PDFs or
 * decoding text-based formats.
 *
 * Mutates the payload in place. After this function returns, no
 * `document` blocks remain in the payload — downstream translation
 * code will only see `text`, `image`, and `tool_result` blocks.
 */
export async function expandDocumentBlocks(
  payload: AnthropicMessagesPayload,
): Promise<void> {
  await expandDocumentBlocksMatching(payload, () => true)
}

/**
 * GitHub Copilot's native `/v1/messages` backend accepts PDF document blocks,
 * but currently rejects Anthropic inline text document sources. Expand only
 * those unsupported text-like documents, leaving PDF/url/file blocks for the
 * native backend to handle or reject with its own semantics.
 */
export async function expandCopilotUnsupportedTextDocumentBlocks(
  payload: AnthropicMessagesPayload,
): Promise<void> {
  await expandDocumentBlocksMatching(payload, shouldExpandForCopilotNativePassthrough)
}

async function expandDocumentBlocksMatching(
  payload: AnthropicMessagesPayload,
  shouldExpand: (block: AnthropicDocumentBlock) => boolean,
): Promise<void> {
  const tasks: Array<{
    array: Array<unknown>
    index: number
    block: AnthropicDocumentBlock
  }> = []

  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }

    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i]

      // Top-level document block
      if (block.type === 'document' && shouldExpand(block)) {
        assertDocumentExpansionPreservesRequiredSemantics(block)
        tasks.push({
          array: message.content as Array<unknown>,
          index: i,
          block,
        })
      }

      // Recurse into tool_result.content[]
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          const inner = block.content[j]
          if (inner.type === 'document' && shouldExpand(inner)) {
            assertDocumentExpansionPreservesRequiredSemantics(inner)
            tasks.push({
              array: block.content as Array<unknown>,
              index: j,
              block: inner,
            })
          }
        }
      }
    }
  }

  if (tasks.length === 0) {
    return
  }

  if (tasks.length > MAX_DOCUMENTS_PER_REQUEST) {
    throwAnthropicInvalidRequestError(`A request may expand at most ${MAX_DOCUMENTS_PER_REQUEST} document blocks`)
  }

  consola.debug(`Expanding ${tasks.length} document block(s) into text`)
  const budget: DocumentExpansionBudget = { usedBytes: 0 }

  // Process documents with bounded concurrency (max 3 at a time) to limit memory pressure
  const MAX_CONCURRENCY = 3
  for (let i = 0; i < tasks.length; i += MAX_CONCURRENCY) {
    const batch = tasks.slice(i, i + MAX_CONCURRENCY)
    const results = await Promise.all(batch.map(t => withDocumentExpansionSlot(
      () => documentToTextBlock(t.block, budget),
    )))
    for (let j = 0; j < batch.length; j++) {
      batch[j].array[batch[j].index] = results[j]
    }
  }
}

function shouldExpandForCopilotNativePassthrough(block: AnthropicDocumentBlock): boolean {
  const source = block.source
  return source.type === 'text'
    || source.type === 'content'
    || (source.type === 'base64' && parseContentType(source.media_type).mediaType.startsWith('text/'))
}

function assertDocumentExpansionPreservesRequiredSemantics(block: AnthropicDocumentBlock): void {
  if (block.citations?.enabled) {
    throwAnthropicInvalidRequestError(
      'Document citations cannot be preserved during local document expansion. Use a base64 PDF with a native Anthropic-backed model or set citations.enabled=false.',
    )
  }

  if (block.source.type === 'content' && block.source.content.some(contentBlock => contentBlock.cache_control)) {
    throwAnthropicInvalidRequestError(
      'document.source.content cache_control cannot be preserved during local document expansion. Send the content as ordinary text blocks instead.',
    )
  }
}

export function normalizeLegacyDocumentTextSources(
  payload: AnthropicMessagesPayload,
): void {
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }

    normalizeUserContentDocumentSources(message.content)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeUserContentDocumentSources(
  blocks: Array<AnthropicUserContentBlock>,
): void {
  for (const block of blocks) {
    if (block.type === 'document') {
      normalizeTextDocumentSource(block.source)
      continue
    }

    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      normalizeUserContentDocumentSources(block.content)
    }
  }
}

function normalizeTextDocumentSource(
  source: AnthropicDocumentBlock['source'],
): void {
  if (source.type !== 'text') {
    return
  }

  const textSource = source as AnthropicTextDocumentSource

  if (typeof textSource.data === 'string') {
    if (typeof textSource.text === 'string') {
      delete textSource.text
    }
    return
  }

  if (typeof textSource.text === 'string') {
    logLossyAnthropicCompatibility(
      'document.source.text',
      'legacy source.text normalized to source.data for Copilot compatibility',
    )
    textSource.data = textSource.text
    delete textSource.text
  }
}

async function documentToTextBlock(
  block: AnthropicDocumentBlock,
  budget: DocumentExpansionBudget,
): Promise<AnthropicTextBlock> {
  const source = await resolveDocumentSource(block.source, budget)
  const rawText = source.kind === 'text'
    ? source.text
    : await extractDocumentText(source.buffer, source.mediaType, source.charset)
  const text = formatDocumentText(
    rawText,
    block.title ?? undefined,
    block.context ?? undefined,
  )
  if (source.kind === 'bytes' && source.mediaType === 'application/pdf') {
    consumeDocumentBudget(budget, Buffer.byteLength(text, 'utf8'))
  }

  return {
    type: 'text',
    text,
    ...(block.cache_control ? { cache_control: block.cache_control } : {}),
  }
}

type ResolvedDocumentSource
  = | {
    kind: 'bytes'
    buffer: Uint8Array
    mediaType: string
    charset?: string
  }
  | {
    kind: 'text'
    text: string
  }

async function resolveDocumentSource(
  source: AnthropicDocumentBlock['source'],
  budget: DocumentExpansionBudget,
): Promise<ResolvedDocumentSource> {
  if (source.type === 'base64') {
    // Validate base64 format — Buffer.from is too permissive (silently ignores invalid chars)
    if (!isValidBase64(source.data)) {
      throwAnthropicInvalidRequestError('Invalid base64 data in document block')
    }

    // Pre-check: reject clearly oversized payloads before allocating the decoded buffer.
    // Base64 encodes 3 bytes per 4 chars; subtract padding for accurate estimate.
    const stripped = source.data.replace(/\s/g, '')
    const padding = stripped.endsWith('==') ? 2 : stripped.endsWith('=') ? 1 : 0
    const estimatedBytes = Math.floor(stripped.length * 3 / 4) - padding
    if (estimatedBytes > MAX_DOCUMENT_SIZE) {
      throwAnthropicInvalidRequestError('Document exceeds maximum size of 32MB')
    }

    const buffer = Buffer.from(source.data, 'base64')

    // Enforce size limit on the actual decoded bytes
    if (buffer.byteLength > MAX_DOCUMENT_SIZE) {
      throwAnthropicInvalidRequestError(
        'Document exceeds maximum size of 32MB',
      )
    }
    consumeDocumentBudget(budget, buffer.byteLength)

    // Convert to plain Uint8Array — unpdf rejects Buffer instances
    const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    let { mediaType, charset } = parseContentType(source.media_type)

    // Sniff content when media_type is generic (same as URL path)
    if (mediaType === 'application/octet-stream' && uint8.length > 0) {
      if (uint8.length >= 5 && uint8[0] === 0x25 && uint8[1] === 0x50 && uint8[2] === 0x44 && uint8[3] === 0x46 && uint8[4] === 0x2D) {
        mediaType = 'application/pdf'
      }
      else {
        try {
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(uint8)
          if (decoded.length > 0) {
            mediaType = 'text/plain'
          }
        }
        catch {
          // Not valid UTF-8 — leave as octet-stream
        }
      }
    }

    return { kind: 'bytes', buffer: uint8, mediaType, charset }
  }

  if (source.type === 'text') {
    const { mediaType } = parseContentType(source.media_type)
    if (!mediaType.startsWith('text/')) {
      throwAnthropicInvalidRequestError(
        `Unsupported document media_type '${mediaType}'. Supported: application/pdf, text/*`,
      )
    }

    const text = getTextDocumentSourceData(source)
    consumeDocumentBudget(budget, Buffer.byteLength(text, 'utf8'))
    return {
      kind: 'text',
      text,
    }
  }

  if (source.type === 'content') {
    const text = source.content.map(block => block.text).join('\n\n')
    consumeDocumentBudget(budget, Buffer.byteLength(text, 'utf8'))
    return {
      kind: 'text',
      text,
    }
  }

  if (source.type === 'file') {
    throwAnthropicInvalidRequestError(
      'Files API (source.type=\'file\') is not supported. GitHub Copilot upstream does not expose the Anthropic Files API. Upload document content directly using base64, text, or url source types instead.',
    )
  }

  // URL source
  let url: URL
  try {
    url = new URL(source.url)
  }
  catch {
    throwAnthropicInvalidRequestError(`Invalid document URL: ${source.url}`)
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throwAnthropicInvalidRequestError(
      'Document URL must use http or https protocol',
    )
  }

  if (!isDocumentUrlFetchEnabled()) {
    throwAnthropicInvalidRequestError(
      `Document URL sources are disabled for local translation. Set ${DOCUMENT_URL_FETCH_ENV}=1 to allow the proxy to fetch document URLs, or provide document content inline using base64, text, or content source types.`,
    )
  }

  try {
    // Follow redirects manually with SSRF re-check at each hop
    const fetched = await fetchWithSsrfCheck(source.url)
    const { response } = fetched

    try {
      if (!response.ok) {
        throwAnthropicInvalidRequestError(
          `Failed to fetch document from URL: HTTP ${response.status}`,
        )
      }

      // Pre-flight size check via Content-Length header to reject obviously oversized responses
      const contentLength = response.headers.get('content-length')
      if (contentLength && Number.parseInt(contentLength, 10) > MAX_DOCUMENT_SIZE) {
        throwAnthropicInvalidRequestError(
          'Document exceeds maximum size of 32MB',
        )
      }

      // Pre-flight Content-Type check: reject definitely unsupported types before downloading body
      const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
      let { mediaType, charset } = parseContentType(contentType)
      if (mediaType !== 'application/pdf'
        && mediaType !== 'application/octet-stream' // may be PDF, sniff after download
        && !mediaType.startsWith('text/')) {
        throwAnthropicInvalidRequestError(
          `Unsupported document media_type '${mediaType}'. Supported: application/pdf, text/*`,
        )
      }

      // Stream response body with size enforcement to prevent memory exhaustion
      // (Content-Length may be absent, chunked, or lie)
      const buffer = await readResponseWithSizeLimit(response, MAX_DOCUMENT_SIZE, budget)

      // Sniff content when Content-Type is generic/missing (common for pre-signed URLs, attachment endpoints)
      if (mediaType === 'application/octet-stream' && buffer.length > 0) {
        // %PDF- magic bytes check (needs at least 5 bytes)
        if (buffer.length >= 5 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2D) {
          mediaType = 'application/pdf'
        }
        else {
          // Try to detect text: if the buffer decodes as valid UTF-8 without replacement chars,
          // treat it as text/plain. This handles common cases where text files are served as octet-stream.
          try {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
            if (decoded.length > 0) {
              mediaType = 'text/plain'
            }
          }
          catch {
            // Not valid UTF-8 — leave as octet-stream, will be rejected downstream
          }
        }
      }

      return { kind: 'bytes', buffer, mediaType, charset }
    }
    finally {
      await cancelResponseBody(response)
      await fetched.dispose()
    }
  }
  catch (error) {
    // Re-throw already-wrapped Anthropic errors
    if (error instanceof JSONResponseError) {
      throw error
    }
    throwAnthropicInvalidRequestError(
      `Failed to fetch document from URL: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function consumeDocumentBudget(
  budget: DocumentExpansionBudget | undefined,
  bytes: number,
): void {
  if (!budget)
    return
  budget.usedBytes += bytes
  if (budget.usedBytes > MAX_DOCUMENT_AGGREGATE_SIZE) {
    throwAnthropicInvalidRequestError('Expanded documents exceed the per-request aggregate limit of 32MB')
  }
}

async function withDocumentExpansionSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeDocumentExpansions >= MAX_GLOBAL_DOCUMENT_EXPANSIONS) {
    throw new JSONResponseError(
      'Too many document expansions are already in progress',
      503,
      {
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'Too many document expansions are already in progress',
        },
      },
    )
  }

  activeDocumentExpansions++
  try {
    return await fn()
  }
  finally {
    activeDocumentExpansions--
  }
}

function getTextDocumentSourceData(source: AnthropicTextDocumentSource): string {
  if (typeof source.data === 'string') {
    return source.data
  }

  if (typeof source.text === 'string') {
    logLossyAnthropicCompatibility(
      'document.source.text',
      'legacy source.text accepted for document expansion; official Anthropic shape uses source.data',
    )
    return source.text
  }

  throwAnthropicInvalidRequestError(
    'Document text source requires "data" (official) or legacy "text"',
  )
}

async function extractDocumentText(
  buffer: Uint8Array,
  mediaType: string,
  charset?: string,
): Promise<string> {
  // PDF — extract text using unpdf (dynamic import, cached after first load)
  if (mediaType === 'application/pdf') {
    try {
      const { extractText } = await import('unpdf')
      // mergePages: true uses .replace(/\s+/g, ' ') which destroys all formatting.
      // Use mergePages: false → string[], then join with double newlines to preserve structure.
      const { text: pages } = await extractText(buffer, { mergePages: false })
      const text = (pages as string[]).join('\n\n')

      // Warn about scanned/image-only PDFs that extract to empty text
      if (!text.trim()) {
        consola.warn('PDF document extracted to empty text (scanned/image-only PDF). The model will receive an empty text block.')
      }

      return text
    }
    catch (error) {
      throwAnthropicInvalidRequestError(
        `Failed to extract text from PDF document: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  // All text/* types: text/plain, text/html, text/csv, text/markdown, etc.
  // Respect the source charset (e.g. text/plain; charset=iso-8859-1) to avoid mojibake.
  if (mediaType.startsWith('text/')) {
    const encoding = charset || 'utf-8'
    try {
      // Cast to any: charset is user-provided, TextDecoder will throw on unsupported labels
      return new TextDecoder(encoding as any).decode(buffer)
    }
    catch {
      // Unknown encoding label — fall back to UTF-8
      return new TextDecoder('utf-8').decode(buffer)
    }
  }

  throwAnthropicInvalidRequestError(
    `Unsupported document media_type '${mediaType}'. Supported: application/pdf, text/*`,
  )
}

function formatDocumentText(
  text: string,
  title?: string,
  context?: string,
): string {
  const parts: string[] = []

  if (title) {
    parts.push(`[Document: ${title}]`)
  }
  if (context) {
    parts.push(`Context: ${context}`)
  }

  if (parts.length > 0) {
    parts.push('') // blank line separator
    parts.push(text)
    return parts.join('\n')
  }

  return text
}
