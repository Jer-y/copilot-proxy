import type { Context, Next } from 'hono'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { state } from '~/lib/state'

/**
 * Hono middleware that enforces API key authentication on proxy entrance.
 *
 * - If `state.apiKey` is undefined, the middleware is a no-op (backward compatible).
 * - Accepts key via `Authorization: Bearer <key>` or `x-api-key: <key>`.
 * - Uses constant-time comparison to prevent timing attacks.
 */
export async function apiKeyAuth(c: Context, next: Next): Promise<Response | void> {
  const expected = state.apiKey
  if (!expected) {
    return next()
  }

  const provided = extractApiKey(c)
  if (!provided) {
    return c.json({ error: 'Unauthorized', message: 'Missing API key. Provide via Authorization: Bearer <key> or x-api-key: <key>' }, 401)
  }

  if (!safeEqual(expected, provided)) {
    return c.json({ error: 'Unauthorized', message: 'Invalid API key' }, 401)
  }

  return next()
}

function extractApiKey(c: Context): string | undefined {
  // 1. Authorization: Bearer <key> (OpenAI convention)
  const authHeader = c.req.header('authorization')
  if (authHeader) {
    const match = /^Bearer (\S+)$/i.exec(authHeader)
    if (match) {
      return match[1]
    }
  }

  // 2. x-api-key: <key> (Anthropic / Claude Code convention)
  const xApiKey = c.req.header('x-api-key')
  if (xApiKey) {
    return xApiKey
  }

  return undefined
}

/**
 * Constant-time string comparison using crypto.timingSafeEqual.
 * Both strings are encoded to UTF-8 buffers; if lengths differ the
 * comparison still runs against a dummy buffer to avoid leaking length info.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')

  if (bufA.length !== bufB.length) {
    // Compare against self to burn the same CPU time, then return false
    timingSafeEqual(bufA, bufA)
    return false
  }

  return timingSafeEqual(bufA, bufB)
}
