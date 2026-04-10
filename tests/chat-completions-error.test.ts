import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { clearProbeCache } from '~/lib/api-probe'
import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch

function createAbortError(): Error {
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

const fetchMock = mock(async (url: string, _init?: RequestInit): Promise<Response> => {
  throw new Error(`Unexpected upstream URL: ${url}`)
})

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(async (url: string, _init?: RequestInit): Promise<Response> => {
    throw new Error(`Unexpected upstream URL: ${url}`)
  })
  clearProbeCache()
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  clearProbeCache()
  globalThis.fetch = originalFetch
})

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

  test('responses-routed aborts return an empty response instead of surfacing as 500', async () => {
    fetchMock.mockImplementation(async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/responses')) {
        throw createAbortError()
      }

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

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  test('responses fallback aborts return an empty response instead of surfacing as 500', async () => {
    fetchMock.mockImplementation(async (url: string, _init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({
          error: {
            message: 'unsupported_api_for_model',
            code: 'unsupported_api_for_model',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.endsWith('/responses')) {
        throw createAbortError()
      }

      throw new Error(`Unexpected upstream URL: ${url}`)
    })

    const res = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
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

  test('responses-routed chat-completions map response_format json_schema to Responses text.format', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.endsWith('/responses')) {
        const forwardedPayload = JSON.parse(String(init?.body)) as {
          text?: {
            format?: {
              type?: string
              name?: string
              strict?: boolean
              schema?: Record<string, unknown>
            }
          }
        }

        expect(forwardedPayload.text).toEqual({
          format: {
            type: 'json_schema',
            name: 'math_answer',
            strict: true,
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        })

        return new Response(JSON.stringify({
          id: 'resp_json_schema',
          object: 'response',
          model: 'gpt-5.4',
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: '{"answer":"4"}' }],
            },
          ],
          status: 'completed',
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
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'What is 2+2? Return JSON.' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'math_answer',
            strict: true,
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const json = await res.json() as {
      choices: Array<{ message: { content: string } }>
    }
    expect(JSON.parse(json.choices[0].message.content)).toEqual({ answer: '4' })
  })
})
