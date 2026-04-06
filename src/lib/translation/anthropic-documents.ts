import type {
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
} from './types'

import { Buffer } from 'node:buffer'

import consola from 'consola'
import { JSONResponseError } from '~/lib/error'
import { logLossyAnthropicCompatibility, throwAnthropicInvalidRequestError } from './anthropic-compat'

const MAX_DOCUMENT_SIZE = 32 * 1024 * 1024 // 32 MB
const URL_FETCH_TIMEOUT = 30_000 // 30 seconds

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

// IPs and hostnames that must never be fetched (SSRF protection).
// NOTE: This is a string-based blocklist. It cannot prevent DNS rebinding attacks
// where an attacker-controlled hostname resolves to a private IP. Full DNS-level
// SSRF protection would require pre-resolving the hostname and checking the IP,
// which is not straightforward in Node/Bun. For this personal-use proxy, the
// current protection (blocklist + redirect: 'error') is a pragmatic trade-off.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '[::1]',
  '0.0.0.0',
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

  // Block Kubernetes cluster-internal service DNS names (*.svc, *.svc.cluster.local, etc.)
  if (h.endsWith('.svc') || h.endsWith('.svc.cluster.local')) {
    return true
  }

  // Strip IPv6 brackets for address checks
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h

  // --- IPv6 checks ---
  if (bare.includes(':')) {
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
    // Unique local (fc00::/7 → fc and fd prefixes)
    if (bare.startsWith('fc') || bare.startsWith('fd'))
      return true
    // Link-local (fe80::/10 → fe80 through febf)
    if (/^fe[89ab][0-9a-f]:/.test(bare))
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
  const parts = ip.split('.')
  const a = Number.parseInt(parts[0], 10)
  const b = Number.parseInt(parts[1], 10)

  // 127.0.0.0/8 loopback
  if (a === 127)
    return true
  // 10.0.0.0/8 private
  if (a === 10)
    return true
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31)
    return true
  // 192.168.0.0/16 private
  if (a === 192 && b === 168)
    return true
  // 169.254.0.0/16 link-local / cloud metadata
  if (a === 169 && b === 254)
    return true
  // 0.0.0.0
  if (a === 0 && b === 0)
    return true

  return false
}

const MAX_REDIRECTS = 5

/**
 * Fetches a URL with manual redirect following, re-checking each hop against
 * the SSRF blocklist. This allows legitimate redirects (301/302/307) while
 * preventing redirects to internal hosts.
 */
async function fetchWithSsrfCheck(initialUrl: string): Promise<Response> {
  let url = initialUrl

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const parsed = new URL(url)
    if (isBlockedHost(parsed.hostname)) {
      throwAnthropicInvalidRequestError(
        'Document URL redirected to a blocked address. URLs targeting localhost, private networks, or cloud metadata endpoints are not allowed.',
      )
    }

    const response = await fetch(url, {
      signal: AbortSignal.timeout(URL_FETCH_TIMEOUT),
      redirect: 'manual',
    })

    // 3xx redirect — extract Location and re-check
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) {
        throwAnthropicInvalidRequestError('Document URL redirect missing Location header')
      }
      // Resolve relative URLs
      url = new URL(location, url).href
      continue
    }

    return response
  }

  throwAnthropicInvalidRequestError(`Document URL exceeded maximum of ${MAX_REDIRECTS} redirects`)
}

/**
 * Reads a fetch Response body in chunks, aborting as soon as the
 * accumulated size exceeds `maxBytes`. This prevents a malicious or
 * oversized URL response from exhausting process memory.
 */
async function readResponseWithSizeLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    // Fallback: no streaming body, read all at once (shouldn't happen in practice)
    const buf = await response.arrayBuffer()
    if (buf.byteLength > maxBytes) {
      throwAnthropicInvalidRequestError('Document exceeds maximum size of 32MB')
    }
    return new Uint8Array(buf)
  }

  const chunks: Uint8Array[] = []
  let totalSize = 0

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
      chunks.push(value)
    }
  }
  finally {
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
      if (block.type === 'document') {
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
          if (inner.type === 'document') {
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

  consola.debug(`Expanding ${tasks.length} document block(s) into text`)

  // Process documents with bounded concurrency (max 3 at a time) to limit memory pressure
  const MAX_CONCURRENCY = 3
  for (let i = 0; i < tasks.length; i += MAX_CONCURRENCY) {
    const batch = tasks.slice(i, i + MAX_CONCURRENCY)
    const results = await Promise.all(batch.map(t => documentToTextBlock(t.block)))
    for (let j = 0; j < batch.length; j++) {
      batch[j].array[batch[j].index] = results[j]
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function documentToTextBlock(
  block: AnthropicDocumentBlock,
): Promise<AnthropicTextBlock> {
  // Log dropped citations (field exists at runtime via .passthrough() but not in our TS type)
  if ('citations' in block) {
    logLossyAnthropicCompatibility(
      'document.citations',
      'citations not supported, dropped during document expansion',
    )
  }

  const { buffer, mediaType, charset } = await resolveDocumentSource(block.source)
  const rawText = await extractDocumentText(buffer, mediaType, charset)
  const text = formatDocumentText(rawText, block.title, block.context)

  return {
    type: 'text',
    text,
    ...(block.cache_control ? { cache_control: block.cache_control } : {}),
  }
}

async function resolveDocumentSource(
  source: AnthropicDocumentBlock['source'],
): Promise<{ buffer: Uint8Array, mediaType: string, charset?: string }> {
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

    return { buffer: uint8, mediaType, charset }
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

  if (isBlockedHost(url.hostname)) {
    throwAnthropicInvalidRequestError(
      'Document URL points to a blocked address. URLs targeting localhost, private networks, or cloud metadata endpoints are not allowed.',
    )
  }

  try {
    // Follow redirects manually with SSRF re-check at each hop
    const response = await fetchWithSsrfCheck(source.url)

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
    const buffer = await readResponseWithSizeLimit(response, MAX_DOCUMENT_SIZE)

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

    return { buffer, mediaType, charset }
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
