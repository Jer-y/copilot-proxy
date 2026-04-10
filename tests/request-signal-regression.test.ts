import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

const fetchMock = mock(async (url: string, init?: RequestInit): Promise<Response> => {
  if (init?.signal) {
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
  fetchMock.mockClear()
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('route request-signal regression', () => {
  test('chat completions do not forward the inbound request signal upstream', async () => {
    const response = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
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
  })

  test('responses do not forward the inbound request signal upstream', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  })

  test('messages do not forward the inbound request signal upstream', async () => {
    const response = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  })

  test('embeddings do not forward the inbound request signal upstream', async () => {
    const response = await server.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  })
})
