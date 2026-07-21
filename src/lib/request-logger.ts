import type { MiddlewareHandler } from 'hono'

type RequestLogWriter = (message: string) => void

const LOG_CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}]/u

function formatElapsedTime(elapsedMs: number): string {
  return elapsedMs < 1_000
    ? `${elapsedMs}ms`
    : `${Math.round(elapsedMs / 1_000)}s`
}

function sanitizeLogPath(path: string): string {
  return [...path].map((character) => {
    if (!LOG_CONTROL_CHARACTER_PATTERN.test(character))
      return character
    const codePoint = character.codePointAt(0)!
    return `\\u${codePoint.toString(16).padStart(4, '0')}`
  }).join('')
}

export function requestLogger(
  write: RequestLogWriter,
  now: () => number = Date.now,
): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method
    const path = sanitizeLogPath(c.req.path)

    write(`<-- ${method} ${path}`)
    const startedAt = now()
    await next()
    write(`--> ${method} ${path} ${c.res.status} ${formatElapsedTime(now() - startedAt)}`)
  }
}
