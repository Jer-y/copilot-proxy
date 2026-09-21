import { afterEach, describe, expect, test } from 'bun:test'

import { isLoopbackHostname } from '~/lib/security'
import { state } from '~/lib/state'
import { server } from '~/server'

const originalCopilotToken = state.defaultAccount.copilotToken
const originalExposeToken = process.env.COPILOT_PROXY_EXPOSE_TOKEN

afterEach(() => {
  state.defaultAccount.copilotToken = originalCopilotToken
  if (originalExposeToken === undefined)
    delete process.env.COPILOT_PROXY_EXPOSE_TOKEN
  else
    process.env.COPILOT_PROXY_EXPOSE_TOKEN = originalExposeToken
})

function requestWithIp(url: string, ip: string, init?: RequestInit): Request {
  const request = new Request(url, init)
  Object.defineProperty(request, 'ip', {
    value: ip,
  })
  return request
}

describe('/token security', () => {
  test('returns a retirement error even for same-machine requests', async () => {
    delete process.env.COPILOT_PROXY_EXPOSE_TOKEN
    state.defaultAccount.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://localhost:4399/token', '127.0.0.1'))

    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ error: { code: 'token_diagnostic_removed' } })
  })

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

  test('never returns tokens even with the retired exposure variable', async () => {
    process.env.COPILOT_PROXY_EXPOSE_TOKEN = '1'
    state.defaultAccount.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://localhost:4399/token', '127.0.0.1'))

    expect(response.status).toBe(410)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    expect(body).not.toContain('test-copilot-token')
    expect(JSON.parse(body)).not.toHaveProperty('token')
  })

  test('rejects cross-origin browser reads', async () => {
    process.env.COPILOT_PROXY_EXPOSE_TOKEN = '1'
    state.defaultAccount.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://localhost:4399/token', '127.0.0.1', {
      headers: {
        Origin: 'https://example.test',
      },
    }))

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(await response.json()).toMatchObject({ error: { code: 'origin_not_allowed' } })
  })

  test('returns the retirement notice for same-origin browser reads', async () => {
    process.env.COPILOT_PROXY_EXPOSE_TOKEN = '1'
    state.defaultAccount.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://localhost:4399/token', '127.0.0.1', {
      headers: {
        Origin: 'http://localhost:4399',
      },
    }))

    expect(response.status).toBe(410)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:4399')
    const body = await response.text()
    expect(body).not.toContain('test-copilot-token')
    expect(JSON.parse(body)).not.toHaveProperty('token')
  })

  test('rejects non-loopback request hosts', async () => {
    process.env.COPILOT_PROXY_EXPOSE_TOKEN = '1'
    state.defaultAccount.copilotToken = 'test-copilot-token'

    const response = await server.fetch(requestWithIp('http://192.168.1.10:4399/token', '127.0.0.1'))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'host_not_allowed' } })
  })

  test.each(['192.168.1.20', undefined])('never reads the token for remote address %s', async (ip) => {
    process.env.COPILOT_PROXY_EXPOSE_TOKEN = '1'
    state.defaultAccount.copilotToken = 'unread-token-sentinel'
    const request = ip ? requestWithIp('http://127.0.0.1/token', ip) : new Request('http://127.0.0.1/token')
    const response = await server.fetch(request)
    expect(response.status).toBe(410)
    expect(await response.text()).not.toContain('unread-token-sentinel')
  })
})
