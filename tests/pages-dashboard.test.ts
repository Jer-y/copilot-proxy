import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

import { describe, expect, test } from 'bun:test'

import { buildDiagnosticsDashboardUrl } from '~/start'

const PAGE_PATH = new URL('../pages/index.html', import.meta.url)
const START_PATH = new URL('../src/start.ts', import.meta.url)
const ELEMENT_IDS = [
  'endpoint-form',
  'endpoint',
  'refresh-button',
  'error-banner',
  'status-dot',
  'status-label',
  'status-summary',
  'generated-at',
  'reason-list',
  'account-type',
  'upstream-host',
  'auth-status',
  'auth-detail',
  'recovery-status',
  'recovery-detail',
  'concurrency-status',
  'concurrency-detail',
  'model-count',
  'model-rows',
  'quota-state',
  'quota-summary',
  'quota-grid',
] as const

describe('hosted diagnostics dashboard behavior', () => {
  test('builds a hosted dashboard link with an encoded local diagnostics endpoint', () => {
    const dashboardUrl = buildDiagnosticsDashboardUrl('http://[::1]:4399')

    expect(dashboardUrl).toBe('https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2F%5B%3A%3A1%5D%3A4399%2Fdiagnostics')
    expect(new URL(dashboardUrl).searchParams.get('endpoint')).toBe('http://[::1]:4399/diagnostics')
  })

  test('wires the hosted dashboard URL into the server startup banner', async () => {
    const startSource = await readFile(START_PATH, 'utf8')

    expect(startSource).toContain('const dashboardUrl = buildDiagnosticsDashboardUrl(serverUrl)')
    expect(startSource).toContain('Diagnostics Dashboard: $' + '{dashboardUrl}')
    expect(startSource).not.toContain('`🌐 Diagnostics: $' + '{serverUrl}/diagnostics`')
  })

  test('renders a legacy /usage payload as quota-only data without claiming readiness', async () => {
    const dashboard = await createDashboard(
      async () => Response.json(createLegacyUsage('individual', 75)),
      'http://old-proxy.example/usage/',
    )

    await waitFor(() => dashboard.element('status-label').textContent === 'Quota data only')

    expect(dashboard.element('status-label').textContent).toBe('Quota data only')
    expect(dashboard.element('status-summary').textContent).toContain('does not report readiness')
    expect(dashboard.element('reason-list').children[0]?.textContent).toBe('Proxy readiness was not checked')
    expect(dashboard.element('account-type').textContent).toBe('Unknown account')
    expect(dashboard.element('model-count').textContent).toBe('Model catalog unavailable')
    expect(dashboard.element('quota-state').textContent).toBe('Usage available')
    expect(dashboard.element('quota-grid').children[0]?.children[1]?.textContent).toBe('75% left')
  })

  test('renders unlimited quotas whose remaining count exceeds a zero entitlement', async () => {
    const cases = [
      {
        endpoint: 'http://old-proxy.example/usage',
        expectedStatus: 'Quota data only',
        payload: () => {
          const usage = createLegacyUsage('individual', 75)
          Object.assign(usage.quota_snapshots.completions, {
            entitlement: 0,
            remaining: 1,
            unlimited: true,
          })
          return usage
        },
      },
      {
        endpoint: 'http://proxy.example/diagnostics',
        expectedStatus: 'Proxy is ready',
        payload: () => {
          const diagnostics = createDiagnostics('model-a', 80)
          Object.assign(diagnostics.usage.data.quota_snapshots.completions, {
            entitlement: 0,
            remaining: 1,
            unlimited: true,
          })
          return diagnostics
        },
      },
    ]

    for (const scenario of cases) {
      const dashboard = await createDashboard(
        async () => Response.json(scenario.payload()),
        scenario.endpoint,
      )

      await waitFor(() => dashboard.element('status-label').textContent === scenario.expectedStatus)

      const completionsCard = dashboard.element('quota-grid').children[2]
      expect(dashboard.element('quota-state').textContent).toBe('Usage available')
      expect(completionsCard?.children[0]?.textContent).toBe('Completions')
      expect(completionsCard?.children[1]?.textContent).toBe('Unlimited')
      expect(completionsCard?.children[3]?.textContent).toBe('No metered entitlement limit')
    }
  })

  test('only fetches exact diagnostics or legacy usage endpoints without credentials or redirects', async () => {
    const calls: Array<{ init?: RequestInit, url: string }> = []
    const dashboard = await createDashboard(
      async (input, init) => {
        calls.push({ init, url: String(input) })
        return Response.json(createDiagnostics('model-a', 80))
      },
      'http://proxy.example/diagnostics',
    )

    await waitFor(() => dashboard.element('status-label').textContent === 'Proxy is ready')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://proxy.example/diagnostics')
    expect(calls[0]?.init?.credentials).toBe('omit')
    expect(calls[0]?.init?.redirect).toBe('error')

    dashboard.element('endpoint').value = 'http://proxy.example/private-side-effect'
    dashboard.element('endpoint-form').dispatch('submit')
    await waitFor(() => dashboard.element('status-label').textContent === 'Diagnostics unavailable')

    expect(calls).toHaveLength(1)
    expect(dashboard.element('error-banner').textContent).toContain(
      'Endpoint path must be /diagnostics or /usage with at most one trailing slash',
    )
  })

  test('labels retained models stale when the latest catalog refresh failed', async () => {
    const diagnostics = createDiagnostics('stale-model', 80)
    diagnostics.status = 'degraded'
    Object.assign(diagnostics.readiness, {
      status: 'ready',
      reasons: [],
      warnings: ['model_catalog_stale'],
      modelCatalog: {
        status: 'stale',
        consecutiveRefreshFailures: 2,
        lastRefreshAttemptAt: 2_000,
        lastRefreshFailureAt: 2_100,
        lastRefreshSuccessAt: 1_100,
      },
    })
    const dashboard = await createDashboard(
      async () => Response.json(diagnostics),
      'http://proxy.example/diagnostics',
    )

    await waitFor(() => dashboard.element('status-label').textContent === 'Proxy is ready with warnings')

    expect(dashboard.element('status-summary').textContent).toContain('Requests can continue')
    expect(dashboard.element('reason-list').children[0]?.textContent).toContain('latest refresh failed')
    expect(dashboard.element('model-count').textContent).toContain('1 model discovered · stale after 2 failed refreshes')
    expect(dashboard.element('model-count').textContent).toContain('last refreshed')
    expect(dashboard.element('model-rows').children[0]?.children[0]?.children[1]?.textContent).toBe('stale-model')
  })

  test('explains a denied local-network permission after a loopback fetch failure', async () => {
    const permissionNames: string[] = []
    const dashboard = await createDashboard(
      async () => {
        throw new TypeError('Failed to fetch')
      },
      'http://localhost:4399/diagnostics',
      async (descriptor) => {
        permissionNames.push(descriptor.name)
        if (descriptor.name === 'loopback-network')
          throw new TypeError('Unsupported permission name')
        return { state: 'denied' }
      },
    )

    await waitFor(() => dashboard.element('status-label').textContent === 'Diagnostics unavailable')

    expect(permissionNames).toEqual(['loopback-network', 'local-network-access'])
    expect(dashboard.element('error-banner').textContent).toContain(
      'local network access is blocked for this dashboard',
    )
    expect(dashboard.element('error-banner').textContent).toContain(
      'Allow local network access for this site in browser settings',
    )
  })

  test('keeps loopback fetch failures generic unless permission denial is confirmed', async () => {
    for (const permissionQuery of [
      undefined,
      async () => ({ state: 'prompt' }),
      async () => {
        throw new TypeError('Unsupported permission name')
      },
    ]) {
      const dashboard = await createDashboard(
        async () => {
          throw new TypeError('Failed to fetch')
        },
        'http://127.0.0.1:4399/diagnostics',
        permissionQuery,
      )

      await waitFor(() => dashboard.element('status-label').textContent === 'Diagnostics unavailable')
      expect(dashboard.element('error-banner').textContent).toBe('Diagnostics request failed')
      expect(dashboard.element('error-banner').textContent).not.toContain('local network access is blocked')
    }
  })

  test('does not auto-fetch invalid endpoints supplied through the dashboard query', async () => {
    const invalidEndpoints = [
      'http://dashboard-user:dashboard-password@proxy.example/diagnostics',
      'http://@proxy.example/diagnostics',
      'http://proxy.example/diagnostics?private-side-effect=true',
      'http://proxy.example/diagnostics#private-fragment',
      'http://proxy.example/private-side-effect',
      'http://proxy.example/diagnostics//',
    ]

    for (const endpoint of invalidEndpoints) {
      let fetchCalls = 0
      const dashboard = await createDashboard(async () => {
        fetchCalls += 1
        return Response.json(createDiagnostics('must-not-load', 100))
      }, endpoint)

      await waitFor(() => dashboard.element('status-label').textContent === 'Diagnostics unavailable')
      expect(fetchCalls).toBe(0)
      expect(dashboard.element('quota-state').textContent).toBe('Usage unavailable')
    }
  })

  test('rejects malformed diagnostics quota data instead of rendering it as available', async () => {
    const invalidQuotaFields: Array<[string, Record<string, unknown>]> = [
      ['percent above 100', { percent_remaining: 150 }],
      ['remaining above entitlement', { entitlement: 100, remaining: 200 }],
      ['negative remaining', { remaining: -1 }],
      ['non-finite entitlement', { entitlement: Number.POSITIVE_INFINITY }],
      ['non-boolean unlimited', { unlimited: 'yes' }],
      ['invalid unlimited numbers', { entitlement: -1, remaining: -1, unlimited: true }],
    ]

    for (const [, override] of invalidQuotaFields) {
      const diagnostics = createDiagnostics('model-a', 80)
      const premium = diagnostics.usage.data.quota_snapshots.premium_interactions
      Object.assign(premium, override)
      const dashboard = await createDashboard(
        async () => Response.json(diagnostics),
        'http://proxy.example/diagnostics',
      )

      await waitFor(() => dashboard.element('status-label').textContent === 'Diagnostics unavailable')
      expect(dashboard.element('quota-state').textContent).toBe('Usage unavailable')
      expect(dashboard.element('quota-state').textContent).not.toBe('Usage available')
    }
  })

  test('clears endpoint A readiness, models, and quota while endpoint B is loading', async () => {
    let resolveEndpointB: ((response: Response) => void) | undefined
    const endpointBResponse = new Promise<Response>((resolve) => {
      resolveEndpointB = resolve
    })
    const dashboard = await createDashboard(async (input) => {
      const endpoint = new URL(String(input))
      if (endpoint.hostname === 'proxy-a.example') {
        return Response.json(createDiagnostics('model-a', 80))
      }
      return await endpointBResponse
    }, 'http://proxy-a.example/diagnostics')

    await waitFor(() => dashboard.element('status-label').textContent === 'Proxy is ready')
    expect(dashboard.element('model-count').textContent).toBe('1 model discovered')
    expect(dashboard.element('quota-state').textContent).toBe('Usage available')

    dashboard.element('endpoint').value = 'http://proxy-b.example/diagnostics'
    dashboard.element('endpoint-form').dispatch('submit')

    expect(dashboard.element('status-label').textContent).toBe('Loading diagnostics…')
    expect(dashboard.element('account-type').textContent).toBe('Unknown account')
    expect(dashboard.element('model-count').textContent).toBe('Model catalog unavailable')
    expect(dashboard.element('quota-state').textContent).toBe('Loading usage…')
    expect(dashboard.element('model-rows').textContent).not.toContain('model-a')

    resolveEndpointB?.(Response.json(createDiagnostics('model-b', 60)))
    await waitFor(() => dashboard.element('status-label').textContent === 'Proxy is ready')
    expect(dashboard.element('model-rows').children[0]?.children[0]?.children[1]?.textContent).toBe('model-b')
  })

  test('keeps endpoint B rendered when endpoint A finishes parsing its delayed response later', async () => {
    let endpointAJsonStarted = false
    let endpointAJsonCompleted = false
    let resolveEndpointAJson: ((value: ReturnType<typeof createDiagnostics>) => void) | undefined
    const endpointAJson = new Promise<ReturnType<typeof createDiagnostics>>((resolve) => {
      resolveEndpointAJson = resolve
    })
    const endpointAResponse = Response.json(createDiagnostics('unused-model', 0))
    Object.defineProperty(endpointAResponse, 'json', {
      value: async () => {
        endpointAJsonStarted = true
        const value = await endpointAJson
        endpointAJsonCompleted = true
        return value
      },
    })
    const dashboard = await createDashboard(async (input) => {
      const endpoint = new URL(String(input))
      if (endpoint.hostname === 'proxy-a.example')
        return endpointAResponse
      return Response.json(createDiagnostics('model-b', 60))
    }, 'http://proxy-a.example/diagnostics')

    await waitFor(() => endpointAJsonStarted)
    dashboard.element('endpoint').value = 'http://proxy-b.example/diagnostics'
    dashboard.element('endpoint-form').dispatch('submit')

    const renderedModelId = () => dashboard.element('model-rows').children[0]?.children[0]?.children[1]?.textContent
    await waitFor(() => renderedModelId() === 'model-b')
    resolveEndpointAJson?.(createDiagnostics('model-a', 80))
    await waitFor(() => endpointAJsonCompleted)
    await Bun.sleep(0)

    expect(dashboard.element('endpoint').value).toBe('http://proxy-b.example/diagnostics')
    expect(dashboard.element('status-label').textContent).toBe('Proxy is ready')
    expect(renderedModelId()).toBe('model-b')
    expect(dashboard.element('quota-grid').children[0]?.children[1]?.textContent).toBe('60% left')
    expect(dashboard.element('error-banner').className).toBe('error-banner')
    expect(dashboard.element('refresh-button').textContent).toBe('Refresh')
  })
})

async function createDashboard(
  fetchImplementation: (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => Promise<Response>,
  endpoint: string,
  permissionsQuery?: (descriptor: { name: string }) => Promise<{ state: string }>,
) {
  const html = await readFile(PAGE_PATH, 'utf8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script)
    throw new Error('Dashboard script was not found')

  const elements = new Map<string, FakeElement>(
    ELEMENT_IDS.map(id => [id, new FakeElement()]),
  )
  const pageUrl = new URL('https://dashboard.example/')
  pageUrl.searchParams.set('endpoint', endpoint)
  let currentUrl = pageUrl.toString()
  const windowStub = {
    get location() {
      return new URL(currentUrl)
    },
    history: {
      replaceState(_state: unknown, _unused: string, value: URL | string) {
        currentUrl = String(value)
      },
    },
    setTimeout,
    clearTimeout,
  }
  const documentStub = {
    createElement: () => new FakeElement(),
    getElementById: (id: string) => elements.get(id),
  }

  runInNewContext(script, {
    AbortController,
    document: documentStub,
    fetch: fetchImplementation,
    navigator: permissionsQuery
      ? { permissions: { query: permissionsQuery } }
      : undefined,
    URL,
    URLSearchParams,
    window: windowStub,
  })

  return {
    element(id: typeof ELEMENT_IDS[number]) {
      const element = elements.get(id)
      if (!element)
        throw new Error(`Dashboard element ${id} was not found`)
      return element
    },
  }
}

class FakeElement {
  children: FakeElement[] = []
  className = ''
  disabled = false
  style: Record<string, string> = {}
  textContent = ''
  value = ''
  private readonly listeners = new Map<string, (event: { preventDefault: () => void }) => void>()

  addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void) {
    this.listeners.set(type, listener)
  }

  append(...children: FakeElement[]) {
    this.children.push(...children)
  }

  dispatch(type: string) {
    this.listeners.get(type)?.({ preventDefault() {} })
  }

  replaceChildren(...children: FakeElement[]) {
    this.children = children
    this.textContent = ''
  }

  setAttribute(_name: string, _value: string) {}
}

function createLegacyUsage(plan: string, percentRemaining: number) {
  return {
    access_type_sku: 'copilot_for_individual',
    analytics_tracking_id: 'legacy-tracking-value',
    copilot_plan: plan,
    quota_reset_date: '2026-08-01',
    quota_snapshots: {
      premium_interactions: createQuota(percentRemaining),
      chat: createQuota(100),
      completions: createQuota(100, true),
    },
  }
}

function createDiagnostics(model: string, percentRemaining: number) {
  return {
    status: 'ready',
    generated_at: '2026-07-18T00:00:00.000Z',
    readiness: {
      status: 'ready',
      reasons: [],
      accountType: 'individual',
      upstreamHost: 'api.githubcopilot.com',
      modelCatalog: {
        status: 'fresh',
        consecutiveRefreshFailures: 0,
        lastRefreshAttemptAt: 900,
        lastRefreshSuccessAt: 1_000,
      },
      token: { tokenAvailable: true },
      recovery: {},
      concurrency: { enabled: false },
    },
    models: [{ id: model, displayName: model, routes: {} }],
    usage: {
      status: 'available',
      data: createLegacyUsage('individual', percentRemaining),
    },
  }
}

function createQuota(percentRemaining: number, unlimited = false) {
  return {
    entitlement: 100,
    percent_remaining: percentRemaining,
    remaining: percentRemaining,
    unlimited,
  }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate())
      return
    await Bun.sleep(0)
  }
  throw new Error('Timed out waiting for dashboard state')
}
