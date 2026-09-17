import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { state } from '~/lib/state'

import { server } from '~/server'
import { createTestModelCatalog } from './model-fixtures'

const originalFetch = globalThis.fetch
type FetchInput = Parameters<typeof fetch>[0]
type ResponseFactory = (input: FetchInput, init?: RequestInit) => Response | Promise<Response>

let responseFactory: ResponseFactory
const fetchMock = mock(async (input: FetchInput, init?: RequestInit): Promise<Response> => {
  return await responseFactory(input, init)
})

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

async function post(path: string, body: unknown): Promise<Response> {
  return await server.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function expectOpenAIInvalidUpstreamResponse(response: Response): Promise<void> {
  expect(response.status).toBe(502)
  expect(response.headers.get('content-type')).toContain('application/json')
  const body = await response.json() as {
    error: { code?: string, message: string, type: string }
  }
  expect(body.error).toMatchObject({
    code: 'invalid_upstream_response',
    type: 'api_error',
  })
  expect(body.error.message).toContain('Invalid Copilot')
}

beforeEach(() => {
  state.lastRequestTimestamp = undefined
  state.models = createTestModelCatalog()
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  state.manualApprove = false
  state.rateLimitWait = false
  fetchMock.mockClear()
  responseFactory = () => {
    throw new Error('responseFactory must be configured by the test')
  }
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('HTTP 200 upstream response validation', () => {
  test('Responses error envelopes become 502 and retain safe upstream headers', async () => {
    responseFactory = () => jsonResponse(
      { error: { message: 'upstream failed despite HTTP 200' } },
      {
        'retry-after': '9',
        'x-copilot-service-request-id': 'responses-service-request-id',
        'x-github-request-id': 'responses-github-request-id',
        'x-request-id': 'responses-request-id',
      },
    )

    const response = await post('/v1/responses', {
      model: 'gpt-5.4',
      input: 'hi',
    })

    expect(response.headers.get('retry-after')).toBe('9')
    expect(response.headers.get('x-copilot-service-request-id')).toBe('responses-service-request-id')
    expect(response.headers.get('x-github-request-id')).toBe('responses-github-request-id')
    expect(response.headers.get('x-request-id')).toBe('responses-request-id')
    await expectOpenAIInvalidUpstreamResponse(response)
  })

  test('Responses streaming rejects JSON instead of returning an empty SSE success', async () => {
    responseFactory = () => jsonResponse({ error: { message: 'stream setup failed' } })

    const response = await post('/v1/responses', {
      model: 'gpt-5.4',
      input: 'hi',
      stream: true,
    })

    await expectOpenAIInvalidUpstreamResponse(response)
    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
  })

  test('Responses malformed JSON becomes 502 instead of an internal parser error', async () => {
    responseFactory = () => new Response('{not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

    const response = await post('/v1/responses', {
      model: 'gpt-5.4',
      input: 'hi',
    })

    await expectOpenAIInvalidUpstreamResponse(response)
  })

  test('Anthropic error envelopes become Anthropic-shaped 502 responses', async () => {
    responseFactory = () => jsonResponse(
      { type: 'error', error: { type: 'api_error', message: 'fake success' } },
      {
        'retry-after': '4',
        'x-copilot-service-request-id': 'messages-service-request-id',
        'x-github-request-id': 'messages-github-request-id',
        'x-request-id': 'messages-request-id',
      },
    )

    const response = await post('/v1/messages', {
      model: 'claude-opus-4.8',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('retry-after')).toBe('4')
    expect(response.headers.get('x-copilot-service-request-id')).toBe('messages-service-request-id')
    expect(response.headers.get('x-github-request-id')).toBe('messages-github-request-id')
    expect(response.headers.get('x-request-id')).toBe('messages-request-id')
    expect(await response.json()).toMatchObject({
      type: 'error',
      error: {
        type: 'api_error',
        message: expect.stringContaining('Invalid Copilot /v1/messages response'),
      },
    })
  })

  test('Anthropic streaming rejects JSON instead of returning an empty SSE success', async () => {
    responseFactory = () => jsonResponse({ error: { message: 'stream setup failed' } })

    const response = await post('/v1/messages', {
      model: 'claude-opus-4.6',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('content-type')).not.toContain('text/event-stream')
  })

  test('count_tokens turns a 200 error envelope into Anthropic 502', async () => {
    responseFactory = () => jsonResponse({ error: { message: 'count failed' } })

    const response = await post('/v1/messages/count_tokens', {
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      type: 'error',
      error: {
        type: 'api_error',
        message: expect.stringContaining('Invalid Copilot /v1/messages/count_tokens response'),
      },
    })
  })

  test('Embeddings error envelopes become 502', async () => {
    responseFactory = () => jsonResponse({ error: { message: 'embedding failed' } })

    const response = await post('/v1/embeddings', {
      model: 'text-embedding-3-small',
      input: 'hi',
    })

    await expectOpenAIInvalidUpstreamResponse(response)
  })

  test('Embeddings rejects an empty result list for a non-empty request', async () => {
    responseFactory = () => jsonResponse({
      object: 'list',
      data: [],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    })

    const response = await post('/v1/embeddings', {
      model: 'text-embedding-3-small',
      input: 'hi',
    })

    await expectOpenAIInvalidUpstreamResponse(response)
  })

  test('Embeddings forwards safe headers from a validated success response', async () => {
    responseFactory = () => jsonResponse({
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }, {
      'x-ratelimit-remaining-requests': '17',
      'x-request-id': 'embedding-request-id',
    })

    const response = await post('/v1/embeddings', {
      model: 'text-embedding-3-small',
      input: 'hi',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-ratelimit-remaining-requests')).toBe('17')
    expect(response.headers.get('x-request-id')).toBe('embedding-request-id')
    expect(await response.json()).toMatchObject({
      object: 'list',
      model: 'text-embedding-3-small',
      data: [{ object: 'embedding', index: 0 }],
    })
  })

  test('Embeddings rejects a valid-looking body with the wrong Content-Type', async () => {
    responseFactory = () => new Response(JSON.stringify({
      object: 'list',
      data: [],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 0, total_tokens: 0 },
    }), {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })

    const response = await post('/v1/embeddings', {
      model: 'text-embedding-3-small',
      input: 'hi',
    })

    await expectOpenAIInvalidUpstreamResponse(response)
  })
})
