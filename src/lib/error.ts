import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

import consola from 'consola'
import { forwardUpstreamHeaders } from './upstream-headers'

export class HTTPError extends Error {
  response: Response
  private readonly responseTextPromise: Promise<string>

  constructor(message: string, response: Response) {
    super(message)
    this.response = response
    this.responseTextPromise = response.clone().text().catch(() => response.statusText)
  }

  async text(): Promise<string> {
    return this.responseTextPromise
  }

  async json(): Promise<unknown> {
    const text = await this.text()
    return JSON.parse(text)
  }
}

export class UpstreamTimeoutError extends Error {
  status = 504 as const
  timeoutMs: number
  target: string

  constructor(message: string, timeoutMs: number, target: string) {
    super(message)
    this.name = 'UpstreamTimeoutError'
    this.timeoutMs = timeoutMs
    this.target = target
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

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Forward errors in OpenAI-compatible format.
 * Used by /v1/chat/completions and /v1/responses endpoints.
 */
export async function forwardError(c: Context, error: unknown) {
  consola.error('Error occurred:', summarizeErrorForLog(error))

  if (error instanceof JSONResponseError) {
    return c.json(error.payload as never, error.status)
  }

  if (error instanceof HTTPError) {
    const status = error.response.status as ContentfulStatusCode

    forwardUpstreamHeaders(c, error.response.headers)

    const errorText = await error.text()
    let errorJson: unknown
    try {
      errorJson = JSON.parse(errorText)
      const normalizedError = normalizeOpenAIErrorEnvelope(errorJson, status)
      consola.error('HTTP error summary:', {
        status,
        responseChars: errorText.length,
        normalizedErrorEnvelope: normalizedError !== errorJson,
      })
      return c.json(normalizedError as never, status)
    }
    catch {
      consola.error('HTTP error summary:', {
        status,
        responseChars: errorText.length,
        contentType: 'non-json',
      })
      return c.json({
        error: {
          message: errorText || error.message || 'The upstream request failed.',
          type: mapHttpStatusToOpenAIErrorType(status),
        },
      }, status)
    }
  }

  if (error instanceof UpstreamTimeoutError) {
    return c.json(
      {
        error: {
          message: error.message,
          type: 'timeout_error',
          code: 'upstream_timeout',
        },
      },
      error.status,
    )
  }

  if (isAbortError(error)) {
    return c.json(
      {
        error: {
          message: error.message,
          type: 'api_error',
          code: 'upstream_connection_aborted',
        },
      },
      502,
    )
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

function normalizeOpenAIErrorEnvelope(payload: unknown, status: number): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  const envelope = payload as Record<string, unknown>
  if (envelope.error && typeof envelope.error === 'object') {
    const upstreamError = envelope.error as Record<string, unknown>
    const message = typeof upstreamError.message === 'string'
      ? upstreamError.message
      : 'The upstream request failed.'

    if (envelope.type === 'error') {
      return {
        error: {
          message,
          type: typeof upstreamError.type === 'string' ? upstreamError.type : mapHttpStatusToOpenAIErrorType(status),
          ...(typeof upstreamError.code === 'string' && { code: upstreamError.code }),
        },
      }
    }

    return {
      ...envelope,
      error: {
        ...upstreamError,
        message,
        type: typeof upstreamError.type === 'string' ? upstreamError.type : mapHttpStatusToOpenAIErrorType(status),
      },
    }
  }

  if (typeof envelope.message === 'string') {
    return {
      error: {
        message: envelope.message,
        type: mapHttpStatusToOpenAIErrorType(status),
        ...(typeof envelope.code === 'string' && { code: envelope.code }),
      },
    }
  }

  return payload
}

function mapHttpStatusToOpenAIErrorType(status: number): string {
  if (status === 400 || status === 404 || status === 422)
    return 'invalid_request_error'
  if (status === 401)
    return 'authentication_error'
  if (status === 403)
    return 'permission_error'
  if (status === 429)
    return 'rate_limit_error'
  return 'api_error'
}

/**
 * Forward errors in Anthropic-compatible format.
 * Used by /v1/messages endpoint.
 *
 * Anthropic format: { "type": "error", "error": { "type": "...", "message": "..." } }
 */
export async function forwardErrorAnthropic(c: Context, error: unknown) {
  consola.error('Error occurred:', summarizeErrorForLog(error))

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

    const errorText = await error.text()

    // Try to parse upstream error and re-wrap in Anthropic format
    try {
      const errorJson = JSON.parse(errorText) as Record<string, unknown>
      const parsedError = errorJson.error && typeof errorJson.error === 'object'
        ? errorJson.error as Record<string, unknown>
        : undefined
      consola.error('HTTP error summary:', {
        status,
        responseChars: errorText.length,
        errorType: typeof parsedError?.type === 'string' ? parsedError.type : undefined,
      })

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
      consola.error('HTTP error summary:', {
        status,
        responseChars: errorText.length,
        contentType: 'non-json',
      })
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

  if (error instanceof UpstreamTimeoutError) {
    return c.json(
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: error.message,
        },
      },
      error.status,
    )
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

function summarizeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof HTTPError) {
    return {
      name: error.name,
      status: error.response.status,
      messageChars: error.message.length,
    }
  }

  if (error instanceof JSONResponseError) {
    return {
      name: error.name,
      status: error.status,
      messageChars: error.message.length,
    }
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      messageChars: error.message.length,
    }
  }

  return { kind: typeof error }
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
