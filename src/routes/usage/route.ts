import consola from 'consola'
import { Hono } from 'hono'

import { getCopilotUsage } from '~/services/github/get-copilot-usage'

export const usageRoute = new Hono()

const USAGE_CACHE_MS = 15_000
const USAGE_FAILURE_CACHE_MS = 5_000
let usageCache: { expiresAt: number, value: Awaited<ReturnType<typeof getCopilotUsage>> } | undefined
let usageFailure: { error: unknown, expiresAt: number } | undefined
let usageInFlight: Promise<Awaited<ReturnType<typeof getCopilotUsage>>> | undefined

export function resetUsageCacheForTests(): void {
  usageCache = undefined
  usageFailure = undefined
  usageInFlight = undefined
}

export async function getCachedCopilotUsage(): Promise<Awaited<ReturnType<typeof getCopilotUsage>>> {
  const now = Date.now()
  if (usageCache && usageCache.expiresAt > now)
    return usageCache.value
  if (usageFailure && usageFailure.expiresAt > now)
    throw usageFailure.error
  if (usageInFlight)
    return await usageInFlight

  usageInFlight = getCopilotUsage()
    .then((value) => {
      usageCache = { expiresAt: Date.now() + USAGE_CACHE_MS, value }
      usageFailure = undefined
      return value
    })
    .catch((error: unknown) => {
      usageFailure = { error, expiresAt: Date.now() + USAGE_FAILURE_CACHE_MS }
      throw error
    })
    .finally(() => {
      usageInFlight = undefined
    })
  return await usageInFlight
}

usageRoute.get('/', async (c) => {
  try {
    c.header('Cache-Control', 'no-store')
    const usage = await getCachedCopilotUsage()
    return c.json(usage)
  }
  catch (error) {
    consola.error('Error fetching Copilot usage:', error)
    return c.json({ error: 'Failed to fetch Copilot usage' }, 500)
  }
})
