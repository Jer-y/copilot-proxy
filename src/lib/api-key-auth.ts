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
 * - Returns errors in the format matching the target API (OpenAI vs Anthropic).
 *
 * Note: auth failures short-circuit before the handler-level rate limiter.
 * This is intentional — the rate limiter protects upstream Copilot quota,
 * not the auth layer. If brute-force protection is needed in the future,
 * add a separate per-IP throttle here.
 */
export async function apiKeyAuth(c: Context, next: Next): Promise<Response | void> {
  const expected = state.apiKey
  if (!expected) {
    return next()
  }

  const provided = extractApiKey(c)
  if (!provided) {
    return authError(c, 'Missing API key. Provide via Authorization: Bearer <key> or x-api-key: <key>')
  }

  if (!safeEqual(expected, provided)) {
    return authError(c, 'Invalid API key')
  }

  // Strip proxy auth headers so they are never forwarded to upstream services.
  // Downstream handlers use their own Copilot token; keeping these around
  // would leak the proxy key if a future handler naively forwards headers.
  c.req.raw.headers.delete('authorization')
  c.req.raw.headers.delete('x-api-key')

  return next()
}

/**
 * Routes that follow the Anthropic error contract.
 * Keep in sync with the Anthropic-compatible route registrations in server.ts.
 */
const ANTHROPIC_ROUTE_PREFIXES = ['/v1/messages']

/**
 * Return a 401 error in the format matching the target API convention.
 *
 * - Anthropic routes: `{ type: "error", error: { type, message } }`
 * - OpenAI-compatible routes: `{ error: { message, type } }`
 */
function authError(c: Context, message: string): Response {
  const path = c.req.path
  if (ANTHROPIC_ROUTE_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return c.json(
      {
        type: 'error',
        error: {
          type: 'authentication_error',
          message,
        },
      },
      401,
    )
  }

  return c.json(
    {
      error: {
        message,
        type: 'invalid_request_error',
      },
    },
    401,
  )
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
