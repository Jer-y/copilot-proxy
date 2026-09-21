import type { Model } from '~/services/copilot/get-models'
import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'

import { server } from '../src/server'
import { createTestModelCatalog } from './model-fixtures'

state.defaultAccount.copilotToken = 'test-token'
state.defaultAccount.vsCodeVersion = '1.0.0'
state.defaultAccount.accountType = 'individual'

const fetchMock = mock(async (url: string) => {
  if (url.endsWith('/v1/messages')) {
    return new Response(JSON.stringify({
      id: 'msg_fallback',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.6',
      content: [{ type: 'text', text: 'fallback ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (url.endsWith('/chat/completions')) {
    return new Response(JSON.stringify({
      error: {
        message: 'unsupported_api_for_model',
        type: 'invalid_request_error',
        code: 'unsupported_api_for_model',
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({
    id: 'resp_fallback',
    object: 'response',
    model: 'gpt-next',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'fallback ok' }] }],
    status: 'completed',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockClear()
  state.lastRequestTimestamp = undefined
  state.defaultAccount.models = createTestModelCatalog()
})

describe('native protocol routing', () => {
  test.each([false, true])('rejects both retired directions without contacting Copilot (stream=%s)', async (stream) => {
    for (const minimalCatalog of [false, true]) {
      state.defaultAccount.models = minimalCatalog
        ? {
            object: 'list',
            data: [
              makeModel('claude-opus-4.8', ['/v1/messages']),
              makeModel('gpt-5.4', ['/responses']),
            ],
          }
        : createTestModelCatalog()

      for (const [path, payload] of [
        ['/v1/responses', { model: 'claude-opus-4.8', input: 'hello', store: false, stream }],
        ['/v1/messages', { model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream }],
      ] as const) {
        fetchMock.mockClear()
        const response = await server.request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })

        expect(response.status).toBe(400)
        expect(response.headers.get('content-type')).toContain('application/json')
        const body = await response.json() as { type?: string, error: { type: string, message: string } }
        expect(body.error.type).toBe('invalid_request_error')
        expect(body.error.message).toContain('cross-protocol translation is not supported')
        if (path === '/v1/messages')
          expect(body.type).toBe('error')
        expect(fetchMock).not.toHaveBeenCalled()
      }
    }
  })

  test('uses advertised native endpoints rather than model brand', async () => {
    state.defaultAccount.models = {
      object: 'list',
      data: [makeModel('claude-native-responses', ['/responses']), makeModel('gpt-native-messages', ['/v1/messages'])],
    }

    for (const [path, payload, upstream] of [
      ['/v1/responses', { model: 'claude-native-responses', input: 'hello' }, '/responses'],
      ['/v1/messages', { model: 'gpt-native-messages', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64 }, '/v1/messages'],
    ] as const) {
      fetchMock.mockClear()
      const response = await server.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      expect(response.status).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.githubcopilot.com${upstream}`)
    }
  })

  test('/v1/responses rejects unknown models with 4xx (no auto-translation to chat-completions)', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-next',
        input: 'hello',
      }),
    })

    // Unknown models default to chat-completions-only; the proxy refuses to
    // translate Responses requests into a chat-completions backend.
    expect(response.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('/v1/responses routes future models from live supported_endpoints', async () => {
    state.defaultAccount.models = {
      object: 'list',
      data: [
        makeModel('gpt-next', ['/responses']),
      ],
    }

    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-next',
        input: 'hello',
      }),
    })

    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.githubcopilot.com/responses')
  })

  test('/v1/responses accepts typed input items when routing directly to responses', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: [
          {
            type: 'reasoning',
            encrypted_content: 'opaque-reasoning-state',
          },
        ],
      }),
    })

    expect(response.status).toBe(200)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/responses',
    ])
  })

  test('/v1/responses surfaces unsupported_api_for_model errors verbatim (no chat-completions fallback)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.endsWith('/responses')) {
        throw new Error(`Unexpected URL ${url}`)
      }
      return new Response(JSON.stringify({
        error: {
          message: 'unsupported_api_for_model',
          type: 'invalid_request_error',
          code: 'unsupported_api_for_model',
        },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    })

    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.1',
        input: 'hello',
      }),
    })

    expect(response.status).toBe(400)
    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/responses',
    ])
  })
})

function makeModel(id: string, supported_endpoints: string[]): Model {
  return {
    id,
    supported_endpoints,
    capabilities: {
      family: 'test',
      limits: {},
      object: 'model_capabilities',
      supports: {},
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'test',
    version: '1',
  }
}
