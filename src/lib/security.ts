import { BlockList, isIP } from 'node:net'
import process from 'node:process'

export const DEFAULT_HOST = '127.0.0.1'
export const CORS_ORIGINS_ENV = 'COPILOT_PROXY_CORS_ORIGINS'
export const ALLOWED_HOSTS_ENV = 'COPILOT_PROXY_ALLOWED_HOSTS'
export const EXPOSE_TOKEN_ENV = 'COPILOT_PROXY_EXPOSE_TOKEN'
export const HOSTED_USAGE_VIEWER_ORIGIN = 'https://jer-y.github.io'

interface RequestWithIp extends Request {
  ip?: string
}

const loopbackV6 = new BlockList()
loopbackV6.addAddress('::1', 'ipv6')
loopbackV6.addSubnet('::ffff:127.0.0.0', 104, 'ipv6')

let cachedCorsOriginsRaw: string | undefined
let cachedCorsOrigins = new Set<string>()
let cachedAllowedHostsRaw: string | undefined
let cachedAllowedHosts: ReadonlySet<string> = new Set<string>()

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase()

  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1)
  }

  const scopeIndex = normalized.indexOf('%')
  if (scopeIndex !== -1) {
    normalized = normalized.slice(0, scopeIndex)
  }

  while (normalized.endsWith('.')) {
    normalized = normalized.slice(0, -1)
  }

  return normalized
}

function normalizeAllowedHostname(hostname: string): string | null {
  const candidate = hostname.trim()
  if (!candidate)
    return null
  if (candidate.includes('%'))
    return null

  if (candidate.startsWith('[') || candidate.endsWith(']')) {
    if (!candidate.startsWith('[') || !candidate.endsWith(']'))
      return null

    const address = candidate.slice(1, -1)
    if (isIP(address) !== 6)
      return null

    return normalizeHostname(new URL(`http://[${address}]`).hostname)
  }

  const ipVersion = isIP(candidate)
  if (ipVersion === 4)
    return candidate
  if (ipVersion === 6)
    return normalizeHostname(new URL(`http://[${candidate}]`).hostname)

  let normalized = candidate.toLowerCase()
  if (normalized.endsWith('.'))
    normalized = normalized.slice(0, -1)
  if (!normalized || normalized.length > 253)
    return null

  const labels = normalized.split('.')
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    return null

  try {
    if (normalizeHostname(new URL(`http://${candidate}`).hostname) !== normalized)
      return null
  }
  catch {
    return null
  }

  return normalized
}

export function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined)
    return null

  const entries = raw.split(',')
  const hosts = new Set<string>()
  for (const entry of entries) {
    const hostname = normalizeAllowedHostname(entry)
    if (hostname === null)
      return null
    hosts.add(hostname)
  }

  return hosts.size > 0 ? hosts : null
}

export function hasValidNonLoopbackAllowedHost(raw: string | undefined): boolean {
  const allowedHosts = parseAllowedHosts(raw)
  return allowedHosts !== null
    && [...allowedHosts].some(hostname => !isLoopbackHostname(hostname))
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname)
  if (!normalized)
    return false

  if (normalized === 'localhost' || normalized.endsWith('.localhost'))
    return true

  const ipVersion = isIP(normalized)
  if (ipVersion === 4) {
    const octets = normalized.split('.').map(octet => Number.parseInt(octet, 10))
    return octets.length === 4
      && octets[0] === 127
      && octets.every(octet => Number.isInteger(octet) && octet >= 0 && octet <= 255)
  }

  if (ipVersion === 6)
    return loopbackV6.check(normalized, 'ipv6')

  return false
}

export function isLoopbackAddress(address: string): boolean {
  return isLoopbackHostname(address)
}

function normalizeWebOrigin(origin: string): string | null {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null

    return url.origin
  }
  catch {
    return null
  }
}

export function isLocalWebOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return false

    return isLoopbackHostname(url.hostname)
  }
  catch {
    return false
  }
}

function configuredCorsOrigins(): Set<string> {
  const raw = process.env[CORS_ORIGINS_ENV] ?? ''
  if (raw === cachedCorsOriginsRaw)
    return cachedCorsOrigins

  cachedCorsOriginsRaw = raw
  if (!raw) {
    cachedCorsOrigins = new Set()
    return cachedCorsOrigins
  }

  cachedCorsOrigins = new Set(
    raw
      .split(',')
      .map(origin => origin.trim())
      .map(normalizeWebOrigin)
      .filter((origin): origin is string => origin !== null),
  )
  return cachedCorsOrigins
}

function configuredAllowedHosts(): ReadonlySet<string> {
  const raw = process.env[ALLOWED_HOSTS_ENV] ?? ''
  if (raw === cachedAllowedHostsRaw)
    return cachedAllowedHosts

  cachedAllowedHostsRaw = raw
  cachedAllowedHosts = parseAllowedHosts(raw) ?? new Set<string>()
  return cachedAllowedHosts
}

function isHostedDashboardPath(path?: string): boolean {
  return path === '/diagnostics'
    || path === '/diagnostics/'
    || path === '/usage'
    || path === '/usage/'
}

export function resolveCorsOrigin(origin: string, path?: string): string | null {
  if (!origin)
    return null

  const normalizedOrigin = normalizeWebOrigin(origin)
  if (!normalizedOrigin)
    return null

  if (isLocalWebOrigin(normalizedOrigin))
    return origin

  if (configuredCorsOrigins().has(normalizedOrigin))
    return origin

  if (isHostedDashboardPath(path) && normalizedOrigin === HOSTED_USAGE_VIEWER_ORIGIN)
    return origin

  return null
}

export function isRequestOriginAllowed(request: Request, path?: string): boolean {
  const origin = request.headers.get('origin')
  return !origin || resolveCorsOrigin(origin, path) !== null
}

export function isRequestHostAllowed(request: Request): boolean {
  const hostname = requestHostname(request)
  if (!hostname)
    return false

  return isLoopbackHostname(hostname) || configuredAllowedHosts().has(normalizeHostname(hostname))
}

export function isTokenExposureEnabled(): boolean {
  return process.env[EXPOSE_TOKEN_ENV]?.trim() === '1'
}

function requestHostname(request: Request): string | null {
  const hostHeader = request.headers.get('host')?.trim()
  if (hostHeader) {
    // Host is an HTTP authority, never a full URL. URL parsers otherwise accept
    // userinfo such as `evil@127.0.0.1` and expose only the loopback hostname.
    const hasControlCharacter = [...hostHeader].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 0x20 || codePoint === 0x7F
    })
    if (/[%@/\\?#\s]/u.test(hostHeader) || hasControlCharacter)
      return null
    try {
      const url = new URL(`http://${hostHeader}`)
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash)
        return null
      return url.hostname
    }
    catch {
      return null
    }
  }

  try {
    const url = new URL(request.url)
    return url.username || url.password ? null : url.hostname
  }
  catch {
    return null
  }
}

export function isTokenRequestAllowed(request: Request): boolean {
  if (!isTokenExposureEnabled())
    return false

  // srvx attaches the socket address as request.ip for Node/Bun adapters. Revisit
  // this check if the proxy is ever placed behind another HTTP reverse proxy.
  const remoteIp = (request as RequestWithIp).ip
  if (!remoteIp || !isLoopbackAddress(remoteIp))
    return false

  let requestUrl: URL
  try {
    requestUrl = new URL(request.url)
  }
  catch {
    return false
  }

  if (!isLoopbackHostname(requestUrl.hostname) || !isRequestHostAllowed(request))
    return false

  const origin = request.headers.get('origin')
  if (!origin)
    return true

  return normalizeWebOrigin(origin) === requestUrl.origin
}
