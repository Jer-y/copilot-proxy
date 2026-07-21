import type { ModelsResponse } from '~/services/copilot/get-models'

import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test'

import { AsyncConcurrencyLimiter } from '~/lib/concurrency-limiter'
import { state } from '~/lib/state'
import { refreshTokenWithRetry, startCopilotTokenRefresh, stopCopilotTokenRefresh } from '~/lib/token'
import { refreshModelsSafely } from '~/lib/utils'
import { DIAGNOSTICS_USAGE_TIMEOUT_MS } from '~/routes/diagnostics/route'
import { resetUsageCacheForTests } from '~/routes/usage/route'
import { server } from '~/server'
import { resetCopilotRecoveryStateForTests } from '~/services/copilot/authenticated-fetch'

const originalFetch = globalThis.fetch
const usagePayload = {
  analytics_tracking_id: 'must-not-appear-tracking-id',
  copilot_plan: 'individual',
  organization_login_list: ['must-not-appear-org-login'],
  organization_list: [{ name: 'must-not-appear-org' }],
  quota_reset_date: '2026-08-01',
  quota_snapshots: {
    chat: createQuota(80, 20),
    completions: createQuota(100, 0, true),
    premium_interactions: createQuota(75, 25),
    future_private_bucket: {
      nested_private_marker: 'must-not-appear-future-bucket',
    },
  },
}
const diagnosticsUsagePayload = {
  copilot_plan: usagePayload.copilot_plan,
  quota_reset_date: usagePayload.quota_reset_date,
  quota_snapshots: {
    chat: publicQuota(usagePayload.quota_snapshots.chat),
    completions: publicQuota(usagePayload.quota_snapshots.completions),
    premium_interactions: publicQuota(usagePayload.quota_snapshots.premium_interactions),
  },
}
const fetchMock = mock(async (
  _input: Parameters<typeof fetch>[0],
  _init?: RequestInit,
): Promise<Response> => Response.json(usagePayload))

describe('/diagnostics', () => {
  const original = {
    accountType: state.accountType,
    concurrencyLimiter: state.concurrencyLimiter,
    copilotToken: state.copilotToken,
    githubToken: state.githubToken,
    modelCatalogLifecycle: state.modelCatalogLifecycle,
    models: state.models,
    nativeServiceInstanceToken: state.nativeServiceInstanceToken,
    vsCodeVersion: state.vsCodeVersion,
  }

  beforeEach(() => {
    stopCopilotTokenRefresh()
    resetCopilotRecoveryStateForTests()
    resetUsageCacheForTests()
    fetchMock.mockClear()
    fetchMock.mockImplementation(async (): Promise<Response> => Response.json(usagePayload))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    state.accountType = 'individual'
    state.concurrencyLimiter = undefined
    state.copilotToken = undefined
    state.githubToken = 'must-not-appear-github-token'
    state.modelCatalogLifecycle = undefined
    state.models = undefined
    state.nativeServiceInstanceToken = 'must-not-appear-instance-token'
    state.vsCodeVersion = '1.0.0'
  })

  afterEach(() => {
    stopCopilotTokenRefresh()
    resetCopilotRecoveryStateForTests()
    resetUsageCacheForTests()
    globalThis.fetch = originalFetch
    state.accountType = original.accountType
    state.concurrencyLimiter = original.concurrencyLimiter
    state.copilotToken = original.copilotToken
    state.githubToken = original.githubToken
    state.modelCatalogLifecycle = original.modelCatalogLifecycle
    state.models = original.models
    state.nativeServiceInstanceToken = original.nativeServiceInstanceToken
    state.vsCodeVersion = original.vsCodeVersion
  })

  test('returns a passive degraded snapshot without exposing credentials', async () => {
    state.copilotToken = 'must-not-appear-copilot-token'

    const response = await server.request('/diagnostics')
    const text = await response.text()
    const body = JSON.parse(text) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-copilot-proxy-instance-token')).toBeNull()
    expect(body).toMatchObject({
      status: 'degraded',
      readiness: {
        status: 'degraded',
        accountType: 'individual',
        upstreamHost: 'api.githubcopilot.com',
        reasons: expect.arrayContaining([
          'copilot_token_refresh_unscheduled',
          'model_catalog_unavailable',
        ]),
      },
      usage: { status: 'available', data: diagnosticsUsagePayload },
    })
    expect(Array.isArray(body.models)).toBe(true)
    expect(body).not.toHaveProperty('deployment')
    expect(Number.isNaN(Date.parse(String(body.generated_at)))).toBe(false)
    expect(text).not.toContain('must-not-appear')
    expect(text).not.toContain('analytics_tracking_id')
    expect(text).not.toContain('organization_login_list')
    expect(text).not.toContain('nested_private_marker')
    expect(text).not.toContain('future_private_bucket')
  })

  test('reports ready auth, recovery, concurrency, catalog, and usage state', async () => {
    state.accountType = 'business'
    await configureReadyState()
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 4,
      maxQueue: 8,
      queueTimeoutMs: 1_000,
    })

    const response = await server.request('/diagnostics')
    const body = await response.json() as { models: unknown[] } & Record<string, unknown>

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      status: 'ready',
      readiness: {
        status: 'ready',
        accountType: 'business',
        upstreamHost: 'api.business.githubcopilot.com',
        modelsAvailable: 1,
        modelCatalog: {
          status: 'fresh',
          consecutiveRefreshFailures: 0,
          lastRefreshSuccessAt: 1_100,
        },
        token: { tokenAvailable: true, refreshScheduled: true },
        recovery: { globalCircuit: { phase: 'closed' } },
        concurrency: {
          enabled: true,
          maxConcurrency: 4,
          maxQueue: 8,
          active: 0,
          queued: 0,
        },
      },
      usage: { status: 'available', data: diagnosticsUsagePayload },
    })
    expect(body.models).toHaveLength(1)
    expect(body.models[0]).toMatchObject({
      id: 'gpt-test',
      displayName: 'GPT Test',
      vendor: 'OpenAI',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      routes: {
        chatCompletions: { mode: 'unsupported' },
        responsesHttp: { mode: 'direct' },
        responsesWebSocket: { mode: 'direct' },
        anthropicMessages: { mode: 'translated' },
      },
    })
    expect(body.models[0]).not.toHaveProperty('features')
    expect(body.models[0]).not.toHaveProperty('supportedEndpoints')
    expect(body.models[0]).not.toHaveProperty('maxPromptTokens')
  })

  test('marks a retained model snapshot stale after its latest refresh fails', async () => {
    await configureReadyState()
    const previousModels = state.models
    const times = [2_000, 2_100]

    expect(await refreshModelsSafely(async () => {
      throw new Error('forced model refresh failure')
    }, { now: () => times.shift() ?? 0 })).toBe(false)

    const response = await server.request('/diagnostics')
    const body = await response.json() as {
      generated_at: string
      models: Array<{ id: string }>
      readiness: {
        modelCatalog: Record<string, unknown>
        reasons: string[]
        status: string
        warnings: string[]
      }
      status: string
    }

    expect(response.status).toBe(200)
    expect(state.models).toBe(previousModels)
    expect(body).toMatchObject({
      status: 'degraded',
      readiness: {
        status: 'ready',
        warnings: expect.arrayContaining(['model_catalog_stale']),
        modelCatalog: {
          status: 'stale',
          consecutiveRefreshFailures: 1,
          lastRefreshAttemptAt: 2_000,
          lastRefreshFailureAt: 2_100,
          lastRefreshSuccessAt: 1_100,
        },
      },
      models: [{ id: 'gpt-test' }],
    })
    expect(body.readiness.reasons).not.toContain('model_catalog_stale')
    expect(Date.parse(body.generated_at)).toBeGreaterThan(2_100)
  })

  test('omits models disabled for user selection from diagnostics profiles', async () => {
    await configureReadyState()
    const visible = state.models?.data[0]
    if (!visible)
      throw new Error('Expected the ready-state model fixture')
    state.models?.data.push({
      ...visible,
      id: 'trajectory-compaction',
      name: 'Trajectory Compaction',
      model_picker_enabled: false,
    })

    const response = await server.request('/diagnostics')
    const body = await response.json() as { models: Array<{ id: string }> }

    expect(response.status).toBe(200)
    expect(body.models.map(model => model.id)).toEqual(['gpt-test'])
  })

  test('degrades diagnostics when the catalog contains only hidden models without changing readyz semantics', async () => {
    await configureReadyState()
    const hidden = state.models?.data[0]
    if (!hidden)
      throw new Error('Expected the ready-state model fixture')
    hidden.model_picker_enabled = false

    const diagnosticsResponse = await server.request('/diagnostics')
    const diagnosticsBody = await diagnosticsResponse.json() as {
      models: unknown[]
      readiness: {
        modelCatalog: { status: string }
        modelsAvailable: number
        reasons: string[]
        status: string
      }
      status: string
    }
    const readinessResponse = await server.request('/readyz')
    const readinessBody = await readinessResponse.json() as {
      modelsAvailable: number
      status: string
    }

    expect(diagnosticsResponse.status).toBe(200)
    expect(diagnosticsBody).toMatchObject({
      status: 'degraded',
      readiness: {
        modelCatalog: { status: 'unavailable' },
        status: 'degraded',
        modelsAvailable: 0,
        reasons: expect.arrayContaining(['model_catalog_unavailable']),
      },
      models: [],
    })
    expect(readinessResponse.status).toBe(200)
    expect(readinessBody).toMatchObject({
      status: 'ready',
      modelsAvailable: 1,
    })
  })

  test('shares the usage cache and single-flight path with the legacy usage endpoint', async () => {
    const diagnosticsResponse = await server.request('/diagnostics')
    const usageResponse = await server.request('/usage')
    const usageText = await usageResponse.text()

    expect(diagnosticsResponse.status).toBe(200)
    expect(usageResponse.status).toBe(200)
    expect(JSON.parse(usageText)).toEqual(diagnosticsUsagePayload)
    expect(usageText).not.toContain('analytics_tracking_id')
    expect(usageText).not.toContain('organization_login_list')
    expect(usageText).not.toContain('organization_list')
    expect(usageText).not.toContain('nested_private_marker')
    expect(usageText).not.toContain('future_private_bucket')
    expect(usageText).not.toContain('must-not-appear')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('serves only the exact optional trailing-slash diagnostics and usage aliases', async () => {
    for (const path of ['/diagnostics', '/diagnostics/', '/usage', '/usage/']) {
      const response = await server.request(path, {
        headers: { Origin: 'https://jer-y.github.io' },
      })

      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      expect(response.headers.get('access-control-allow-origin')).toBe('https://jer-y.github.io')
    }

    for (const path of ['/diagnostics//', '/diagnostics/status', '/usage//', '/usage/status']) {
      const response = await server.request(path)
      expect(response.status).toBe(404)
    }

    for (const path of ['/diagnostics/', '/usage/']) {
      const response = await server.request(path, {
        headers: { Origin: 'https://attacker.example' },
      })
      expect(response.status).toBe(403)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
    }

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('uses one model catalog snapshot while awaiting usage', async () => {
    await configureReadyState()
    const initialModel = state.models?.data[0]
    if (!initialModel)
      throw new Error('Expected the ready-state model fixture')

    let resolveUsage!: (response: Response) => void
    fetchMock.mockImplementation(async () => await new Promise<Response>((resolve) => {
      resolveUsage = resolve
    }))

    const diagnosticsPromise = server.request('/diagnostics')
    for (let tick = 0; tick < 10 && fetchMock.mock.calls.length === 0; tick++)
      await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    state.models = {
      object: 'list',
      data: [
        { ...initialModel, id: 'next-generation-a', name: 'Next Generation A' },
        { ...initialModel, id: 'next-generation-b', name: 'Next Generation B' },
      ],
    }
    resolveUsage(Response.json(usagePayload))

    const response = await diagnosticsPromise
    const body = await response.json() as {
      models: Array<{ id: string }>
      readiness: { modelsAvailable: number }
    }

    expect(response.status).toBe(200)
    expect(body.readiness.modelsAvailable).toBe(1)
    expect(body.models.map(model => model.id)).toEqual(['gpt-test'])
  })

  test('keeps diagnostics available when the usage request fails', async () => {
    fetchMock.mockImplementation(async () => Response.json(
      { error: 'upstream-secret-detail' },
      { status: 503 },
    ))

    const response = await server.request('/diagnostics')
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({
      status: 'degraded',
      usage: {
        status: 'unavailable',
        error: 'Failed to fetch Copilot usage',
      },
    })
    expect(text).not.toContain('upstream-secret-detail')
  })

  test('keeps a slow usage lookup available after the former two-second deadline', async () => {
    vi.useFakeTimers()
    try {
      let resolveUsage!: (response: Response) => void
      fetchMock.mockImplementation(async () => await new Promise<Response>((resolve) => {
        resolveUsage = resolve
      }))

      const diagnosticsPromise = server.request('/diagnostics')
      for (let tick = 0; tick < 10 && vi.getTimerCount() === 0; tick++)
        await Promise.resolve()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(2_500)
      resolveUsage(Response.json(usagePayload))
      const diagnosticsResponse = await diagnosticsPromise

      expect(diagnosticsResponse.status).toBe(200)
      expect(await diagnosticsResponse.json()).toMatchObject({
        usage: {
          status: 'available',
          data: diagnosticsUsagePayload,
        },
      })
    }
    finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test('bounds a hanging usage lookup without cancelling its shared single-flight', async () => {
    vi.useFakeTimers()
    try {
      let resolveUsage!: (response: Response) => void
      let upstreamSignal: AbortSignal | null | undefined
      const pendingUsage = new Promise<Response>((resolve) => {
        resolveUsage = resolve
      })
      fetchMock.mockImplementation(async (_input, init): Promise<Response> => {
        upstreamSignal = init?.signal
        return await pendingUsage
      })

      const diagnosticsPromise = server.request('/diagnostics')
      for (let tick = 0; tick < 10 && vi.getTimerCount() === 0; tick++)
        await Promise.resolve()
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      vi.advanceTimersByTime(DIAGNOSTICS_USAGE_TIMEOUT_MS)
      const diagnosticsResponse = await diagnosticsPromise

      expect(diagnosticsResponse.status).toBe(200)
      expect(await diagnosticsResponse.json()).toMatchObject({
        usage: {
          status: 'unavailable',
          error: 'Failed to fetch Copilot usage',
        },
      })
      expect(upstreamSignal?.aborted).toBe(false)

      const usageResponsePromise = server.request('/usage')
      resolveUsage(Response.json(usagePayload))
      const usageResponse = await usageResponsePromise

      expect(usageResponse.status).toBe(200)
      expect(await usageResponse.json()).toEqual(diagnosticsUsagePayload)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

async function configureReadyState(): Promise<void> {
  await refreshTokenWithRetry({
    fetchToken: async () => ({
      token: 'must-not-appear-ready-token',
      refresh_in: 3_600,
      expires_at: Date.now() + 3_600_000,
    }),
    failureState: { consecutiveFailures: 0 },
  })
  state.models = {
    object: 'list',
    data: [{
      id: 'gpt-test',
      name: 'GPT Test',
      object: 'model',
      version: '1',
      vendor: 'OpenAI',
      preview: false,
      model_picker_enabled: true,
      supported_endpoints: ['/responses', 'ws:/responses'],
      capabilities: {
        family: 'gpt-test',
        limits: {
          max_context_window_tokens: 128_000,
          max_output_tokens: 8_192,
        },
        object: 'model_capabilities',
        supports: {
          tool_calls: true,
          vision: true,
        },
        tokenizer: 'o200k_base',
        type: 'chat',
      },
    }],
  } satisfies ModelsResponse
  state.modelCatalogLifecycle = {
    consecutiveRefreshFailures: 0,
    lastRefreshAttemptAt: 1_000,
    lastRefreshSuccessAt: 1_100,
  }
  startCopilotTokenRefresh(3_600)
}

function createQuota(percentRemaining: number, used: number, unlimited = false) {
  return {
    entitlement: 100,
    overage_count: 0,
    overage_permitted: false,
    percent_remaining: percentRemaining,
    quota_id: 'quota',
    quota_remaining: 100 - used,
    remaining: 100 - used,
    unlimited,
    nested_private_marker: 'must-not-appear-nested',
  }
}

function publicQuota(quota: ReturnType<typeof createQuota>) {
  return {
    entitlement: quota.entitlement,
    percent_remaining: quota.percent_remaining,
    remaining: quota.remaining,
    unlimited: quota.unlimited,
  }
}
