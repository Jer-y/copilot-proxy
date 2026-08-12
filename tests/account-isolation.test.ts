import { describe, expect, test } from 'bun:test'

import { createAccountContext } from '~/lib/account/context'
import { fetchAuthenticatedCopilot, getCopilotRecoveryStatus } from '~/services/copilot/authenticated-fetch'

describe('multi-account runtime isolation', () => {
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
