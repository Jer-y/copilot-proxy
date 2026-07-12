import type { Context } from 'hono'
import type { z } from 'zod'

import process from 'node:process'

import { setApprovalRequestModel } from './approval'
import { HTTPError } from './error'

export const JSON_BODY_SIZE_LIMIT_ENV = 'COPILOT_PROXY_MAX_JSON_BODY_BYTES'
export const DEFAULT_MAX_JSON_BODY_BYTES = 32 * 1024 * 1024
export const JSON_BODY_READ_INACTIVITY_TIMEOUT_MS = 30_000
const MAX_VALIDATION_ISSUES = 10
const MAX_VALIDATION_MESSAGE_CHARS = 4_096

export interface JsonBodyReader {
  read: () => Promise<
    | { done: true, value?: undefined }
    | { done: false, value: Uint8Array }
  >
  cancel: (reason?: unknown) => Promise<void>
}

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
  const text = await readJsonBodyText(c)

  let raw: unknown
  try {
    raw = JSON.parse(text)
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
    const message = formatValidationIssues(result.error.issues)
    throw new HTTPError(
      `Request validation failed: ${message}`,
      Response.json(
        { error: { message: `Request validation failed: ${message}`, type: 'invalid_request_error' } },
        { status: 400 },
      ),
    )
  }

  if (typeof result.data === 'object' && result.data !== null && 'model' in result.data)
    setApprovalRequestModel(result.data.model)

  return result.data as T
}

function formatValidationIssues(issues: z.core.$ZodIssue[]): string {
  const shown = issues.slice(0, MAX_VALIDATION_ISSUES)
    .map((issue) => {
      const path = issue.path.join('.')
      return `${path ? `${path}: ` : ''}${issue.message}`
    })
    .join('; ')
  const omitted = issues.length - Math.min(issues.length, MAX_VALIDATION_ISSUES)
  const suffix = omitted > 0 ? `; ... ${omitted} additional validation issue(s) omitted` : ''
  return `${shown}${suffix}`.slice(0, MAX_VALIDATION_MESSAGE_CHARS)
}

export async function readJsonBodyText(c: Context): Promise<string> {
  requireJsonContentType(c)

  const maxBytes = getMaxJsonBodyBytes()
  const declaredBytes = parseContentLength(c.req.header('content-length'))
  if (declaredBytes !== undefined && declaredBytes > maxBytes) {
    throwJsonBodyTooLarge(maxBytes, declaredBytes)
  }

  const body = c.req.raw.body
  if (!body)
    return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let bodyBytes = 0

  try {
    while (true) {
      const { done, value } = await readRequestBodyChunk(reader)
      if (done)
        break

      bodyBytes += value.byteLength
      if (bodyBytes > maxBytes) {
        try {
          await reader.cancel()
        }
        catch {
          // The request is already being rejected; ignore stream-cancel cleanup errors.
        }
        throwJsonBodyTooLarge(maxBytes, bodyBytes)
      }

      chunks.push(value)
    }
  }
  finally {
    reader.releaseLock()
  }

  return decodeUtf8Chunks(chunks, bodyBytes)
}

export async function readRequestBodyChunk(
  reader: JsonBodyReader,
  inactivityTimeoutMs: number = JSON_BODY_READ_INACTIVITY_TIMEOUT_MS,
): Promise<
  | { done: true, value?: undefined }
  | { done: false, value: Uint8Array }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const message = `JSON request body timed out after ${inactivityTimeoutMs}ms of inactivity`
          void reader.cancel(message).catch(() => {})
          reject(new HTTPError(
            message,
            Response.json({
              error: {
                message,
                type: 'invalid_request_error',
                code: 'request_timeout',
              },
            }, { status: 408 }),
          ))
        }, inactivityTimeoutMs)
        timeout.unref?.()
      }),
    ])
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
  }
}

function requireJsonContentType(c: Context): void {
  if (!c.req.raw.body)
    return

  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType === 'application/json' || (contentType?.startsWith('application/') && contentType.endsWith('+json')))
    return

  const message = 'Content-Type must be application/json for requests with a JSON body'
  throw new HTTPError(
    message,
    Response.json(
      {
        error: {
          message,
          type: 'invalid_request_error',
          code: 'unsupported_content_type',
        },
      },
      { status: 415 },
    ),
  )
}

function getMaxJsonBodyBytes(): number {
  const configured = process.env[JSON_BODY_SIZE_LIMIT_ENV]?.trim()
  if (!configured)
    return DEFAULT_MAX_JSON_BODY_BYTES

  const parsed = Number(configured)
  if (Number.isSafeInteger(parsed) && parsed > 0)
    return parsed

  return DEFAULT_MAX_JSON_BODY_BYTES
}

function parseContentLength(value: string | undefined): number | undefined {
  const trimmed = value?.trim()
  if (!trimmed)
    return undefined
  if (!/^\d+$/.test(trimmed))
    return undefined

  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function decodeUtf8Chunks(chunks: Uint8Array[], totalBytes: number): string {
  if (chunks.length === 1)
    return new TextDecoder().decode(chunks[0])

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(bytes)
}

function throwJsonBodyTooLarge(maxBytes: number, bodyBytes: number): never {
  const message = `JSON request body is too large. body_bytes=${bodyBytes} max_body_bytes=${maxBytes}`
  throw new HTTPError(
    message,
    Response.json(
      {
        error: {
          message,
          type: 'invalid_request_error',
          code: 'payload_too_large',
        },
      },
      { status: 413 },
    ),
  )
}
