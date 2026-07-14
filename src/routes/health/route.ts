import { Hono } from 'hono'

import { state } from '~/lib/state'
import { getCopilotTokenLifecycleStatus } from '~/lib/token'
import { getCopilotRecoveryStatus } from '~/services/copilot/authenticated-fetch'

export const healthRoutes = new Hono()

healthRoutes.get('/livez', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok' })
})

healthRoutes.get('/readyz', (c) => {
  c.header('Cache-Control', 'no-store')

  const token = getCopilotTokenLifecycleStatus()
  const recovery = getCopilotRecoveryStatus()
  const concurrency = state.concurrencyLimiter?.snapshot()
  const reasons: string[] = []

  if (!token.tokenAvailable)
    reasons.push('copilot_token_unavailable')
  if (!token.refreshScheduled && !token.refreshInFlight && !token.reactiveRefreshInFlight)
    reasons.push('copilot_token_refresh_unscheduled')
  if (token.expiresInMs !== undefined && token.expiresInMs <= 0)
    reasons.push('copilot_token_expired')
  if (!state.models?.data.length)
    reasons.push('model_catalog_unavailable')
  if (recovery.globalCircuit.phase === 'open')
    reasons.push('copilot_upstream_circuit_not_closed')

  const ready = reasons.length === 0
  if (!ready && recovery.globalCircuit.retryAfterSeconds)
    c.header('Retry-After', String(recovery.globalCircuit.retryAfterSeconds))

  return c.json({
    status: ready ? 'ready' : 'degraded',
    reasons,
    accountType: state.accountType,
    upstreamHost: resolveCopilotUpstreamHost(state.accountType),
    modelsAvailable: state.models?.data.length ?? 0,
    token,
    recovery,
    concurrency: concurrency ?? { enabled: false },
  }, ready ? 200 : 503)
})

function resolveCopilotUpstreamHost(accountType: string): string {
  return accountType === 'individual'
    ? 'api.githubcopilot.com'
    : `api.${accountType}.githubcopilot.com`
}
