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
})

afterEach(() => {
  globalThis.fetch = originalFetch
})
