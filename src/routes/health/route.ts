import { Hono } from 'hono'

import { state } from '~/lib/state'
import { getCopilotTokenLifecycleStatus } from '~/lib/token'
import { getCopilotRecoveryStatus } from '~/services/copilot/authenticated-fetch'

export const healthRoutes = new Hono()

export function buildReadinessStatus(models = state.models?.data ?? []) {
  const token = getCopilotTokenLifecycleStatus()
  const recovery = getCopilotRecoveryStatus()
  const concurrency = state.concurrencyLimiter?.snapshot()
  const modelCatalog = buildModelCatalogStatus(models.length > 0)
  const reasons: string[] = []
  const warnings: string[] = []

  if (!token.tokenAvailable)
    reasons.push('copilot_token_unavailable')
  if (!token.refreshScheduled && !token.refreshInFlight && !token.reactiveRefreshInFlight)
    reasons.push('copilot_token_refresh_unscheduled')
  if (token.expiresInMs !== undefined && token.expiresInMs <= 0)
    reasons.push('copilot_token_expired')
  if (models.length === 0)
    reasons.push('model_catalog_unavailable')
  else if (modelCatalog.status === 'stale')
    warnings.push('model_catalog_stale')
  if (recovery.globalCircuit.phase === 'open')
    reasons.push('copilot_upstream_circuit_not_closed')

  return {
    status: reasons.length === 0 ? 'ready' as const : 'degraded' as const,
    reasons,
    warnings,
    accountType: state.accountType,
    upstreamHost: resolveCopilotUpstreamHost(state.accountType),
    modelsAvailable: models.length,
    modelCatalog,
    token,
    recovery,
    concurrency: concurrency
      ? { enabled: true as const, ...concurrency }
      : { enabled: false as const },
  }
}

function buildModelCatalogStatus(hasSnapshot: boolean) {
  const lifecycle = state.modelCatalogLifecycle
  let status: 'fresh' | 'stale' | 'unavailable' | 'unknown'
  if (!hasSnapshot)
    status = 'unavailable'
  else if ((lifecycle?.consecutiveRefreshFailures ?? 0) > 0)
    status = 'stale'
  else if (lifecycle?.lastRefreshSuccessAt !== undefined)
    status = 'fresh'
  else
    status = 'unknown'

  return {
    status,
    consecutiveRefreshFailures: lifecycle?.consecutiveRefreshFailures ?? 0,
    ...(lifecycle?.lastRefreshAttemptAt !== undefined && {
      lastRefreshAttemptAt: lifecycle.lastRefreshAttemptAt,
    }),
    ...(lifecycle?.lastRefreshSuccessAt !== undefined && {
      lastRefreshSuccessAt: lifecycle.lastRefreshSuccessAt,
    }),
    ...(lifecycle?.lastRefreshFailureAt !== undefined && {
      lastRefreshFailureAt: lifecycle.lastRefreshFailureAt,
    }),
  }
}

healthRoutes.get('/livez', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok' })
})

healthRoutes.get('/readyz', (c) => {
  c.header('Cache-Control', 'no-store')

  const readiness = buildReadinessStatus()
  if (readiness.recovery.globalCircuit.phase === 'open' && readiness.recovery.globalCircuit.retryAfterSeconds !== undefined)
    c.header('Retry-After', String(readiness.recovery.globalCircuit.retryAfterSeconds))

  return c.json(readiness, readiness.status === 'ready' ? 200 : 503)
})

function resolveCopilotUpstreamHost(accountType: string): string {
  return accountType === 'individual'
    ? 'api.githubcopilot.com'
    : `api.${accountType}.githubcopilot.com`
}
