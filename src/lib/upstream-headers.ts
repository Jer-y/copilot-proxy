import type { Context } from 'hono'

import consola from 'consola'

const FORWARDED_RESPONSE_HEADERS = new Set([
  'cache-creation-input-tokens',
  'cache-read-input-tokens',
  'retry-after',
  'x-copilot-proxy-recovery-state',
  'x-copilot-service-request-id',
  'x-github-request-id',
  'x-request-id',
])

const FORWARDED_RESPONSE_HEADER_PREFIXES = [
  'anthropic-ratelimit-',
  'x-ratelimit-',
]

export function forwardUpstreamHeaders(c: Context, upstreamHeaders: Headers): void {
  for (const [key, value] of upstreamHeaders) {
    const normalizedKey = key.toLowerCase()
    if (
      FORWARDED_RESPONSE_HEADERS.has(normalizedKey)
      || FORWARDED_RESPONSE_HEADER_PREFIXES.some(prefix => normalizedKey.startsWith(prefix))
    ) {
      c.header(key, value)
    }
  }

  // Log quota and experiment info at debug level
  for (const [key, value] of upstreamHeaders) {
    if (key.startsWith('x-quota-snapshot')) {
      consola.debug(`Upstream ${key}: ${value}`)
    }
  }
  const expCtx = upstreamHeaders.get('x-copilot-api-exp-assignment-context')
  if (expCtx)
    consola.debug('Upstream experiment context:', expCtx)
}
