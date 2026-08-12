import type { Peer } from 'crossws'
import type { ServerRequest } from 'srvx'
import type { AccountsConfiguration } from '~/lib/account/types'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { AccountRegistry } from '~/lib/account/registry'
import { state } from '~/lib/state'
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

  test('rejects an explicitly selected unavailable account before the 101 upgrade', async () => {
    const originalAccounts = state.accounts
    const registry = createAccountRegistry()
    state.accounts = registry
    try {
      const unavailable = await upgrade(request('/v1/responses', {
        'x-copilot-account': 'work',
      }))
      expect(unavailable).toBeInstanceOf(Response)
      expect((unavailable as Response).status).toBe(503)
      expect(await (unavailable as Response).json()).toMatchObject({
        error: { code: 'copilot_account_unavailable' },
      })

      const available = await upgrade(request('/v1/responses', {
        'x-copilot-account': 'personal',
      })) as { context: Record<string, unknown> }
      expect(available.context.accountId).toBe('personal')
      const releaseReservation = available.context.releaseConnectionReservation
      if (typeof releaseReservation === 'function')
        releaseReservation()
    }
    finally {
      state.accounts = originalAccounts
    }
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

function createAccountRegistry(): AccountRegistry {
  const configuration: AccountsConfiguration = {
    version: 1,
    revision: 1,
    defaultAccount: 'personal',
    requiredRoutes: [],
    accounts: [
      { id: 'personal', accountType: 'individual', githubLogin: 'alice', githubUserId: 1 },
      { id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 },
    ],
    routes: [],
  }
  const registry = new AccountRegistry(configuration)
  registry.get('personal')!.availability = 'ready'
  registry.get('work')!.availability = 'unavailable'
  registry.get('work')!.unavailableReason = 'token_failed'
  return registry
}
