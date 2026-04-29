import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const encoder = new TextEncoder()

const fetchMock = mock(async (url: string, _init?: RequestInit): Promise<Response> => {
  throw new Error(`Unexpected upstream URL: ${url}`)
})

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(async (url: string, _init?: RequestInit): Promise<Response> => {
    throw new Error(`Unexpected upstream URL: ${url}`)
  })
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  state.models = undefined
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function createErroringSSE(chunks: string[], message: string): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
        return
      }

      controller.error(new Error(message))
    },
  })
}

describe('chat-completions error paths', () => {
  test('invalid JSON body returns 400 with invalid_request_error', async () => {
    const res = await server.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '<<<not json>>>',
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('missing "model" field returns 400', async () => {
    const res = await server.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('missing "messages" field returns 400', async () => {
    const res = await server.request('/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o' }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('external image URLs are rejected locally before forwarding upstream', async () => {
    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              {
                type: 'image_url',
                image_url: {
                  url: 'https://example.com/image.png',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(0)

    const json = await res.json() as {
      error: {
        type: string
        message: string
      }
    }
    expect(json.error.type).toBe('invalid_request_error')
    expect(json.error.message).toContain('external image URLs')
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
      const first = await server.request('/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '<<<not json>>>',
      })
      expect(first.status).toBe(400)

      // Second request: checkRateLimit sees the recent timestamp and
      // throws HTTPError(429) because rateLimitWait is false.
      const res = await server.request('/chat/completions', {
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

  test('streaming surfaces upstream stream errors as SSE error events', async () => {
    fetchMock.mockImplementation(async (url: string): Promise<Response> => {
      if (!url.endsWith('/chat/completions')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      return new Response(createErroringSSE([
        [
          'data: {"id":"chatcmpl_stream_error","object":"chat.completion.chunk","created":0,"model":"gpt-5","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null,"logprobs":null}]}',
          '',
          '',
        ].join('\n'),
      ], 'chat stream failed'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)

    const body = await res.text()
    expect(body).toContain('"object":"chat.completion.chunk"')
    expect(body).toContain('event: error')
    expect(body).toContain('"type":"error"')
    expect(body).toContain('"message":"chat stream failed"')
    expect(body).toContain('"code":"stream_error"')
  })

  test('Claude chat-completions requests keep using /chat/completions despite native Anthropic support', async () => {
    fetchMock.mockImplementation(async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({
          id: 'chatcmpl_claude_direct',
          object: 'chat.completion',
          created: 0,
          model: 'claude-opus-4.6',
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

      throw new Error(`Unexpected upstream URL: ${url}`)
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/chat/completions',
    ])
  })

  test('chat-completions client cannot reach a responses-only model and gets a clean 4xx', async () => {
    fetchMock.mockImplementation(async (url: string): Promise<Response> => {
      throw new Error(`Unexpected upstream URL: ${url}`)
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    const body = await res.json() as { error?: { message?: string } }
    expect(body.error?.message).toContain('cannot be reached via /chat/completions')
  })
})
