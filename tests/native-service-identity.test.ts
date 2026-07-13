import http from 'node:http'

import { afterEach, describe, expect, test } from 'bun:test'

import { NATIVE_SERVICE_INSTANCE_HEADER, probeCopilotProxyServer } from '~/daemon/native-service'
import { state } from '~/lib/state'
import { server } from '~/server'

afterEach(() => {
  state.nativeServiceInstanceToken = undefined
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
})
