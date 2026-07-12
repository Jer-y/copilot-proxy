import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const upstreamRequests: Array<{
  signal: AbortSignal | undefined
  url: string
}> = []

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

const fetchMock = mock(async (url: string, init?: RequestInit): Promise<Response> => {
  upstreamRequests.push({
    signal: init?.signal ?? undefined,
    url,
  })

  if (init?.signal?.aborted) {
    throw createAbortError()
  }

  if (url.endsWith('/chat/completions')) {
    return new Response(JSON.stringify({
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-5.4',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'ok',
        },
        logprobs: null,
        finish_reason: 'stop',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (url.endsWith('/responses')) {
    return new Response(JSON.stringify({
      id: 'resp_test',
      object: 'response',
      model: 'gpt-5.4',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }],
      }],
      status: 'completed',
      error: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (url.endsWith('/v1/messages')) {
    return new Response(JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 8,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (url.endsWith('/v1/messages/count_tokens')) {
    return new Response(JSON.stringify({ input_tokens: 8 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (
    url.endsWith('/responses/input_tokens')
    || url.endsWith('/responses/compact')
    || url.includes('/responses/')
  ) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (url.endsWith('/embeddings')) {
    return new Response(JSON.stringify({
      object: 'list',
      data: [{
        object: 'embedding',
        embedding: [0.1, 0.2],
        index: 0,
      }],
      model: 'text-embedding-3-small',
      usage: {
        prompt_tokens: 2,
        total_tokens: 2,
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  throw new Error(`Unexpected upstream URL: ${url}`)
})

beforeEach(() => {
  upstreamRequests.length = 0
  fetchMock.mockClear()
  state.lastRequestTimestamp = undefined
  state.models = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function expectSingleUpstreamRequestIsolatedFromInboundAbort(
  pathSuffix: string,
  inboundController: AbortController,
): void {
  expect(upstreamRequests).toHaveLength(1)
  expect(upstreamRequests[0]?.url.endsWith(pathSuffix)).toBe(true)
  inboundController.abort('client disconnected after upstream request started')
  expect(upstreamRequests[0]?.signal).not.toBe(inboundController.signal)
  expect(upstreamRequests[0]?.signal?.aborted ?? false).toBe(false)
}

describe('route request-signal regression', () => {
  test('chat completions do not forward the inbound request signal upstream', async () => {
    const inboundController = new AbortController()
    const response = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: inboundController.signal,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as {
      choices: Array<{
        message: {
          content: string
        }
      }>
    }
    expect(json.choices[0]?.message.content).toBe('ok')
    expectSingleUpstreamRequestIsolatedFromInboundAbort('/chat/completions', inboundController)
  })

  test('direct responses do not forward the inbound request signal upstream', async () => {
    const inboundController = new AbortController()
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: inboundController.signal,
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: 'hi',
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as {
      output: Array<{
        content: Array<{
          text: string
        }>
      }>
    }
    expect(json.output[0]?.content[0]?.text).toBe('ok')
    expectSingleUpstreamRequestIsolatedFromInboundAbort('/responses', inboundController)
  })

  test('responses translated through messages do not forward the inbound request signal upstream', async () => {
    const inboundController = new AbortController()
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: inboundController.signal,
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        input: 'hi',
        store: false,
      }),
    })

    expect(response.status).toBe(200)
    expectSingleUpstreamRequestIsolatedFromInboundAbort('/v1/messages', inboundController)
  })

  test('native messages do not forward the inbound request signal upstream', async () => {
    const inboundController = new AbortController()
    const response = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: inboundController.signal,
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as {
      content: Array<{
        text: string
      }>
    }
    expect(json.content[0]?.text).toBe('ok')
    expectSingleUpstreamRequestIsolatedFromInboundAbort('/v1/messages', inboundController)
  })

  test('messages translated through responses do not forward the inbound request signal upstream', async () => {
    const inboundController = new AbortController()
    const response = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: inboundController.signal,
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(200)
    expectSingleUpstreamRequestIsolatedFromInboundAbort('/responses', inboundController)
  })

  test('embeddings do not forward the inbound request signal upstream', async () => {
    const inboundController = new AbortController()
    const response = await server.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: inboundController.signal,
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: 'hi',
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as {
      data: Array<{
        embedding: number[]
      }>
    }
    expect(json.data[0]?.embedding).toEqual([0.1, 0.2])
    expectSingleUpstreamRequestIsolatedFromInboundAbort('/embeddings', inboundController)
  })

  test('count_tokens does not forward the inbound request signal upstream', async () => {
    const inboundController = new AbortController()
    const response = await server.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: inboundController.signal,
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ input_tokens: 8 })
    expectSingleUpstreamRequestIsolatedFromInboundAbort('/v1/messages/count_tokens', inboundController)
  })

  test('Responses input_tokens passthrough does not forward the inbound request signal upstream', async () => {
    await expectResponsesPassthroughIsolatedFromInboundAbort(
      '/v1/responses/input_tokens',
      '/responses/input_tokens',
      'POST',
      { model: 'gpt-5.4', input: 'hi' },
    )
  })

  test('Responses compact passthrough does not forward the inbound request signal upstream', async () => {
    await expectResponsesPassthroughIsolatedFromInboundAbort(
      '/v1/responses/compact',
      '/responses/compact',
      'POST',
      { model: 'gpt-5.4', input: 'hi' },
    )
  })

  test('Responses cancel passthrough does not forward the inbound request signal upstream', async () => {
    await expectResponsesPassthroughIsolatedFromInboundAbort(
      '/v1/responses/resp_signal/cancel',
      '/responses/resp_signal/cancel',
      'POST',
    )
  })

  test('Responses input_items passthrough does not forward the inbound request signal upstream', async () => {
    await expectResponsesPassthroughIsolatedFromInboundAbort(
      '/v1/responses/resp_signal/input_items',
      '/responses/resp_signal/input_items',
      'GET',
    )
  })

  test('Responses retrieval passthrough does not forward the inbound request signal upstream', async () => {
    await expectResponsesPassthroughIsolatedFromInboundAbort(
      '/v1/responses/resp_signal',
      '/responses/resp_signal',
      'GET',
    )
  })

  test('Responses deletion passthrough does not forward the inbound request signal upstream', async () => {
    await expectResponsesPassthroughIsolatedFromInboundAbort(
      '/v1/responses/resp_signal',
      '/responses/resp_signal',
      'DELETE',
    )
  })
})

async function expectResponsesPassthroughIsolatedFromInboundAbort(
  localPath: string,
  upstreamPath: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<void> {
  const inboundController = new AbortController()
  const response = await server.request(localPath, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    signal: inboundController.signal,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expectSingleUpstreamRequestIsolatedFromInboundAbort(upstreamPath, inboundController)
}
