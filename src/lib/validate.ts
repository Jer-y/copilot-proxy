import type { Context } from 'hono'
import type { z } from 'zod'

import { HTTPError } from './error'

/**
 * Parse and validate the JSON body against a Zod schema.
 * Returns the validated data cast to the expected type T.
 *
 * The Zod schema provides runtime structural validation (required fields,
 * types, etc.) while the generic parameter T provides compile-time type
 * safety matching the existing hand-written interfaces.
 *
 * Throws HTTPError(400) with a clear message on failure.
 */
export async function validateBody<T>(c: Context, schema: z.ZodType): Promise<T> {
  let raw: unknown
  try {
    raw = await c.req.json()
  }
  catch {
    throw new HTTPError(
      'Invalid JSON body',
      Response.json(
        { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
        { status: 400 },
      ),
    )
  }

  const result = schema.safeParse(raw)
  if (!result.success) {
    const message = result.error.issues
      .map(i => `${i.path.join('.')}: ${i.message}`)
      .join('; ')
    throw new HTTPError(
      `Request validation failed: ${message}`,
      Response.json(
        { error: { message: `Request validation failed: ${message}`, type: 'invalid_request_error' } },
        { status: 400 },
      ),
    )
  }

  return result.data as T
}
