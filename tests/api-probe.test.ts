import { describe, expect, test } from 'bun:test'

import {
  clearProbeCache,
  isApiProbedUnsupported,
  isUnsupportedApiError,
  recordProbeResult,
} from '../src/lib/api-probe'

describe('API probe cache', () => {
  test('returns false when no probe exists', () => {
    clearProbeCache()
    expect(isApiProbedUnsupported('unknown-model', 'chat-completions')).toBe(false)
  })

  test('records and checks probe result for chat-completions', () => {
    clearProbeCache()
    recordProbeResult('gpt-new', 'chat-completions')
    expect(isApiProbedUnsupported('gpt-new', 'chat-completions')).toBe(true)
    expect(isApiProbedUnsupported('gpt-new', 'responses')).toBe(false)
  })

  test('records and checks probe result for responses', () => {
    clearProbeCache()
    recordProbeResult('claude-new', 'responses')
    expect(isApiProbedUnsupported('claude-new', 'responses')).toBe(true)
    expect(isApiProbedUnsupported('claude-new', 'chat-completions')).toBe(false)
  })

  test('supports per-API storage for same model', () => {
    clearProbeCache()
    recordProbeResult('multi-model', 'chat-completions')
    recordProbeResult('multi-model', 'responses')
    expect(isApiProbedUnsupported('multi-model', 'chat-completions')).toBe(true)
    expect(isApiProbedUnsupported('multi-model', 'responses')).toBe(true)
    expect(isApiProbedUnsupported('multi-model', 'anthropic-messages')).toBe(false)
  })

  test('expires entries after TTL', () => {
    clearProbeCache()

    const realNow = Date.now
    Object.defineProperty(Date, 'now', { value: () => 0, configurable: true })
    recordProbeResult('expiring-model', 'chat-completions')
    Object.defineProperty(Date, 'now', { value: () => 31 * 60 * 1000, configurable: true })

    expect(isApiProbedUnsupported('expiring-model', 'chat-completions')).toBe(false)

    Object.defineProperty(Date, 'now', { value: realNow, configurable: true })
  })

  test('clearProbeCache clears all entries', () => {
    clearProbeCache()
    recordProbeResult('model-a', 'chat-completions')
    recordProbeResult('model-b', 'responses')
    clearProbeCache()
    expect(isApiProbedUnsupported('model-a', 'chat-completions')).toBe(false)
    expect(isApiProbedUnsupported('model-b', 'responses')).toBe(false)
  })
})

describe('unsupported_api_for_model detection', () => {
  test('matches code field', async () => {
    const response = new Response(JSON.stringify({
      error: {
        message: 'unsupported_api_for_model',
        code: 'unsupported_api_for_model',
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })

    expect(await isUnsupportedApiError(response)).toBe(true)
  })

  test('matches message fallback when code is absent', async () => {
    const response = new Response(JSON.stringify({
      error: {
        message: 'model failed: unsupported_api_for_model',
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })

    expect(await isUnsupportedApiError(response)).toBe(true)
  })

  test('returns false for unrelated errors', async () => {
    const response = new Response(JSON.stringify({
      error: {
        message: 'nope',
        code: 'different_error',
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })

    expect(await isUnsupportedApiError(response)).toBe(false)
  })
})

describe('Anthropic error format', () => {
  test('/v1/messages returns Anthropic-style errors', async () => {
    const { server } = await import('../src/server')

    const response = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })

    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body.type).toBe('error')
    expect(body.error).toBeDefined()
    const error = body.error as Record<string, unknown>
    expect(error.type).toBe('invalid_request_error')
    expect(typeof error.message).toBe('string')
  })

  test('/v1/chat/completions returns OpenAI-style errors', async () => {
    const { server } = await import('../src/server')

    const response = await server.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })

    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body.error).toBeDefined()
    const error = body.error as Record<string, unknown>
    expect(typeof error.message).toBe('string')
    expect(body.type).toBeUndefined()
  })

  test('/v1/messages validation error returns Anthropic format', async () => {
    const { server } = await import('../src/server')

    const response = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test' }),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as Record<string, unknown>
    expect(body.type).toBe('error')
    expect(body.error).toBeDefined()
  })
})
