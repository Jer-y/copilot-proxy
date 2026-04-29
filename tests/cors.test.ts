import { afterEach, describe, expect, test } from 'bun:test'

import { CORS_ORIGINS_ENV } from '~/lib/security'
import { server } from '~/server'

function parseHeaderList(value: string | null): Array<string> {
  return value
    ?.split(',')
    .map(header => header.trim().toLowerCase())
    .filter(Boolean) ?? []
}

afterEach(() => {
  delete process.env[CORS_ORIGINS_ENV]
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
    expect(exposedHeaders).toContain('retry-after')
    expect(exposedHeaders.some(header => header.startsWith('x-quota-snapshot'))).toBe(false)
  })

  test('does not allow arbitrary browser origins by default', async () => {
    const response = await server.request('/', {
      headers: {
        Origin: 'https://example.test',
      },
    })

    expect(response.headers.get('access-control-allow-origin')).toBeNull()
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
  })
})
