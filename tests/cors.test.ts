import { Buffer } from 'node:buffer'
import { request as httpRequest } from 'node:http'
import { afterEach, describe, expect, test } from 'bun:test'

import { ALLOWED_HOSTS_ENV, CORS_ORIGINS_ENV, hasValidNonLoopbackAllowedHost, parseAllowedHosts } from '~/lib/security'
import { server } from '~/server'
import { closeServerGracefully, createAppServer } from '~/start'

function parseHeaderList(value: string | null): Array<string> {
  return value
    ?.split(',')
    .map(header => header.trim().toLowerCase())
    .filter(Boolean) ?? []
}

async function requestWithHost(url: string, host: string): Promise<{ body: unknown, status: number }> {
  const target = new URL(url)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: { Host: host },
      host: target.hostname,
      method: 'GET',
      path: '/',
      port: Number(target.port),
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.once('error', reject)
      response.once('end', () => {
        const responseText = Buffer.concat(chunks).toString('utf8')
        let body: unknown = responseText
        try {
          body = JSON.parse(responseText) as unknown
        }
        catch {
          // Successful root responses are plain text; rejection envelopes are JSON.
        }
        resolve({
          body,
          status: response.statusCode ?? 0,
        })
      })
    })
    request.once('error', reject)
    request.end()
  })
}

async function requestHostedDashboardCors(
  url: string,
  path: string,
): Promise<{ allowOrigin: string | null, status: number }> {
  const target = new URL(url)
  return await new Promise((resolve, reject) => {
    const request = httpRequest({
      headers: {
        'Access-Control-Request-Method': 'GET',
        'Host': target.host,
        'Origin': 'https://jer-y.github.io',
      },
      host: target.hostname,
      method: 'OPTIONS',
      path,
      port: Number(target.port),
    }, (response) => {
      response.once('error', reject)
      response.once('end', () => {
        const allowOrigin = response.headers['access-control-allow-origin']
        resolve({
          allowOrigin: Array.isArray(allowOrigin) ? allowOrigin.join(', ') : allowOrigin ?? null,
          status: response.statusCode ?? 0,
        })
      })
      response.resume()
    })
    request.once('error', reject)
    request.end()
  })
}

afterEach(() => {
  delete process.env[CORS_ORIGINS_ENV]
  delete process.env[ALLOWED_HOSTS_ENV]
})

describe('CORS', () => {
  test('parses exact DNS, IPv4, and IPv6 allowlist entries and rejects malformed entries', () => {
    expect([...parseAllowedHosts(' Proxy.Internal.,192.0.2.10,[2001:0DB8:0:0:0:0:0:1],2001:db8::2')!]).toEqual([
      'proxy.internal',
      '192.0.2.10',
      '2001:db8::1',
      '2001:db8::2',
    ])

    for (const malformed of [
      undefined,
      '',
      ',',
      'proxy.internal,',
      'https://proxy.internal',
      'proxy.internal:443',
      '[2001:db8::1]:443',
      '[fe80::1%eth0]',
      'fe80::1%eth0',
      '[fe80::1%25eth0]',
      'fe80::1%25eth0',
      '*.internal',
      '999.1.1.1',
    ]) {
      expect(parseAllowedHosts(malformed)).toBeNull()
    }
  })

  test('requires a fully valid allowlist with at least one exact non-loopback Host for exposed deployments', () => {
    for (const valid of [
      'proxy.internal',
      'localhost,proxy.internal',
      '192.0.2.10',
      '[2001:db8::1]',
    ]) {
      expect(hasValidNonLoopbackAllowedHost(valid)).toBe(true)
    }

    for (const loopbackOnlyOrInvalid of [
      undefined,
      '',
      'localhost',
      'foo.localhost',
      '127.0.0.1',
      '127.255.255.255',
      '[::1]',
      '[::ffff:127.0.0.1]',
      '*.internal',
      'proxy.internal:443',
      'proxy.internal,',
      'proxy.internal,*.internal',
    ]) {
      expect(hasValidNonLoopbackAllowedHost(loopbackOnlyOrInvalid)).toBe(false)
    }
  })

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

    const nestedPathResponse = await server.request('/diagnostics/status', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'http://localhost:3000',
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(nestedPathResponse.status).toBe(204)
    expect(nestedPathResponse.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
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

    const changedResponse = await server.request('/usage/history', {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://second.example.test',
        'Access-Control-Request-Method': 'GET',
      },
    })

    expect(changedResponse.status).toBe(204)
    expect(changedResponse.headers.get('access-control-allow-origin')).toBe('https://second.example.test')
  })

  test('allows the hosted dashboard only on exact diagnostics and legacy usage routes', async () => {
    const headers = {
      'Origin': 'https://jer-y.github.io',
      'Access-Control-Request-Method': 'GET',
    }

    for (const path of ['/diagnostics', '/diagnostics/', '/usage', '/usage/']) {
      const response = await server.request(path, { method: 'OPTIONS', headers })
      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://jer-y.github.io')
    }

    for (const path of [
      '/diagnostics/status',
      '/diagnostics//',
      '/diagnostics.json',
      '/usage/history',
      '/usage//',
      '/usage.json',
      '/token',
      '/v1/models',
    ]) {
      const response = await server.request(path, { method: 'OPTIONS', headers })
      expect(response.status).toBe(403)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(await response.json()).toMatchObject({ error: { code: 'origin_not_allowed' } })
    }

    const nestedGet = await server.request('/diagnostics/status', {
      headers: { Origin: 'https://jer-y.github.io' },
    })
    expect(nestedGet.status).toBe(403)
    expect(nestedGet.headers.get('access-control-allow-origin')).toBeNull()
    expect(await nestedGet.json()).toMatchObject({ error: { code: 'origin_not_allowed' } })
  })

  test('enforces hosted dashboard CORS paths through a real HTTP listener', async () => {
    const listener = createAppServer({ host: '127.0.0.1', port: 0, silent: true })
    try {
      await listener.ready()
      for (const path of ['/diagnostics', '/diagnostics/', '/usage', '/usage/']) {
        const response = await requestHostedDashboardCors(String(listener.url), path)
        expect(response).toEqual({
          allowOrigin: 'https://jer-y.github.io',
          status: 204,
        })
      }

      for (const path of ['/diagnostics/status', '/diagnostics//', '/usage/history', '/usage//']) {
        const response = await requestHostedDashboardCors(String(listener.url), path)
        expect(response).toEqual({ allowOrigin: null, status: 403 })
      }
    }
    finally {
      await closeServerGracefully(listener)
    }
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

    process.env[ALLOWED_HOSTS_ENV] = '[fe80::1%eth0]'
    const rejectedScopedIpv6 = await server.request('http://localhost/', {
      headers: { Host: 'proxy.example' },
    })
    expect(rejectedScopedIpv6.status).toBe(403)
    expect(await rejectedScopedIpv6.json()).toMatchObject({ error: { code: 'host_not_allowed' } })

    process.env[ALLOWED_HOSTS_ENV] = 'proxy.example,192.0.2.10,[2001:0db8:0:0:0:0:0:1]'
    for (const host of ['proxy.example:4399', '192.0.2.10:4399', '[2001:db8::1]:4399']) {
      const allowed = await server.request('http://localhost/', {
        headers: { Host: host },
      })
      expect(allowed.status).toBe(200)
    }

    for (const malformedHost of [
      'evil@127.0.0.1',
      'user:pass@localhost',
      '127.0.0.1/path',
      '127.0.0.1\\path',
      '127.0.0.1?query',
      '127.0.0.1#fragment',
      'evil%40127.0.0.1',
      'evil@proxy.example',
    ]) {
      const malformed = await server.request('http://localhost/', {
        headers: { Host: malformedHost },
      })
      expect(malformed.status).toBe(403)
      expect(await malformed.json()).toMatchObject({ error: { code: 'host_not_allowed' } })
    }
  })

  test('enforces exact configured Host values through a real non-loopback HTTP listener', async () => {
    process.env[ALLOWED_HOSTS_ENV] = 'proxy.internal,192.0.2.10,[2001:db8::1]'
    const listener = createAppServer({ host: '0.0.0.0', port: 0, silent: true })
    try {
      await listener.ready()
      for (const host of ['proxy.internal:4399', '192.0.2.10:4399', '[2001:db8::1]:4399']) {
        const response = await requestWithHost(String(listener.url), host)
        expect(response.status).toBe(200)
      }

      for (const host of ['unlisted.internal', 'evil@127.0.0.1']) {
        const response = await requestWithHost(String(listener.url), host)
        expect(response.status).toBe(403)
        expect(response.body).toMatchObject({ error: { code: 'host_not_allowed' } })
      }
    }
    finally {
      await closeServerGracefully(listener)
    }
  })
})
