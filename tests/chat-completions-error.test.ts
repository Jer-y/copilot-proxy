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

function createErroringSSE(
  chunks: string[],
  message: string,
  errorName = 'Error',
  errorDelayMs = 0,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
        return
      }

      if (errorDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, errorDelayMs))
      }
      const error = new Error(message)
      error.name = errorName
      controller.error(error)
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

  test('invalid max_completion_tokens type is rejected before upstream', async () => {
    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
        max_completion_tokens: '16',
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    const json = await res.json() as { error: { message: string } }
    expect(json.error.message).toContain('max_completion_tokens')
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

  test('non-streaming responses include OpenAI chat completion object type when upstream omits it', async () => {
    fetchMock.mockImplementation(async (url: string): Promise<Response> => {
      if (!url.endsWith('/chat/completions')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      return new Response(JSON.stringify({
        id: 'chatcmpl_missing_object',
        created: 0,
        model: 'gpt-5.2',
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

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { object?: string }
    expect(body.object).toBe('chat.completion')
  })

  test('streaming chunks include OpenAI chat completion chunk object type when upstream omits it', async () => {
    fetchMock.mockImplementation(async (url: string): Promise<Response> => {
      if (!url.endsWith('/chat/completions')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      return new Response([
        'data: {"id":"chatcmpl_missing_chunk_object","created":0,"model":"gpt-5.2","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null,"logprobs":null}]}',
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.2',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('"object":"chat.completion.chunk"')
    expect(body).toContain('data: [DONE]')
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
    expect(body).toContain('data: [DONE]')
  })

  test('non-streaming does not turn an upstream AbortError into an empty 200 response', async () => {
    fetchMock.mockImplementation(async () => {
      const error = new Error('chat upstream connection aborted')
      error.name = 'AbortError'
      throw error
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({
      error: {
        message: 'chat upstream connection aborted',
        type: 'api_error',
        code: 'upstream_connection_aborted',
      },
    })
  })

  test('streaming reports AbortError and terminates when the client stream is still open', async () => {
    fetchMock.mockImplementation(async () => {
      return new Response(createErroringSSE([
        [
          'data: {"id":"chatcmpl_abort_error","object":"chat.completion.chunk","created":0,"model":"gpt-5.2","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null,"logprobs":null}]}',
          '',
          '',
        ].join('\n'),
      ], 'chat upstream stream aborted', 'AbortError'), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.2',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('"partial"')
    expect(body).toContain('event: error')
    expect(body).toContain('"message":"chat upstream stream aborted"')
    expect(body).toContain('"code":"stream_error"')
    expect(body).toContain('data: [DONE]')
  })

  test('streaming ignores a transport AbortError after [DONE]', async () => {
    fetchMock.mockImplementation(async () => {
      return new Response(createErroringSSE([
        [
          'data: {"id":"chatcmpl_terminal_abort","object":"chat.completion.chunk","created":0,"model":"gpt-5.2","choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop","logprobs":null}]}',
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'),
      ], 'chat socket closed after [DONE]', 'AbortError', 25), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.2',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('"finish_reason":"stop"')
    expect(body).toContain('data: [DONE]')
    expect(body).not.toContain('event: error')
    expect(body).not.toContain('chat socket closed after [DONE]')
  })

  test('streaming rejects non-SSE success responses before opening a client stream', async () => {
    fetchMock.mockImplementation(async () => new Response('maintenance', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    }))

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toMatchObject({
      error: {
        code: 'invalid_upstream_response',
      },
    })
  })

  test('streaming emits an error when upstream closes before [DONE]', async () => {
    fetchMock.mockImplementation(async () => new Response([
      'data: {"id":"chatcmpl_truncated","object":"chat.completion.chunk","created":0,"model":"gpt-5","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}',
      '',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }))

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('"partial"')
    expect(body).toContain('event: error')
    expect(body).toContain('terminated before the [DONE] event')
    expect(body).toContain('data: [DONE]')
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

  test('gpt-5.4 chat-completions uses max_completion_tokens without legacy max_tokens', async () => {
    let forwardedBody: Record<string, unknown> | undefined
    state.models = {
      object: 'list',
      data: [{
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        object: 'model',
        model_picker_enabled: true,
        preview: false,
        vendor: 'OpenAI',
        version: '5.4',
        supported_endpoints: ['/responses', '/chat/completions'],
        capabilities: {
          family: 'gpt-5.4',
          limits: { max_output_tokens: 32768 },
          object: 'model_capabilities',
          supports: {},
          tokenizer: 'o200k_base',
          type: 'chat',
        },
      }],
    }
    fetchMock.mockImplementation(async (url: string, init?: RequestInit): Promise<Response> => {
      if (!url.endsWith('/chat/completions'))
        throw new Error(`Unexpected upstream URL: ${url}`)

      forwardedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'chatcmpl_gpt54',
        created: 0,
        model: 'gpt-5.4',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          logprobs: null,
          finish_reason: 'stop',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(forwardedBody?.max_completion_tokens).toBe(32768)
    expect(forwardedBody).not.toHaveProperty('max_tokens')
  })

  test('gpt-5.4 converts a legacy max_tokens limit before forwarding', async () => {
    let forwardedBody: Record<string, unknown> | undefined
    fetchMock.mockImplementation(async (url: string, init?: RequestInit): Promise<Response> => {
      if (!url.endsWith('/chat/completions'))
        throw new Error(`Unexpected upstream URL: ${url}`)

      forwardedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({
        id: 'chatcmpl_gpt54_limit',
        created: 0,
        model: 'gpt-5.4',
        choices: [],
      })
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(forwardedBody?.max_completion_tokens).toBe(16)
    expect(forwardedBody).not.toHaveProperty('max_tokens')
  })

  test('200 error JSON from upstream becomes a structured 502 instead of entering SSE handling', async () => {
    fetchMock.mockImplementation(async (url: string): Promise<Response> => {
      if (!url.endsWith('/chat/completions'))
        throw new Error(`Unexpected upstream URL: ${url}`)

      return Response.json({
        error: {
          message: 'upstream rejected the request',
          type: 'invalid_request_error',
        },
      })
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: {
        message: 'upstream rejected the request',
        type: 'invalid_request_error',
      },
    })
  })

  test('streaming 200 JSON errors become a structured 502 instead of fake SSE', async () => {
    fetchMock.mockImplementation(async (url: string): Promise<Response> => {
      if (!url.endsWith('/chat/completions'))
        throw new Error(`Unexpected upstream URL: ${url}`)

      return Response.json({
        error: {
          message: 'streaming request was rejected',
          type: 'invalid_request_error',
        },
      })
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.2',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: {
        message: 'streaming request was rejected',
        type: 'invalid_request_error',
      },
    })
  })
})
