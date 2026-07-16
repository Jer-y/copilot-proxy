import type { Peer } from 'crossws'
import type { ServerRequest } from 'srvx'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import {
  closeResponsesWebSocketsGracefully,
  prepareResponsesWebSocketServer,
  responsesWebSocketOptions,
} from '~/routes/responses/websocket'

const upgrade = responsesWebSocketOptions.upgrade!

beforeEach(() => prepareResponsesWebSocketServer())
afterEach(() => prepareResponsesWebSocketServer())

describe('Responses WebSocket upgrade policy', () => {
  test('accepts both Responses paths and reserves a bounded connection slot', async () => {
    for (const path of ['/responses', '/v1/responses']) {
      const result = await upgrade(request(path))
      expect(result).not.toBeInstanceOf(Response)
      const context = (result as { context?: Record<string, unknown> } | undefined)?.context
      expect(context?.path).toBe(path)
      const releaseReservation = context?.releaseConnectionReservation
      expect(typeof releaseReservation).toBe('function')
      if (typeof releaseReservation === 'function')
        releaseReservation()
    }
  })

  test('rejects unrelated paths before upgrading', async () => {
    const result = await upgrade(request('/v1/messages'))
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(404)
  })

  test('rejects disallowed Host and Origin values before upgrading', async () => {
    const invalidHost = await upgrade(request('/v1/responses', {
      host: 'attacker.example',
    }))
    expect(invalidHost).toBeInstanceOf(Response)
    expect((invalidHost as Response).status).toBe(403)
    expect(await (invalidHost as Response).json()).toMatchObject({
      error: { code: 'host_not_allowed' },
    })

    const invalidOrigin = await upgrade(request('/v1/responses', {
      host: '127.0.0.1:4399',
      origin: 'https://attacker.example',
    }))
    expect(invalidOrigin).toBeInstanceOf(Response)
    expect((invalidOrigin as Response).status).toBe(403)
    expect(await (invalidOrigin as Response).json()).toMatchObject({
      error: { code: 'origin_not_allowed' },
    })
  })

  test('rejects new upgrades after graceful shutdown begins', async () => {
    await closeResponsesWebSocketsGracefully()
    const result = await upgrade(request('/v1/responses'))
    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(503)
    expect(await (result as Response).json()).toMatchObject({
      error: { code: 'websocket_server_shutting_down' },
    })
  })

  test('closes an accepted upgrade that reaches open after shutdown begins', async () => {
    const accepted = await upgrade(request('/v1/responses')) as {
      context: Record<string, unknown>
    }
    await closeResponsesWebSocketsGracefully()
    const close = mock(() => {})

    responsesWebSocketOptions.open!({
      close,
      context: accepted.context,
      id: crypto.randomUUID(),
    } as unknown as Peer)

    expect(close).toHaveBeenCalledWith(1012, 'Copilot proxy shutting down')
  })
})

function request(path: string, headers: Record<string, string> = {}): ServerRequest {
  return new Request(`http://127.0.0.1:4399${path}`, {
    headers: {
      host: '127.0.0.1:4399',
      upgrade: 'websocket',
      ...headers,
    },
  }) as ServerRequest
}
