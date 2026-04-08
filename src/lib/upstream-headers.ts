import type { Context } from 'hono'

import consola from 'consola'

export function forwardUpstreamHeaders(c: Context, upstreamHeaders: Headers): void {
  const requestId = upstreamHeaders.get('x-request-id')
  if (requestId)
    c.header('x-request-id', requestId)

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
