import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

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
})
