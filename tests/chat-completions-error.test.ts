import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { clearProbeCache } from '~/lib/api-probe'
import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const fetchMock = mock(async (url: string) => {
  throw new Error(`Unexpected upstream URL: ${url}`)
})

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(async (url: string) => {
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
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/responses')) {
        throw new DOMException('The operation was aborted.', 'AbortError')
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
    fetchMock.mockImplementation(async (url: string) => {
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
        throw new DOMException('The operation was aborted.', 'AbortError')
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
})
