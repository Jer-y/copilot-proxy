import { HTTPError } from '~/lib/error'

const SAFE_ERROR_RESPONSE_HEADERS = [
  'retry-after',
  'x-request-id',
] as const

export async function readValidatedJsonResponse<T>(
  response: Response,
  description: string,
  isValid: (value: unknown) => value is T,
  options?: { preserveErrorEnvelope?: boolean },
): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!isJsonContentType(contentType)) {
    await response.body?.cancel('invalid upstream content type').catch(() => {})
    throwInvalidUpstreamResponse(
      `${description}: expected an application/json response, received ${contentType || 'no Content-Type'}`,
      response.headers,
    )
  }

  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text) as unknown
  }
  catch {
    throwInvalidUpstreamResponse(
      `${description}: upstream returned malformed JSON`,
      response.headers,
    )
  }

  if (!isValid(json)) {
    if (options?.preserveErrorEnvelope && isErrorEnvelope(json)) {
      throw new HTTPError(description, new Response(JSON.stringify(json), {
        status: 502,
        headers: copySafeErrorHeaders(response.headers),
      }))
    }
    throwInvalidUpstreamResponse(
      `${description}: upstream returned an invalid success payload`,
      response.headers,
    )
  }

  return json
}

export async function assertEventStreamResponse(
  response: Response,
  description: string,
  options?: { preserveJsonErrorEnvelope?: boolean },
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.toLowerCase().split(';', 1)[0]?.trim() === 'text/event-stream') {
    return
  }

  if (options?.preserveJsonErrorEnvelope && isJsonContentType(contentType)) {
    const text = await response.text()
    try {
      const json = JSON.parse(text) as unknown
      if (isErrorEnvelope(json)) {
        throw new HTTPError(description, new Response(text, {
          status: 502,
          headers: copySafeErrorHeaders(response.headers),
        }))
      }
    }
    catch (error) {
      if (error instanceof HTTPError)
        throw error
    }
  }

  await response.body?.cancel('invalid upstream content type').catch(() => {})
  throwInvalidUpstreamResponse(
    `${description}: expected a text/event-stream response, received ${contentType || 'no Content-Type'}`,
    response.headers,
  )
}

function isErrorEnvelope(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && (
      ('error' in value && (value as { error?: unknown }).error != null)
      || typeof (value as { message?: unknown }).message === 'string'
    ),
  )
}

function copySafeErrorHeaders(headers: Headers): Headers {
  const copied = new Headers({ 'Content-Type': 'application/json' })
  for (const name of SAFE_ERROR_RESPONSE_HEADERS) {
    const value = headers.get(name)
    if (value)
      copied.set(name, value)
  }
  return copied
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

function throwInvalidUpstreamResponse(message: string, upstreamHeaders: Headers): never {
  const headers = copySafeErrorHeaders(upstreamHeaders)

  throw new HTTPError(message, new Response(JSON.stringify({
    error: {
      message,
      type: 'api_error',
      code: 'invalid_upstream_response',
    },
  }), {
    status: 502,
    headers,
  }))
}
