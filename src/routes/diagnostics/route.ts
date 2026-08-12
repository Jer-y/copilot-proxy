import { Hono } from 'hono'

import { buildModelCapabilitySnapshot } from '~/lib/product-capabilities'

import { buildReadinessStatus } from '../health/route'
import { buildBoundModelCatalog } from '../models/route'
import { getCachedCopilotUsage } from '../usage/route'

export const DIAGNOSTICS_USAGE_TIMEOUT_MS = 8_000

export const diagnosticsRoute = new Hono()

diagnosticsRoute.get('/', async (c) => {
  c.header('Cache-Control', 'no-store')

  const modelSnapshot = buildModelCapabilitySnapshot(buildBoundModelCatalog())
  const readiness = buildReadinessStatus()
  const usage = await loadUsageStatus()
  const status = modelSnapshot.profiles.length === 0
    || readiness.status === 'degraded'
    || readiness.warnings.length > 0
    ? 'degraded' as const
    : 'ready' as const

  return c.json({
    status,
    generated_at: new Date().toISOString(),
    readiness,
    models: modelSnapshot.profiles.map(profile => ({
      id: profile.id,
      displayName: profile.displayName,
      vendor: profile.vendor,
      contextWindow: profile.contextWindow,
      maxOutputTokens: profile.maxOutputTokens,
      routes: profile.routes,
    })),
    usage,
  })
})

async function loadUsageStatus() {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const usage = await Promise.race([
      getCachedCopilotUsage(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error('Diagnostics usage deadline exceeded'))
        }, DIAGNOSTICS_USAGE_TIMEOUT_MS)
        timeout.unref?.()
      }),
    ])
    return {
      status: 'available' as const,
      data: {
        copilot_plan: usage.copilot_plan,
        quota_reset_date: usage.quota_reset_date,
        quota_snapshots: usage.quota_snapshots,
      },
    }
  }
  catch {
    return {
      status: 'unavailable' as const,
      error: 'Failed to fetch Copilot usage',
    }
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
  }
}
