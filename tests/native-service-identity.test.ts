import http from 'node:http'
import process from 'node:process'

import { afterEach, describe, expect, test } from 'bun:test'

import { NATIVE_SERVICE_INSTANCE_HEADER, probeCopilotProxyServer } from '~/daemon/native-service'
import { state } from '~/lib/state'
import { server } from '~/server'

const originalAllowedHosts = process.env.COPILOT_PROXY_ALLOWED_HOSTS

afterEach(() => {
  state.nativeServiceInstanceToken = undefined
  if (originalAllowedHosts === undefined)
    delete process.env.COPILOT_PROXY_ALLOWED_HOSTS
  else
    process.env.COPILOT_PROXY_ALLOWED_HOSTS = originalAllowedHosts
})

describe('native service instance identity', () => {
  test('exposes the configured instance token on the readiness response', async () => {
    state.nativeServiceInstanceToken = 'instance_token_20260713'

    const response = await server.request('/')

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('Server running')
    expect(response.headers.get(NATIVE_SERVICE_INSTANCE_HEADER)).toBe('instance_token_20260713')
  })

  test('readiness rejects a healthy response from the wrong instance', async () => {
    const probeServer = http.createServer((_request, response) => {
      response.setHeader(NATIVE_SERVICE_INSTANCE_HEADER, 'different_instance_20260713')
      response.end('Server running')
    })
    await new Promise<void>((resolve, reject) => {
      probeServer.once('error', reject)
      probeServer.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = probeServer.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected TCP address')

      expect(await probeCopilotProxyServer(
        '127.0.0.1',
        address.port,
        'expected_instance_20260713',
      )).toBe(false)
      expect(await probeCopilotProxyServer(
        '127.0.0.1',
        address.port,
        'different_instance_20260713',
      )).toBe(true)
    }
    finally {
      await new Promise<void>((resolve, reject) => {
        probeServer.close(error => error ? reject(error) : resolve())
      })
    }
  })

  test('readiness reaches the real server with the persisted non-loopback Host header', async () => {
    state.nativeServiceInstanceToken = 'instance_token_non_loopback'
    process.env.COPILOT_PROXY_ALLOWED_HOSTS = 'proxy.internal'
    const liveServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => server.fetch(request),
    })
    const { port } = liveServer
    if (port === undefined)
      throw new Error('Expected a TCP listener port')

    try {
      expect(await probeCopilotProxyServer(
        '0.0.0.0',
        port,
        'instance_token_non_loopback',
        'proxy.internal',
      )).toBe(true)

      delete process.env.COPILOT_PROXY_ALLOWED_HOSTS
      expect(await probeCopilotProxyServer(
        '0.0.0.0',
        port,
        'instance_token_non_loopback',
        'proxy.internal',
      )).toBe(false)
    }
    finally {
      await liveServer.stop(true)
    }
  })
})
