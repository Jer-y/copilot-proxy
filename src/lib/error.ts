import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import consola from 'consola'

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
  }
}

export class JSONResponseError extends Error {
  status: ContentfulStatusCode
  payload: unknown

  constructor(message: string, status: ContentfulStatusCode, payload: unknown) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

/**
 * Forward errors in OpenAI-compatible format.
 * Used by /v1/chat/completions and /v1/responses endpoints.
 */
export async function forwardError(c: Context, error: unknown) {
  consola.error('Error occurred:', error)

  if (error instanceof JSONResponseError) {
    return c.json(error.payload as never, error.status)
  }

  if (error instanceof HTTPError) {
    const status = error.response.status as ContentfulStatusCode

    // Forward useful upstream headers
    const retryAfter = error.response.headers.get('retry-after')
    if (retryAfter)
      c.header('retry-after', retryAfter)
    const requestId = error.response.headers.get('x-request-id')
    if (requestId)
      c.header('x-request-id', requestId)

    const errorText = await error.response.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
      consola.error('HTTP error:', errorJson)
      return c.json(errorJson as never, status)
    }
    catch {
      consola.error('HTTP error:', errorText)
      return c.body(errorText, status)
    }
  }

  return c.json(
    {
      error: {
        message: error instanceof Error ? error.message : String(error),
        type: 'error',
      },
    },
    500,
  )
}

/**
 * Forward errors in Anthropic-compatible format.
 * Used by /v1/messages endpoint.
 *
 * Anthropic format: { "type": "error", "error": { "type": "...", "message": "..." } }
 */
export async function forwardErrorAnthropic(c: Context, error: unknown) {
  consola.error('Error occurred:', error)

  if (error instanceof JSONResponseError) {
    return c.json(error.payload as never, error.status)
  }

  if (error instanceof HTTPError) {
    const status = error.response.status as ContentfulStatusCode

    // Forward useful upstream headers
    const retryAfter = error.response.headers.get('retry-after')
    if (retryAfter)
      c.header('retry-after', retryAfter)
    const requestId = error.response.headers.get('x-request-id')
    if (requestId)
      c.header('x-request-id', requestId)

    const errorText = await error.response.text()

    // Try to parse upstream error and re-wrap in Anthropic format
    try {
      const errorJson = JSON.parse(errorText) as Record<string, unknown>
      consola.error('HTTP error:', errorJson)

      // Check if it's already in Anthropic format
      if (errorJson.type === 'error' && errorJson.error) {
        return c.json(errorJson as never, status)
      }

      // Translate OpenAI/GitHub error format → Anthropic format
      const upstreamError = errorJson.error as Record<string, unknown> | undefined
      const message = upstreamError?.message ?? errorText
      const errorType = mapHttpStatusToAnthropicErrorType(status)

      return c.json(
        {
          type: 'error',
          error: {
            type: errorType,
            message: typeof message === 'string' ? message : JSON.stringify(message),
          },
        },
        status,
      )
    }
    catch {
      consola.error('HTTP error:', errorText)
      return c.json(
        {
          type: 'error',
          error: {
            type: mapHttpStatusToAnthropicErrorType(status),
            message: errorText,
          },
        },
        status,
      )
    }
  }

  return c.json(
    {
      type: 'error',
      error: {
        type: 'api_error',
        message: error instanceof Error ? error.message : String(error),
      },
    },
    500,
  )
}

function mapHttpStatusToAnthropicErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error'
    case 401: return 'authentication_error'
    case 403: return 'permission_error'
    case 404: return 'not_found_error'
    case 429: return 'rate_limit_error'
    case 529: return 'overloaded_error'
    default: return status >= 500 ? 'api_error' : 'invalid_request_error'
  }
}
