import type { ModelsResponse } from '~/services/copilot/get-models'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { AsyncConcurrencyLimiter } from '~/lib/concurrency-limiter'
import { state } from '~/lib/state'
import { refreshTokenWithRetry, startCopilotTokenRefresh, stopCopilotTokenRefresh } from '~/lib/token'
import { server } from '~/server'
import { fetchAuthenticatedCopilot, resetCopilotRecoveryStateForTests } from '~/services/copilot/authenticated-fetch'

describe('health routes', () => {
  const original = {
    accountType: state.accountType,
    concurrencyLimiter: state.concurrencyLimiter,
    copilotToken: state.copilotToken,
    models: state.models,
    nativeServiceInstanceToken: state.nativeServiceInstanceToken,
  }

  beforeEach(() => {
    stopCopilotTokenRefresh()
    resetCopilotRecoveryStateForTests()
    state.accountType = 'individual'
    state.concurrencyLimiter = undefined
    state.copilotToken = undefined
    state.models = undefined
    state.nativeServiceInstanceToken = undefined
  })

  afterEach(() => {
    stopCopilotTokenRefresh()
    resetCopilotRecoveryStateForTests()
    state.accountType = original.accountType
    state.concurrencyLimiter = original.concurrencyLimiter
    state.copilotToken = original.copilotToken
    state.models = original.models
    state.nativeServiceInstanceToken = original.nativeServiceInstanceToken
  })

  test('keeps liveness independent from upstream readiness', async () => {
    state.nativeServiceInstanceToken = 'must-not-appear-instance-token'
    const response = await server.request('/livez')
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-copilot-proxy-instance-token')).toBeNull()
    expect(text).not.toContain('must-not-appear-instance-token')
    expect(JSON.parse(text)).toEqual({ status: 'ok' })
  })

  test('reports passive readiness failures without exposing credentials', async () => {
    state.copilotToken = 'must-not-appear'
    const response = await server.request('/readyz')
    const text = await response.text()

    expect(response.status).toBe(503)
    expect(text).not.toContain('must-not-appear')
    expect(JSON.parse(text)).toMatchObject({
      status: 'degraded',
      reasons: expect.arrayContaining([
        'copilot_token_refresh_unscheduled',
        'model_catalog_unavailable',
      ]),
      upstreamHost: 'api.githubcopilot.com',
    })
  })

  test('reports ready state, token lifecycle, recovery metrics, and aggregate concurrency', async () => {
    state.accountType = 'enterprise'
    await configureReadyState()
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 4,
      maxQueue: 8,
      queueTimeoutMs: 1_000,
    })
    state.nativeServiceInstanceToken = 'must-not-appear-instance-token'

    const response = await server.request('/readyz')
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('x-copilot-proxy-instance-token')).toBeNull()
    expect(body).toMatchObject({
      status: 'ready',
      accountType: 'enterprise',
      upstreamHost: 'api.enterprise.githubcopilot.com',
      modelsAvailable: 1,
      token: {
        tokenAvailable: true,
        refreshScheduled: true,
      },
      recovery: {
        globalCircuit: { phase: 'closed' },
      },
      concurrency: {
        maxConcurrency: 4,
        maxQueue: 8,
        active: 0,
        queued: 0,
      },
    })
    expect(JSON.stringify(body)).not.toContain('test-token')
    expect(JSON.stringify(body)).not.toContain('must-not-appear-instance-token')
  })

  test('reports an expired token as degraded even while a later refresh is scheduled', async () => {
    await configureReadyState(Date.now() - 1_000)

    const response = await server.request('/readyz')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      status: 'degraded',
      reasons: expect.arrayContaining(['copilot_token_expired']),
      token: { expiresInMs: 0 },
    })
  })

  test('keeps readiness while a valid token refresh is in flight between timers', async () => {
    await configureReadyState()
    stopCopilotTokenRefresh()
    let resolveRefresh!: (value: {
      token: string
      refresh_in: number
      expires_at: number
    }) => void
    const inFlight = refreshTokenWithRetry({
      fetchToken: () => new Promise((resolve) => {
        resolveRefresh = resolve
      }),
      useLock: true,
    })

    try {
      const response = await server.request('/readyz')
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        status: 'ready',
        token: {
          refreshInFlight: true,
          refreshScheduled: false,
        },
      })
    }
    finally {
      resolveRefresh({
        token: 'refreshed-test-token',
        refresh_in: 3_600,
        expires_at: Date.now() + 3_600_000,
      })
      await inFlight
    }
  })

  test('returns 503 and Retry-After while the global recovery circuit is open', async () => {
    await configureReadyState()
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    for (const model of ['gpt-health-a', 'gpt-health-b']) {
      await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => new Response('Forbidden\n', {
          status: 403,
          headers: {
            'Content-Type': 'text/plain',
            'X-GitHub-Request-Id': crypto.randomUUID(),
          },
        }),
      }, { refreshToken })
    }

    const response = await server.request('/readyz')
    expect(response.status).toBe(503)
    expect(response.headers.get('retry-after')).toBe('60')
    expect(await response.json()).toMatchObject({
      status: 'degraded',
      reasons: expect.arrayContaining(['copilot_upstream_circuit_not_closed']),
      recovery: { globalCircuit: { phase: 'open' } },
    })
  })

  test('returns ready while an expired global cooldown is probe-eligible', async () => {
    await configureReadyState()
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const cooldownStartedAt = Date.now() - 60_001
    for (const model of ['gpt-health-half-open-a', 'gpt-health-half-open-b']) {
      await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => new Response('Forbidden\n', {
          status: 403,
          headers: {
            'Content-Type': 'text/plain',
            'X-GitHub-Request-Id': crypto.randomUUID(),
          },
        }),
      }, { now: () => cooldownStartedAt, refreshToken })
    }

    const response = await server.request('/readyz')
    const body = await response.json() as {
      reasons: string[]
      recovery: { globalCircuit: { phase: string } }
      status: string
    }
    expect(response.status).toBe(200)
    expect(response.headers.get('retry-after')).toBeNull()
    expect(body.status).toBe('ready')
    expect(body.reasons).not.toContain('copilot_upstream_circuit_not_closed')
    expect(body.recovery.globalCircuit.phase).toBe('half_open')
  })
})

async function configureReadyState(expiresAt = Date.now() + 3_600_000): Promise<void> {
  await refreshTokenWithRetry({
    fetchToken: async () => ({
      token: 'test-token',
      refresh_in: 3_600,
      expires_at: expiresAt,
    }),
    failureState: { consecutiveFailures: 0 },
  })
  state.models = {
    object: 'list',
    data: [{ id: 'gpt-test' }],
  } as ModelsResponse
  startCopilotTokenRefresh(3_600)
}
