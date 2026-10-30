import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import consola from 'consola'

import { createAccountContext } from '~/lib/account/context'
import { AsyncConcurrencyLimiter } from '~/lib/concurrency-limiter'
import { state } from '~/lib/state'
import { cacheModels, refreshModelsSafely } from '~/lib/utils'
import { fetchAuthenticatedCopilot, getCopilotRecoveryStatus } from '~/services/copilot/authenticated-fetch'
import { getModels } from '~/services/copilot/get-models'
import { makeModel } from './model-fixtures'

const originalFetch = globalThis.fetch
const originalLimiter = state.concurrencyLimiter
const originalModels = state.defaultAccount.models

describe('Copilot model inventory', () => {
  beforeEach(() => {
    state.defaultAccount.accountType = 'individual'
    state.defaultAccount.copilotToken = 'copilot-token'
    state.defaultAccount.githubToken = 'github-token'
    state.defaultAccount.vsCodeVersion = '1.0.0'
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
  })

  afterEach(() => {
    state.concurrencyLimiter = originalLimiter
    state.defaultAccount.models = originalModels
    globalThis.fetch = originalFetch
  })

  test('preserves Codex client headers and releases the limiter before GitHub-token fallback', async () => {
    const fetchMock = mock(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('user-agent')).toBe(headers.has('copilot-integration-id')
        ? 'GitHubCopilotChat/0.26.7'
        : 'vscode_codex/0.162.1')
      const authorization = headers.get('authorization')
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
    expect(fetchMock).toHaveBeenCalledTimes(3)
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
    }, {
      authorization: 'Bearer work-copilot-token',
      url: 'https://api.enterprise.githubcopilot.com/models',
    }])
    expect(account.recovery.metrics.upstreamAttempts).toBe(2)
    expect(state.defaultAccount.recovery.metrics.upstreamAttempts).toBe(defaultAttemptsBefore)
  })

  test('supplements only fetched Google entries and keeps primary metadata for duplicate IDs', async () => {
    const primary = makeModel('primary-model', ['/responses'])
    const duplicate = { ...makeModel('shared-model', ['/chat/completions']), vendor: 'Google' }
    const gemini = { ...makeModel('google-live-model', ['/chat/completions']), vendor: 'Google' }
    const legacyOnly = makeModel('other-legacy-model', ['/chat/completions'])
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => Response.json({
      object: 'list',
      data: new Headers(init?.headers).has('copilot-integration-id')
        ? [gemini, { ...duplicate, supported_endpoints: ['/responses'] }, legacyOnly]
        : [primary, duplicate],
    })) as unknown as typeof fetch

    const models = await getModels()
    expect(models.data).toEqual([primary, duplicate, gemini])
    expect(models.vscodeChatModelIds).toEqual([gemini.id])
  })

  test.each([
    { failure: 'HTTP rejection', respond: () => new Response('private upstream body', { status: 503 }) },
    { failure: 'network error', respond: () => { throw new TypeError('private connection details') } },
    { failure: 'invalid JSON', respond: () => new Response('invalid json') },
    { failure: 'missing data array', respond: () => Response.json({ object: 'list' }) },
  ])('publishes the primary startup catalog after a supplementary $failure', async ({ respond }) => {
    const primary = { object: 'list', data: [makeModel('primary-model', ['/responses'])] }
    const warning = spyOn(consola, 'warn')
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).has('copilot-integration-id')
        ? respond()
        : Response.json(primary),
    ) as unknown as typeof fetch

    try {
      await cacheModels(state.defaultAccount)
      expect(state.defaultAccount.models).toEqual(primary)
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning.mock.calls[0]?.[0]).toContain('using the primary catalog')
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private')
      expect(state.concurrencyLimiter?.snapshot()).toMatchObject({
        active: 0,
        totalAcquired: 2,
        totalReleased: 2,
      })
    }
    finally {
      warning.mockRestore()
    }
  })

  test('publishes the GitHub-token primary catalog when its supplement is rejected', async () => {
    const primary = { object: 'list', data: [makeModel('primary-model', ['/responses'])] }
    const requests: string[] = []
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      requests.push(headers.get('authorization')!)
      if (headers.get('authorization') === 'Bearer copilot-token')
        return Response.json({ error: { code: 'permission_denied' } }, { status: 403 })
      return headers.has('copilot-integration-id')
        ? new Response('catalog unavailable', { status: 503 })
        : Response.json(primary)
    }) as unknown as typeof fetch

    await cacheModels(state.defaultAccount)
    expect(state.defaultAccount.models).toEqual(primary)
    expect(requests).toEqual(['Bearer copilot-token', 'Bearer github-token', 'Bearer github-token'])
    expect(state.concurrencyLimiter?.snapshot()).toMatchObject({
      active: 0,
      totalAcquired: 1,
      totalReleased: 1,
    })
  })

  test('replaces stale supplementary entries and their identity mapping when refresh degrades', async () => {
    const primary = makeModel('primary-model', ['/responses'])
    const gemini = { ...makeModel('google-live-model', ['/chat/completions']), vendor: 'Google' }
    state.defaultAccount.models = { object: 'list', data: [primary, gemini], vscodeChatModelIds: [gemini.id] }
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).has('copilot-integration-id')
        ? new Response('catalog unavailable', { status: 503 })
        : Response.json({ object: 'list', data: [primary] }),
    ) as unknown as typeof fetch

    expect(await refreshModelsSafely(state.defaultAccount)).toBe(true)
    expect(state.defaultAccount.models).toEqual({ object: 'list', data: [primary] })
    expect(state.defaultAccount.models?.vscodeChatModelIds).toBeUndefined()
  })

  test.each([401, 403])('keeps refreshing the primary catalog after persistent supplementary %i responses', async (status) => {
    const account = createAccountContext({ id: `supplementary-${status}` })
    account.copilotToken = 'copilot-token'
    const refresh = spyOn(account.tokens, 'refreshAfterFailure').mockImplementation(async () => ({ outcome: 'refreshed', generation: 1 }))
    const primary = { object: 'list', data: [makeModel('primary-model', ['/responses'])] }
    let primaryRequests = 0
    let supplementaryRequests = 0
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).has('copilot-integration-id')) {
        supplementaryRequests++
        return new Response('Forbidden', { status, headers: { 'content-type': 'text/plain', 'x-github-request-id': 'test-request-id' } })
      }
      primaryRequests++
      return Response.json(primary)
    }) as unknown as typeof fetch

    try {
      for (let attempt = 0; attempt < 3; attempt++)
        expect(await getModels(account)).toEqual(primary)

      expect(primaryRequests).toBe(3)
      expect(supplementaryRequests).toBe(2)
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(getCopilotRecoveryStatus(account)).toMatchObject({
        globalCircuit: { phase: 'closed' },
        scopes: { open: 1 },
        metrics: { replayAttempts: 1, replayFailures: 1, scopeCircuitOpens: 1, globalCircuitOpens: 0 },
      })
      expect(state.concurrencyLimiter?.snapshot()).toMatchObject({ active: 0, totalAcquired: 4, totalReleased: 4 })
    }
    finally {
      refresh.mockRestore()
    }
  })

  test.each(['before', 'after'])('excludes supplementary failures from global aggregation when another scope fails %s them', async (order) => {
    const account = createAccountContext({ id: `supplementary-global-${order}` })
    account.copilotToken = 'copilot-token'
    const refresh = spyOn(account.tokens, 'refreshAfterFailure').mockImplementation(async () => ({ outcome: 'refreshed', generation: 1 }))
    const primary = { object: 'list', data: [makeModel('primary-model', ['/responses'])] }
    const forbidden = () => new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain', 'x-github-request-id': 'test-request-id' } })
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) =>
      new Headers(init?.headers).has('copilot-integration-id') ? forbidden() : Response.json(primary),
    ) as unknown as typeof fetch
    const failInferenceScope = async () => {
      const response = await fetchAuthenticatedCopilot(account, {
        endpoint: '/responses',
        model: 'rejected-model',
        request: async () => forbidden(),
      })
      expect(response.status).toBe(403)
      await response.body?.cancel()
    }

    try {
      if (order === 'before')
        await failInferenceScope()
      expect(await getModels(account)).toEqual(primary)
      if (order === 'after')
        await failInferenceScope()

      expect(await getModels(account)).toEqual(primary)
      const healthy = await fetchAuthenticatedCopilot(account, {
        endpoint: '/responses',
        model: 'healthy-model',
        request: async () => new Response('healthy'),
      })
      expect(await healthy.text()).toBe('healthy')
      expect(getCopilotRecoveryStatus(account)).toMatchObject({
        globalCircuit: { phase: 'closed' },
        scopes: { open: 2 },
        metrics: { globalCircuitOpens: 0, replayFailures: 2 },
      })
    }
    finally {
      refresh.mockRestore()
    }
  })

  test('still rejects startup when both primary authentication paths fail', async () => {
    globalThis.fetch = mock(async () =>
      new Response('catalog unavailable', { status: 503 }),
    ) as unknown as typeof fetch

    await expect(cacheModels(state.defaultAccount)).rejects.toThrow('Failed to get models using GitHub-token fallback')
    expect(state.defaultAccount.models).toBeUndefined()
  })
})
