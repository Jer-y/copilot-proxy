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

export async function forwardError(c: Context, error: unknown) {
  consola.error('Error occurred:', error)

  if (error instanceof HTTPError) {
    const status = error.response.status as ContentfulStatusCode
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
