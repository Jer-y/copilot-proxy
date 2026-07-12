import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { resetUsageCacheForTests } from '~/routes/usage/route'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const fetchMock = mock(async (): Promise<Response> => Response.json({ quota: 'fresh' }))

beforeEach(() => {
  resetUsageCacheForTests()
  fetchMock.mockClear()
  fetchMock.mockImplementation(async (): Promise<Response> => Response.json({ quota: 'fresh' }))
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
    expect(await first.json()).toEqual({ quota: 'fresh' })
    expect(await second.json()).toEqual({ quota: 'fresh' })
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

    resolveUpstream!(Response.json({ quota: 'shared' }))
    const [firstResponse, secondResponse] = await Promise.all([first, second])

    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)
    expect(await firstResponse.json()).toEqual({ quota: 'shared' })
    expect(await secondResponse.json()).toEqual({ quota: 'shared' })
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
