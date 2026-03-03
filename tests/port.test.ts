import type { Server } from 'node:net'
import { createServer } from 'node:net'

import { describe, expect, test } from 'bun:test'

import { checkPortAvailable, isPortInUseError } from '../src/lib/port'

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, () => resolve())
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function getPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve test server port')
  }
  return address.port
}

describe('isPortInUseError', () => {
  test('returns true for errno EADDRINUSE', () => {
    const error = new Error('port already in use') as NodeJS.ErrnoException
    error.code = 'EADDRINUSE'
    expect(isPortInUseError(error)).toBe(true)
  })

  test('returns true for known message pattern', () => {
    const error = new Error('listen EADDRINUSE: address already in use :::4399')
    expect(isPortInUseError(error)).toBe(true)
  })

  test('returns false for unrelated errors', () => {
    expect(isPortInUseError(new Error('permission denied'))).toBe(false)
    expect(isPortInUseError({ code: 'EADDRINUSE' })).toBe(false)
  })
})

describe('checkPortAvailable', () => {
  test('resolves when port is available', async () => {
    const server = createServer()
    await listen(server, 0)
    const port = getPort(server)
    await close(server)

    await expect(checkPortAvailable(port)).resolves.toBeUndefined()
  })

  test('rejects when port is already in use', async () => {
    const server = createServer()
    await listen(server, 0)
    const port = getPort(server)

    await expect(checkPortAvailable(port)).rejects.toMatchObject({
      code: 'EADDRINUSE',
    })

    await close(server)
  })
})
