import { afterEach, describe, expect, test } from 'bun:test'

import { ALLOWED_HOSTS_ENV, CORS_ORIGINS_ENV } from '~/lib/security'
import { server } from '~/server'

function parseHeaderList(value: string | null): Array<string> {
  return value
    ?.split(',')
    .map(header => header.trim().toLowerCase())
    .filter(Boolean) ?? []
}

afterEach(() => {
  delete process.env[CORS_ORIGINS_ENV]
  delete process.env[ALLOWED_HOSTS_ENV]
})

describe('CORS', () => {
  test('allows local web origins and exposes request correlation headers', async () => {
    const response = await server.request('/', {
      headers: {
        Origin: 'http://localhost:3000',
      },
    })

    const exposedHeaders = parseHeaderList(response.headers.get('access-control-expose-headers'))

    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    expect(exposedHeaders).toContain('x-request-id')
    expect(exposedHeaders).toContain('x-github-request-id')
    expect(exposedHeaders).toContain('x-copilot-service-request-id')
    expect(exposedHeaders).toContain('x-copilot-proxy-recovery-state')
    expect(exposedHeaders).toContain('retry-after')
    expect(exposedHeaders.some(header => header.startsWith('x-quota-snapshot'))).toBe(false)
  })

  test('rejects arbitrary browser origins before a route executes', async () => {
    const response = await server.request('/', {
      headers: {
        Origin: 'https://example.test',
      },
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.json()).toMatchObject({ error: { code: 'origin_not_allowed' } })
  })

  test('allows explicitly configured browser origins', async () => {
    process.env[CORS_ORIGINS_ENV] = 'https://example.test'

    const response = await server.request('/', {
      headers: {
        Origin: 'https://example.test',
      },
    })

    expect(response.headers.get('access-control-allow-origin')).toBe('https://example.test')

    process.env[CORS_ORIGINS_ENV] = 'https://second.example.test'

    const changedResponse = await server.request('/', {
      headers: {
        Origin: 'https://second.example.test',
      },
    })

    expect(changedResponse.headers.get('access-control-allow-origin')).toBe('https://second.example.test')
  })

  test('allows hosted usage viewer only on usage routes', async () => {
    const usageResponse = await server.request('/usage', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://jer-y.github.io',
        'Access-Control-Request-Method': 'GET',
      },
    })

    const tokenResponse = await server.request('/token', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://jer-y.github.io',
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(usageResponse.headers.get('access-control-allow-origin')).toBe('https://jer-y.github.io')
    expect(tokenResponse.headers.get('access-control-allow-origin')).toBeNull()
    expect(tokenResponse.status).toBe(403)
  })

  test('rejects simple cross-origin JSON-route requests before body parsing', async () => {
    const response = await server.request('/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Origin': 'https://evil.example',
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hello' }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'origin_not_allowed' } })
  })

  test('rejects non-JSON content types on JSON routes even without an Origin', async () => {
    const response = await server.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hello' }),
    })

    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_content_type' } })
  })

  test('accepts structured JSON media types', async () => {
    const response = await server.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.api+json; charset=utf-8' },
      body: 'not-json',
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { message: 'Invalid JSON body' },
    })
  })

  test('rejects non-application media types that merely end in +json', async () => {
    const response = await server.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain+json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: 'hello' }),
    })

    expect(response.status).toBe(415)
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_content_type' } })
  })

  test('requires an allowed Host and supports an explicit deployment allowlist', async () => {
    const rejected = await server.request('http://localhost/', {
      headers: { Host: 'proxy.example' },
    })
    expect(rejected.status).toBe(403)
    expect(await rejected.json()).toMatchObject({ error: { code: 'host_not_allowed' } })

    process.env[ALLOWED_HOSTS_ENV] = 'proxy.example'
    const allowed = await server.request('http://localhost/', {
      headers: { Host: 'proxy.example' },
    })
    expect(allowed.status).toBe(200)
  })
})
