import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { createAccountContext } from '~/lib/account/context'
import { AsyncConcurrencyLimiter } from '~/lib/concurrency-limiter'
import { state } from '~/lib/state'
import { getModels } from '~/services/copilot/get-models'

const originalFetch = globalThis.fetch
const originalLimiter = state.concurrencyLimiter

describe('Copilot model inventory', () => {
  beforeEach(() => {
    state.accountType = 'individual'
    state.copilotToken = 'copilot-token'
    state.githubToken = 'github-token'
    state.vsCodeVersion = '1.0.0'
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
  })

  afterEach(() => {
    state.concurrencyLimiter = originalLimiter
    globalThis.fetch = originalFetch
  })

  test('releases the authenticated limiter lease before developer-CLI fallback', async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer copilot-token')
        return new Response('primary rejected', { status: 403 })
      if (authorization === 'Bearer github-token') {
        return Response.json({
          object: 'list',
          data: [],
        })
      }
      throw new Error(`Unexpected authorization: ${authorization}`)
    })
    // @ts-expect-error test mock only needs the fetch call signature
    globalThis.fetch = fetchMock

    const models = await getModels()

    expect(models).toEqual({ object: 'list', data: [] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(state.concurrencyLimiter?.snapshot()).toMatchObject({
      active: 0,
      totalAcquired: 1,
      totalReleased: 1,
    })
  })

  test('uses the supplied account context for host, token, and recovery scope', async () => {
    const defaultAttemptsBefore = state.defaultAccount.recovery.metrics.upstreamAttempts
    const account = createAccountContext({ id: 'work', accountType: 'enterprise' })
    account.copilotToken = 'work-copilot-token'
    account.githubToken = 'work-github-token'
    account.vsCodeVersion = '1.0.0'
    const requests: Array<{ authorization: string | null, url: string }> = []
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        url: String(url),
      })
      return Response.json({ object: 'list', data: [] })
    }) as unknown as typeof fetch

    expect(await getModels(account)).toEqual({ object: 'list', data: [] })
    expect(requests).toEqual([{
      authorization: 'Bearer work-copilot-token',
      url: 'https://api.enterprise.githubcopilot.com/models',
    }])
    expect(account.recovery.metrics.upstreamAttempts).toBe(1)
    expect(state.defaultAccount.recovery.metrics.upstreamAttempts).toBe(defaultAttemptsBefore)
  })
})
