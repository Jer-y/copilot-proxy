import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'

import { apiKeyAuth } from '../src/lib/api-key-auth'
import { state } from '../src/lib/state'

// Build a minimal Hono app with the middleware on protected routes
const app = new Hono()
app.use('/v1/chat/completions/*', apiKeyAuth)
app.use('/chat/completions/*', apiKeyAuth)
app.use('/v1/messages/*', apiKeyAuth)
app.use('/v1/embeddings/*', apiKeyAuth)
app.use('/v1/responses/*', apiKeyAuth)
app.use('/responses/*', apiKeyAuth)

app.get('/', c => c.text('ok'))
app.get('/v1/models', c => c.text('models'))
app.get('/models', c => c.text('models'))
app.get('/usage', c => c.text('usage'))
app.get('/token', c => c.text('token'))
app.post('/v1/chat/completions', c => c.json({ ok: true }))
app.post('/chat/completions', c => c.json({ ok: true }))
app.post('/v1/messages', c => c.json({ ok: true }))
app.post('/v1/embeddings', c => c.json({ ok: true }))
app.post('/v1/responses', c => c.json({ ok: true }))
app.post('/responses', c => c.json({ ok: true }))

// Always restore state.apiKey to prevent leaking into other test files
// that share the same process and import the shared `state` singleton.
beforeEach(() => {
  state.apiKey = undefined
})

afterEach(() => {
  state.apiKey = undefined
})

afterAll(() => {
  state.apiKey = undefined
})

describe('apiKeyAuth middleware — no key configured (backward compat)', () => {
  test('all routes pass through when apiKey is undefined', async () => {
    for (const path of ['/', '/v1/models', '/models', '/usage', '/token']) {
      const res = await app.fetch(new Request(`http://localhost${path}`))
      expect(res.status).toBe(200)
    }

    for (const path of ['/v1/chat/completions', '/chat/completions', '/v1/messages', '/v1/embeddings', '/v1/responses', '/responses']) {
      const res = await app.fetch(new Request(`http://localhost${path}`, { method: 'POST' }))
      expect(res.status).toBe(200)
    }
  })
})

describe('apiKeyAuth middleware — key configured', () => {
  const KEY = 'test-secret-key-abc'

  beforeEach(() => {
    state.apiKey = KEY
  })

  test('management routes remain accessible without key', async () => {
    for (const path of ['/', '/v1/models', '/models', '/usage', '/token']) {
      const res = await app.fetch(new Request(`http://localhost${path}`))
      expect(res.status).toBe(200)
    }
  })

  test('model routes return 401 without key', async () => {
    for (const path of ['/v1/chat/completions', '/chat/completions', '/v1/messages', '/v1/embeddings', '/v1/responses', '/responses']) {
      const res = await app.fetch(new Request(`http://localhost${path}`, { method: 'POST' }))
      expect(res.status).toBe(401)
      const body = await res.json() as Record<string, string>
      expect(body.error).toBe('Unauthorized')
      expect(body.message).toContain('Missing API key')
    }
  })

  test('model routes return 401 with wrong Bearer key', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-key' },
    }))
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, string>
    expect(body.message).toBe('Invalid API key')
  })

  test('model routes return 401 with wrong x-api-key', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'wrong-key' },
    }))
    expect(res.status).toBe(401)
    const body = await res.json() as Record<string, string>
    expect(body.message).toBe('Invalid API key')
  })

  test('model routes pass with correct Authorization: Bearer key', async () => {
    for (const path of ['/v1/chat/completions', '/chat/completions', '/v1/embeddings', '/v1/responses', '/responses']) {
      const res = await app.fetch(new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}` },
      }))
      expect(res.status).toBe(200)
    }
  })

  test('model routes pass with correct x-api-key header', async () => {
    for (const path of ['/v1/messages', '/v1/chat/completions']) {
      const res = await app.fetch(new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'x-api-key': KEY },
      }))
      expect(res.status).toBe(200)
    }
  })

  test('Bearer prefix is case-insensitive', async () => {
    for (const prefix of ['bearer', 'BEARER', 'Bearer']) {
      const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `${prefix} ${KEY}` },
      }))
      expect(res.status).toBe(200)
    }
  })

  test('Authorization header without Bearer prefix is rejected', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: KEY },
    }))
    expect(res.status).toBe(401)
  })

  test('empty Authorization header is rejected', async () => {
    const res = await app.fetch(new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: '' },
    }))
    expect(res.status).toBe(401)
  })
})
