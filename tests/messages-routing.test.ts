import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch

const fetchMock = mock(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/responses')) {
    return new Response(JSON.stringify({
      id: 'resp_route_test',
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

  if (url.endsWith('/chat/completions')) {
    const forwardedPayload = init?.body
      ? JSON.parse(String(init.body)) as { stream?: boolean }
      : {}

    if (forwardedPayload.stream) {
      return new Response([
        'data: {"id":"chatcmpl_route_stream","object":"chat.completion.chunk","created":0,"model":"claude-opus-4.6","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    return new Response(JSON.stringify({
      id: 'chatcmpl_route_test',
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

  throw new Error(`Unexpected upstream URL: ${url} body=${String(init?.body)}`)
})

beforeEach(() => {
  fetchMock.mockClear()
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  state.models = undefined
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

describe('messages route upstream adaptation', () => {
  test('Claude json_object requests are forwarded to /chat/completions with response_format', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Return JSON.' }],
        output_config: {
          format: {
            type: 'json_object',
          },
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/chat/completions')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      response_format?: { type?: string }
      model?: string
    }

    expect(forwardedPayload.model).toBe('claude-opus-4.6')
    expect(forwardedPayload.response_format).toEqual({ type: 'json_object' })
  })

  test('Responses-backed json_object requests are forwarded to /responses with text.format', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Return JSON.' }],
        output_config: {
          format: {
            type: 'json_object',
          },
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/responses')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      text?: { format?: { type?: string } }
      model?: string
    }

    expect(forwardedPayload.model).toBe('gpt-5.4')
    expect(forwardedPayload.text).toEqual({ format: { type: 'json_object' } })
  })

  test('Claude non-streaming requests are buffered from a streamed upstream response', async () => {
    fetchMock.mockImplementationOnce(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/chat/completions')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      const forwardedPayload = JSON.parse(String(init?.body)) as {
        stream?: boolean
      }

      expect(forwardedPayload.stream).toBe(true)

      return new Response([
        'data: {"id":"chatcmpl_stream_buffered","object":"chat.completion.chunk","created":0,"model":"claude-opus-4.6","choices":[{"index":0,"delta":{"role":"assistant","reasoning_text":"First think."},"finish_reason":null,"logprobs":null}]}\n\n',
        'data: {"id":"chatcmpl_stream_buffered","object":"chat.completion.chunk","created":0,"model":"claude-opus-4.6","choices":[{"index":0,"delta":{"content":"Buffered answer."},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":11,"completion_tokens":2,"total_tokens":13}}\n\n',
        'data: [DONE]\n\n',
      ].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)

    const body = await res.json() as {
      type?: string
      content?: Array<Record<string, unknown>>
      usage?: {
        input_tokens?: number
        output_tokens?: number
      }
    }

    expect(body.type).toBe('message')
    expect(body.content).toEqual([
      {
        type: 'thinking',
        thinking: 'First think.',
      },
      {
        type: 'text',
        text: 'Buffered answer.',
      },
    ])
    expect(body.usage?.input_tokens).toBe(11)
    expect(body.usage?.output_tokens).toBe(2)
  })

  test('Claude non-streaming responses preserve the original requested model name', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'fast-mode-2026-02-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6-20250514',
        speed: 'fast',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/chat/completions')

    const forwardedPayload = JSON.parse(String(init?.body)) as { model?: string }
    expect(forwardedPayload.model).toBe('claude-opus-4.6-fast')

    const body = await res.json() as { model?: string }
    expect(body.model).toBe('claude-opus-4-6-20250514')
  })

  test('Claude streaming responses preserve the original requested model name', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'fast-mode-2026-02-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6-20250514',
        speed: 'fast',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)

    const body = await res.text()
    expect(body).toContain('event: message_start')
    expect(body).toContain('"model":"claude-opus-4-6-20250514"')
    expect(body).not.toContain('"model":"claude-opus-4.6-fast"')
  })

  test('Claude non-streaming requests fail fast when streamed upstream only yields thinking', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (!url.endsWith('/chat/completions')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      return new Response([
        'data: {"id":"chatcmpl_thinking_only","object":"chat.completion.chunk","created":0,"model":"claude-opus-4.6","choices":[{"index":0,"delta":{"role":"assistant","reasoning_text":"Still reasoning."},"finish_reason":null,"logprobs":null}]}\n\n',
        'data: [DONE]\n\n',
      ].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(502)

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('api_error')
    expect(body.error?.message).toContain('reasoning output without any assistant text or tool call')
  })

  test('Claude URL image requests fail locally with Anthropic invalid_request_error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'url',
                  url: 'https://example.com/cat.png',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('external image URLs')
    expect(body.error?.message).toContain('base64')
  })

  test('Responses-backed URL image requests fail locally with Anthropic invalid_request_error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'url',
                  url: 'https://example.com/cat.png',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('external image URLs')
    expect(body.error?.message).toContain('base64')
  })

  test('tool_result URL image requests fail locally with Anthropic invalid_request_error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: [
                  { type: 'text', text: 'See attached image' },
                  {
                    type: 'image',
                    source: {
                      type: 'url',
                      url: 'https://example.com/result.png',
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('external image URLs')
    expect(body.error?.message).toContain('base64')
  })

  test('document blocks with invalid PDF data return extraction error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                title: 'report.pdf',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'JVBERi0xLjQK',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('Failed to extract text from PDF document')
  })

  test('count_tokens with document blocks returns default when model not found', async () => {
    const res = await server.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.6',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                title: 'report.pdf',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'JVBERi0xLjQK',
                },
              },
            ],
          },
        ],
      }),
    })

    // Model not found in test env → early return with default, no document expansion attempted
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as { input_tokens?: number }
    expect(body.input_tokens).toBe(1)
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})
