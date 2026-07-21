import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { resetUsageCacheForTests } from '~/routes/usage/route'
import { server } from '~/server'

const originalFetch = globalThis.fetch
function quota(remaining: number, percentRemaining: number) {
  return {
    entitlement: 100,
    percent_remaining: percentRemaining,
    remaining,
    unlimited: false,
  }
}
const publicUsagePayload = {
  copilot_plan: 'individual',
  quota_reset_date: '2026-08-01',
  quota_snapshots: {
    chat: quota(80, 80),
    completions: quota(100, 100),
    premium_interactions: quota(75, 75),
  },
}
const upstreamUsagePayload = {
  ...publicUsagePayload,
  access_type_sku: 'copilot_for_individual',
  analytics_tracking_id: 'must-not-appear-tracking-id',
  assigned_date: '2026-01-01',
  organization_enterprise_list: ['must-not-appear-enterprise'],
  organization_login_list: ['must-not-appear-org-login'],
  organization_list: [{ name: 'must-not-appear-org' }],
  quota_snapshots: {
    ...publicUsagePayload.quota_snapshots,
    chat: {
      ...publicUsagePayload.quota_snapshots.chat,
      nested_private_marker: 'must-not-appear-nested',
      quota_id: 'must-not-appear-quota-id',
    },
    future_private_bucket: {
      nested_private_marker: 'must-not-appear-future-bucket',
    },
  },
}
const fetchMock = mock(async (): Promise<Response> => Response.json(upstreamUsagePayload))

beforeEach(() => {
  resetUsageCacheForTests()
  fetchMock.mockClear()
  fetchMock.mockImplementation(async (): Promise<Response> => Response.json(upstreamUsagePayload))
  state.githubToken = 'github-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  resetUsageCacheForTests()
  globalThis.fetch = originalFetch
})

describe('/usage cache', () => {
  test('positive-caches a successful response and marks client responses no-store', async () => {
    const first = await server.request('/usage')
    const second = await server.request('/usage')

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.headers.get('cache-control')).toBe('no-store')
    expect(await first.json()).toEqual(publicUsagePayload)
    expect(await second.json()).toEqual(publicUsagePayload)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('negative-caches upstream failures', async () => {
    fetchMock.mockImplementation(async () => Response.json(
      { error: 'temporary failure' },
      { status: 503 },
    ))

    const first = await server.request('/usage')
    const second = await server.request('/usage')

    expect(first.status).toBe(500)
    expect(second.status).toBe(500)
    expect(await first.json()).toEqual({ error: 'Failed to fetch Copilot usage' })
    expect(await second.json()).toEqual({ error: 'Failed to fetch Copilot usage' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('coalesces concurrent cache misses into one upstream request', async () => {
    let resolveUpstream: ((response: Response) => void) | undefined
    fetchMock.mockImplementation(async () => await new Promise<Response>((resolve) => {
      resolveUpstream = resolve
    }))

    const first = server.request('/usage')
    const second = server.request('/usage')

    await waitFor(() => fetchMock.mock.calls.length === 1 && resolveUpstream !== undefined)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    resolveUpstream!(Response.json(upstreamUsagePayload))
    const [firstResponse, secondResponse] = await Promise.all([first, second])

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(await firstResponse.json()).toEqual(publicUsagePayload)
    expect(await secondResponse.json()).toEqual(publicUsagePayload)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for usage request')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
