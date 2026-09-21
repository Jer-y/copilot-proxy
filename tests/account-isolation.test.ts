import { describe, expect, test } from 'bun:test'

import { createAccountContext } from '~/lib/account/context'
import { state } from '~/lib/state'
import { cacheModels, isModelRefreshScheduled, refreshModelsSafely, startModelRefresh, stopModelRefresh } from '~/lib/utils'
import { fetchAuthenticatedCopilot, getCopilotRecoveryStatus } from '~/services/copilot/authenticated-fetch'

import { makeModel } from './model-fixtures'

describe('multi-account runtime isolation', () => {
  test('keeps explicit catalog work bound to its account after replacing the default', async () => {
    const original = state.defaultAccount
    const first = createAccountContext({ id: 'first' })
    const second = createAccountContext({ id: 'second' })
    const firstModels = { object: 'list', data: [makeModel('first-model')] }
    const secondModels = { object: 'list', data: [makeModel('second-model')] }
    let completeFetch!: () => void
    const pending = new Promise<void>((resolve) => {
      completeFetch = resolve
    })
    try {
      state.defaultAccount = first
      const load = cacheModels(first, { fetchModels: async () => {
        await pending
        return firstModels
      } })
      state.defaultAccount = second
      await cacheModels(second, { fetchModels: async () => secondModels })
      completeFetch()
      await load
      expect(first.models).toBe(firstModels)
      expect(state.defaultAccount.models).toBe(secondModels)
      expect(await refreshModelsSafely(first, { fetchModels: async () => {
        throw new Error('offline')
      } })).toBe(false)
      expect(first.models).toBe(firstModels)
      expect(first.modelCatalogLifecycle?.consecutiveRefreshFailures).toBe(1)
      expect(second.modelCatalogLifecycle?.consecutiveRefreshFailures).toBe(0)
      startModelRefresh(first, 60_000)
      startModelRefresh(second, 60_000)
      stopModelRefresh(first)
      expect(isModelRefreshScheduled(first)).toBe(false)
      expect(isModelRefreshScheduled(second)).toBe(true)
    }
    finally {
      completeFetch()
      stopModelRefresh(first)
      stopModelRefresh(second)
      state.defaultAccount = original
    }
  })

  test('keeps token refresh generations independent', async () => {
    const accountA = createAccountContext({ id: 'a', accountType: 'individual' })
    const accountB = createAccountContext({ id: 'b', accountType: 'enterprise' })

    await Promise.all([
      accountA.tokens.refreshWithRetry({
        fetchToken: async () => ({ token: 'token-a', refresh_in: 3600, expires_at: 2_000_000_000 }),
        useLock: false,
      }),
      accountB.tokens.refreshWithRetry({
        fetchToken: async () => ({ token: 'token-b', refresh_in: 3600, expires_at: 2_000_000_000 }),
        useLock: false,
      }),
    ])

    expect(accountA.copilotToken).toBe('token-a')
    expect(accountB.copilotToken).toBe('token-b')
    expect(accountA.tokens.getStatus().generation).toBe(1)
    expect(accountB.tokens.getStatus().generation).toBe(1)
  })

  test('does not let one account global circuit reject another account', async () => {
    const accountA = createAccountContext({ id: 'a', accountType: 'individual' })
    const accountB = createAccountContext({ id: 'b', accountType: 'enterprise' })
    const forbidden = () => new Response('Forbidden', {
      status: 403,
      headers: {
        'content-type': 'text/plain',
        'x-github-request-id': crypto.randomUUID(),
      },
    })

    for (const model of ['model-a', 'model-b']) {
      await fetchAuthenticatedCopilot(accountA, {
        endpoint: '/responses',
        model,
        request: async () => forbidden(),
      }, {
        refreshToken: async snapshot => ({ generation: snapshot.generation, outcome: 'refreshed' }),
      })
    }

    expect(getCopilotRecoveryStatus(accountA).globalCircuit.phase).toBe('open')
    expect(getCopilotRecoveryStatus(accountB).globalCircuit.phase).toBe('closed')
    const healthy = await fetchAuthenticatedCopilot(accountB, {
      endpoint: '/responses',
      model: 'healthy',
      request: async () => new Response('ok'),
    })
    expect(healthy.status).toBe(200)
  })
})
