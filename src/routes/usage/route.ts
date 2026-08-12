import type { AccountContext } from '~/lib/account/types'
import type { CopilotUsageResponse } from '~/services/github/get-copilot-usage'

import consola from 'consola'
import { Hono } from 'hono'

import { getAccountRegistry } from '~/lib/account/registry'
import { getCopilotUsage } from '~/services/github/get-copilot-usage'

export const usageRoute = new Hono()

const USAGE_CACHE_MS = 15_000
const USAGE_FAILURE_CACHE_MS = 5_000
interface UsageCacheState {
  cache?: { expiresAt: number, value: CopilotUsageResponse }
  failure?: { error: unknown, expiresAt: number }
  inFlight?: Promise<CopilotUsageResponse>
}
const usageStates = new Map<string, UsageCacheState>()

export function resetUsageCacheForTests(): void {
  usageStates.clear()
}

export async function getCachedCopilotUsage(
  ctx: AccountContext = getAccountRegistry().defaultAccount,
): Promise<CopilotUsageResponse> {
  const usageState = getUsageState(ctx.id)
  const now = Date.now()
  if (usageState.cache && usageState.cache.expiresAt > now)
    return usageState.cache.value
  if (usageState.failure && usageState.failure.expiresAt > now)
    throw usageState.failure.error
  if (usageState.inFlight)
    return await usageState.inFlight

  usageState.inFlight = getCopilotUsage(ctx)
    .then((value) => {
      ctx.copilotPlan = value.copilot_plan
      usageState.cache = { expiresAt: Date.now() + USAGE_CACHE_MS, value }
      usageState.failure = undefined
      return value
    })
    .catch((error: unknown) => {
      usageState.failure = { error, expiresAt: Date.now() + USAGE_FAILURE_CACHE_MS }
      throw error
    })
    .finally(() => {
      usageState.inFlight = undefined
    })
  return await usageState.inFlight
}

usageRoute.get('/', async (c) => {
  try {
    c.header('Cache-Control', 'no-store')
    const registry = getAccountRegistry()
    const accountId = new URL(c.req.url).searchParams.get('account') ?? registry.defaultAccountId
    const ctx = registry.get(accountId)
    if (!ctx)
      return c.json({ error: `Unknown Copilot account: ${accountId}` }, 400)
    if (ctx.availability === 'unavailable')
      return c.json({ error: `Copilot account ${accountId} is unavailable` }, 503)
    const usage = await getCachedCopilotUsage(ctx)
    return c.json(usage)
  }
  catch (error) {
    consola.error('Error fetching Copilot usage:', error)
    return c.json({ error: 'Failed to fetch Copilot usage' }, 500)
  }
})

function getUsageState(accountId: string): UsageCacheState {
  const existing = usageStates.get(accountId)
  if (existing)
    return existing
  const created: UsageCacheState = {}
  usageStates.set(accountId, created)
  return created
}
