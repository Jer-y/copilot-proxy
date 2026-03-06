import { describe, expect, test } from 'bun:test'

import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { server } from '~/server'

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
