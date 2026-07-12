import type { Model } from '~/services/copilot/get-models'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

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

function validAnthropicResponse(model: string): Response {
  return jsonResponse({
    id: 'msg_valid',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  })
}

function validResponsesResponse(model: string): Response {
  return jsonResponse({
    id: 'resp_valid',
    object: 'response',
    model,
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
    }],
    status: 'completed',
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
  state.models = undefined
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
      { 'retry-after': '9', 'x-request-id': 'responses-request-id' },
    )

    const response = await post('/v1/responses', {
      model: 'gpt-5.4',
      input: 'hi',
    })

    expect(response.headers.get('retry-after')).toBe('9')
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
      { 'retry-after': '4', 'x-request-id': 'messages-request-id' },
    )

    const response = await post('/v1/messages', {
      model: 'claude-opus-4.8',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.status).toBe(502)
    expect(response.headers.get('retry-after')).toBe('4')
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

  test('Responses-to-Anthropic translation turns a 200 error envelope into 502', async () => {
    responseFactory = () => jsonResponse({ type: 'error', error: { message: 'native messages failed' } })

    const response = await post('/v1/responses', {
      model: 'claude-opus-4.6',
      store: false,
      input: 'hi',
    })

    await expectOpenAIInvalidUpstreamResponse(response)
  })

  test('Anthropic-to-Responses translation turns a 200 error envelope into Anthropic 502', async () => {
    responseFactory = () => jsonResponse({ error: { message: 'responses failed' } })

    const response = await post('/v1/messages', {
      model: 'gpt-5.4',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      type: 'error',
      error: {
        type: 'api_error',
        message: expect.stringContaining('Invalid Copilot /responses response'),
      },
    })
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

describe('Responses translation route safeguards', () => {
  test('requires explicit store:false before routing Responses through Anthropic', async () => {
    const response = await post('/v1/responses', {
      model: 'claude-opus-4.6',
      input: 'hi',
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({
      error: {
        message: expect.stringContaining('store=false'),
        type: 'invalid_request_error',
      },
    })
  })

  test('preserves mid-conversation instructions and enables the required Anthropic beta', async () => {
    let upstreamBody: Record<string, unknown> | undefined
    let upstreamHeaders: Headers | undefined
    responseFactory = (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      upstreamHeaders = new Headers(init?.headers)
      return validAnthropicResponse('claude-opus-4.8')
    }

    const response = await post('/v1/responses', {
      model: 'claude-opus-4.6',
      store: false,
      input: [
        { role: 'user', content: 'first' },
        { role: 'developer', content: 'updated policy' },
        { role: 'assistant', content: 'acknowledged' },
        { role: 'user', content: 'continue' },
      ],
    })

    expect(response.status).toBe(200)
    expect(upstreamBody?.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'system', content: 'updated policy' },
      { role: 'assistant', content: [{ type: 'text', text: 'acknowledged' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ])
    expect(upstreamHeaders?.get('anthropic-beta')).toContain('mid-conversation-system-2026-04-07')
  })

  test('rejects an upstream-invalid system/developer position before calling Copilot', async () => {
    const response = await post('/v1/responses', {
      model: 'claude-opus-4.6',
      store: false,
      input: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' },
        { role: 'developer', content: 'late policy' },
      ],
    })

    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await response.json()).toMatchObject({
      error: {
        message: expect.stringContaining('immediately after a user/tool-result turn'),
        type: 'invalid_request_error',
      },
    })
  })

  test('uses live model reasoning_effort metadata for Anthropic to Responses translation', async () => {
    let upstreamBody: Record<string, unknown> | undefined
    state.models = {
      object: 'list',
      data: [makeModel('gpt-5-mini')],
    }
    responseFactory = (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return validResponsesResponse('gpt-5-mini')
    }

    const response = await post('/v1/messages', {
      model: 'gpt-5-mini',
      max_tokens: 32,
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.status).toBe(200)
    expect(upstreamBody?.reasoning).toEqual({ effort: 'high' })
  })

  test('uses live tool capabilities for an unknown Responses model instead of dropping controls', async () => {
    let upstreamBody: Record<string, unknown> | undefined
    state.models = {
      object: 'list',
      data: [makeModel('mai-code-1-flash-picker')],
    }
    responseFactory = (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return validResponsesResponse('mai-code-1-flash-picker')
    }

    const response = await post('/v1/messages', {
      model: 'mai-code-1-flash-picker',
      max_tokens: 32,
      tools: [{ name: 'noop', input_schema: { type: 'object', properties: {} } }],
      tool_choice: {
        type: 'tool',
        name: 'noop',
        disable_parallel_tool_use: true,
      },
      messages: [{ role: 'user', content: 'Call noop.' }],
    })

    expect(response.status).toBe(200)
    expect(upstreamBody?.tool_choice).toEqual({ type: 'function', name: 'noop' })
    expect(upstreamBody?.parallel_tool_calls).toBe(false)
  })
})

function makeModel(id: string): Model {
  return {
    id,
    capabilities: {
      family: 'gpt-5-mini',
      limits: { max_context_window_tokens: 264_000, max_output_tokens: 64_000 },
      object: 'model_capabilities',
      supports: {
        reasoning_effort: ['low', 'medium', 'high'],
        tool_calls: true,
        parallel_tool_calls: true,
      },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    supported_endpoints: ['/chat/completions', '/responses', 'ws:/responses'],
    vendor: 'github-copilot',
    version: '1',
  }
}
