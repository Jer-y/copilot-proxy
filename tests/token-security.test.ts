import { afterEach, describe, expect, test } from 'bun:test'

import { isLoopbackHostname, isTokenRequestAllowed } from '~/lib/security'
import { state } from '~/lib/state'
import { server } from '~/server'

const originalCopilotToken = state.copilotToken

afterEach(() => {
  state.copilotToken = originalCopilotToken
})

function requestWithIp(url: string, ip: string, init?: RequestInit): Request {
  const request = new Request(url, init)
  Object.defineProperty(request, 'ip', {
    value: ip,
  })
  return request
}

describe('/token security', () => {
  test('recognizes canonical and equivalent loopback hosts', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('127.99.0.1')).toBe(true)
    expect(isLoopbackHostname('localhost.')).toBe(true)
    expect(isLoopbackHostname('::1')).toBe(true)
    expect(isLoopbackHostname('0::1')).toBe(true)
    expect(isLoopbackHostname('0:0::1')).toBe(true)
    expect(isLoopbackHostname('::0:1')).toBe(true)
    expect(isLoopbackHostname('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackHostname('::ffff:7f00:1')).toBe(true)

    expect(isLoopbackHostname('192.168.1.10')).toBe(false)
    expect(isLoopbackHostname('::2')).toBe(false)
    expect(isLoopbackHostname('::ffff:128.0.0.1')).toBe(false)
  })

  test('returns the token for same-machine requests without browser origin', async () => {
    state.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://localhost:4399/token', '127.0.0.1'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ token: 'test-copilot-token' })
  })

  test('rejects cross-origin browser reads', async () => {
    state.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://localhost:4399/token', '127.0.0.1', {
      headers: {
        Origin: 'https://example.test',
      },
    }))

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.json()).toEqual({ error: 'Forbidden', token: null })
  })

  test('allows same-origin browser reads on loopback', async () => {
    state.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://localhost:4399/token', '127.0.0.1', {
      headers: {
        Origin: 'http://localhost:4399',
      },
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:4399')
    expect(await response.json()).toEqual({ token: 'test-copilot-token' })
  })

  test('rejects non-loopback request hosts', async () => {
    state.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://192.168.1.10:4399/token', '127.0.0.1'))

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Forbidden', token: null })
  })

  test('rejects non-loopback remote addresses even with a loopback host header', () => {
    const request = requestWithIp('http://127.0.0.1:4399/token', '192.168.1.20')

    expect(isTokenRequestAllowed(request)).toBe(false)
  })

  test('rejects requests without a confirmed remote address', () => {
    expect(isTokenRequestAllowed(new Request('http://127.0.0.1:4399/token'))).toBe(false)
  })
})
