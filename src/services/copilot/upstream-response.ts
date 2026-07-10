import { HTTPError } from '~/lib/error'

const SAFE_ERROR_RESPONSE_HEADERS = [
  'retry-after',
  'x-request-id',
] as const

export async function readValidatedJsonResponse<T>(
  response: Response,
  description: string,
  isValid: (value: unknown) => value is T,
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
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.toLowerCase().split(';', 1)[0]?.trim() === 'text/event-stream') {
    return
  }

  await response.body?.cancel('invalid upstream content type').catch(() => {})
  throwInvalidUpstreamResponse(
    `${description}: expected a text/event-stream response, received ${contentType || 'no Content-Type'}`,
    response.headers,
  )
}

function isJsonContentType(contentType: string): boolean {
  const mediaType = contentType.toLowerCase().split(';', 1)[0]?.trim() ?? ''
  return mediaType === 'application/json' || mediaType.endsWith('+json')
}

function throwInvalidUpstreamResponse(message: string, upstreamHeaders: Headers): never {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  for (const name of SAFE_ERROR_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name)
    if (value) {
      headers.set(name, value)
    }
  }

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
