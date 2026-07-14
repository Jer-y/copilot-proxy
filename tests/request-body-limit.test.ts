import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { JSON_BODY_SIZE_LIMIT_ENV, readRequestBodyChunk } from '~/lib/validate'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const originalBodyLimit = process.env[JSON_BODY_SIZE_LIMIT_ENV]
const encoder = new TextEncoder()

const fetchMock = mock(async (): Promise<Response> => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

type StreamingRequestInit = RequestInit & { duplex: 'half' }

function restoreBodyLimitEnv() {
  if (originalBodyLimit === undefined) {
    delete process.env[JSON_BODY_SIZE_LIMIT_ENV]
    return
  }

  process.env[JSON_BODY_SIZE_LIMIT_ENV] = originalBodyLimit
}

beforeEach(() => {
  process.env[JSON_BODY_SIZE_LIMIT_ENV] = '192'
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  state.models = undefined
  fetchMock.mockClear()
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  restoreBodyLimitEnv()
  globalThis.fetch = originalFetch
})

async function expectOpenAiPayloadTooLarge(path: string): Promise<void> {
  const response = await server.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '9999',
    },
    body: '{}',
  })

  expect(response.status).toBe(413)

  const json = await response.json() as {
    error: {
      message: string
      type: string
      code: string
    }
  }

  expect(json.error.type).toBe('invalid_request_error')
  expect(json.error.code).toBe('payload_too_large')
  expect(json.error.message).toContain('body_bytes=9999')
  expect(json.error.message).toContain('max_body_bytes=192')
}

async function expectAnthropicPayloadTooLarge(path: string): Promise<void> {
  const response = await server.request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': '9999',
    },
    body: '{}',
  })

  expect(response.status).toBe(413)

  const json = await response.json() as {
    type: string
    error: {
      type: string
      message: string
    }
  }

  expect(json.type).toBe('error')
  expect(json.error.type).toBe('request_too_large')
  expect(json.error.message).toContain('body_bytes=9999')
  expect(json.error.message).toContain('max_body_bytes=192')
}

async function requestWithStreamingBody(path: string, body: string): Promise<Response> {
  const bytes = encoder.encode(body)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 128))
      controller.enqueue(bytes.slice(128))
      controller.close()
    },
  })
  const request = new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as StreamingRequestInit)

  expect(request.headers.get('content-length')).toBeNull()

  return await server.fetch(request)
}

test('OpenAI-compatible JSON routes reject oversized Content-Length before parsing', async () => {
  await expectOpenAiPayloadTooLarge('/v1/chat/completions')
  await expectOpenAiPayloadTooLarge('/v1/responses')
  await expectOpenAiPayloadTooLarge('/v1/embeddings')

  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test('Anthropic-compatible JSON routes return Anthropic 413 errors for oversized bodies', async () => {
  await expectAnthropicPayloadTooLarge('/v1/messages')
  await expectAnthropicPayloadTooLarge('/v1/messages/count_tokens')

  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test('streaming JSON bodies without Content-Length are size limited before upstream fetch', async () => {
  const response = await requestWithStreamingBody('/v1/responses', JSON.stringify({
    model: 'test-responses-model',
    input: 'x'.repeat(256),
  }))

  expect(response.status).toBe(413)
  const json = await response.json() as { error: { message: string, code: string } }
  expect(json.error.code).toBe('payload_too_large')
  expect(json.error.message).toContain('max_body_bytes=192')
  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test('Responses passthrough subroutes size limit streaming bodies before forwarding', async () => {
  const response = await requestWithStreamingBody('/v1/responses/input_tokens', JSON.stringify({
    model: 'test-responses-model',
    input: 'x'.repeat(256),
  }))

  expect(response.status).toBe(413)
  const json = await response.json() as { error: { message: string, code: string } }
  expect(json.error.code).toBe('payload_too_large')
  expect(json.error.message).toContain('max_body_bytes=192')
  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test('validation errors cap issue details instead of amplifying large arrays', async () => {
  process.env[JSON_BODY_SIZE_LIMIT_ENV] = String(1024 * 1024)
  const requestBody = JSON.stringify({
    model: 'gpt-5',
    messages: Array.from({ length: 2_000 }, () => ({})),
  })

  const response = await server.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
  })

  const responseBody = await response.text()
  expect(response.status).toBe(400)
  expect(responseBody.length).toBeLessThan(8_192)
  expect(responseBody).toContain('additional validation issue(s) omitted')
  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test('request body reads time out after a period of inactivity and cancel the reader', async () => {
  const cancel = mock(async (_reason?: unknown): Promise<void> => {})
  const reader = {
    read: async () => await new Promise<never>(() => {}),
    cancel,
  }

  const error = await readRequestBodyChunk(reader, 20).catch((error: unknown) => error)
  expect(error).toMatchObject({
    response: expect.objectContaining({ status: 408 }),
  })
  const body = await (error as { json: () => Promise<unknown> }).json() as {
    error: { code: string, message: string, type: string }
  }
  expect(body.error).toMatchObject({
    code: 'request_timeout',
    type: 'invalid_request_error',
  })
  expect(body.error.message).toContain('20ms of inactivity')
  expect(cancel).toHaveBeenCalledTimes(1)
})
