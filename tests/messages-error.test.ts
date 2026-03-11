import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const fetchMock = mock(async (url: string) => {
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

  return new Response(JSON.stringify({
    id: 'chatcmpl_test',
    object: 'chat.completion',
    created: 0,
    model: 'claude-sonnet-4',
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
})

beforeEach(() => {
  fetchMock.mockClear()
  state.lastRequestTimestamp = undefined
  state.copilotToken = undefined
  state.models = undefined
  globalThis.fetch = originalFetch
})

describe('messages error paths', () => {
  test('invalid JSON body returns 400 with invalid_request_error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '<<<not json>>>',
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('missing "model" field returns 400', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('missing "max_tokens" field is accepted by schema for compatibility', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(result.success).toBe(true)
  })

  test('missing "max_tokens" is backfilled from model limits before forwarding', async () => {
    state.copilotToken = 'test-token'
    state.vsCodeVersion = '1.0.0'
    state.accountType = 'individual'
    state.models = {
      data: [{
        id: 'claude-sonnet-4',
        capabilities: {
          limits: {
            max_output_tokens: 8192,
          },
        },
      }],
    } as typeof state.models

    // @ts-expect-error test mock only needs fetch callable shape
    globalThis.fetch = fetchMock

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const forwardedPayload = JSON.parse(String(init?.body)) as { max_tokens?: number }
    expect(forwardedPayload.max_tokens).toBe(8192)
  })

  test('gpt-5.4 anthropic requests without "max_tokens" are backfilled and routed to /responses', async () => {
    state.copilotToken = 'test-token'
    state.vsCodeVersion = '1.0.0'
    state.accountType = 'individual'
    state.models = {
      data: [{
        id: 'gpt-5.4',
        capabilities: {
          limits: {
            max_output_tokens: 8192,
          },
        },
      }],
    } as typeof state.models

    // @ts-expect-error test mock only needs fetch callable shape
    globalThis.fetch = fetchMock

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/responses')

    const forwardedPayload = JSON.parse(String(init?.body)) as { max_output_tokens?: number, model?: string }
    expect(forwardedPayload.model).toBe('gpt-5.4')
    expect(forwardedPayload.max_output_tokens).toBe(8192)
  })

  test('missing "messages" field returns 400', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4', max_tokens: 100 }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('rate limit exceeded returns 429', async () => {
    const origRateLimitSeconds = state.rateLimitSeconds
    const origRateLimitWait = state.rateLimitWait
    const origLastRequestTimestamp = state.lastRequestTimestamp

    try {
      state.rateLimitSeconds = 9999
      state.rateLimitWait = false
      state.lastRequestTimestamp = undefined

      // First request: passes rate limit check and fails at JSON parsing.
      // This keeps the test fully local (no upstream network call).
      const first = await server.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '<<<not json>>>',
      })
      expect(first.status).toBe(400)

      // Second request: checkRateLimit sees the recent timestamp and
      // throws HTTPError(429) because rateLimitWait is false.
      const res = await server.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '<<<not json>>>',
      })

      expect(res.status).toBe(429)
    }
    finally {
      state.rateLimitSeconds = origRateLimitSeconds
      state.rateLimitWait = origRateLimitWait
      state.lastRequestTimestamp = origLastRequestTimestamp
    }
  })
})
