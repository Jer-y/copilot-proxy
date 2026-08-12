import type { AccountContext } from '~/lib/account/types'

import { Hono } from 'hono'

import { assessRequiredRoute } from '~/lib/account/capabilities'
import { getAccountRegistry } from '~/lib/account/registry'
import { isAccountIdentityExposureEnabled } from '~/lib/security'
import { state } from '~/lib/state'

export const healthRoutes = new Hono()

export function buildReadinessStatus() {
  const registry = getAccountRegistry()
  const ctx = registry.defaultAccount
  const contexts = registry.list()
  const accountReadinessById = new Map(contexts.map(account => [
    account.id,
    buildAccountReadiness(account, account.models?.data ?? []),
  ]))
  const accountReadiness = accountReadinessById.get(ctx.id)!
  const concurrency = state.concurrencyLimiter?.snapshot()
  const reasons = [...accountReadiness.reasons]
  const warnings = [...accountReadiness.warnings]

  const requiredRoutes = registry.requiredRoutes.map((route) => {
    const assessment = assessRequiredRoute(registry, route)
    if (!assessment.ready)
      return assessment
    const runtimeReason = accountReadinessById.get(assessment.accountId)?.reasons[0]
    return runtimeReason
      ? { ...assessment, ready: false, reason: runtimeReason }
      : assessment
  })
  for (const route of requiredRoutes) {
    if (!route.ready)
      reasons.push(`required_route_unavailable:${route.surface}:${route.model}`)
  }

  const accounts = contexts.map(account => buildAccountStatus(
    account,
    accountReadinessById.get(account.id)!,
  ))
  for (const account of accounts) {
    if (account.id === ctx.id)
      continue
    for (const reason of account.reasons)
      warnings.push(`${reason}:${account.id}`)
    for (const warning of account.warnings)
      warnings.push(`${warning}:${account.id}`)
  }

  return {
    status: reasons.length === 0 ? 'ready' as const : 'degraded' as const,
    reasons,
    warnings,
    configuration: buildConfigurationStatus(registry),
    accountType: state.accountType,
    upstreamHost: resolveCopilotUpstreamHost(state.accountType),
    modelsAvailable: ctx.models?.data.length ?? 0,
    modelCatalog: accountReadiness.modelCatalog,
    token: accountReadiness.token,
    recovery: accountReadiness.recovery,
    accounts,
    requiredRoutes,
    concurrency: concurrency
      ? {
          enabled: true as const,
          ...concurrency,
          global: { enabled: true as const, ...concurrency },
          perAccount: buildPerAccountConcurrency(contexts),
        }
      : {
          enabled: false as const,
          global: { enabled: false as const },
          perAccount: buildPerAccountConcurrency(contexts),
        },
  }
}

function buildModelCatalogStatus(ctx: AccountContext, hasSnapshot: boolean) {
  const lifecycle = ctx.modelCatalogLifecycle
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

  const registry = getAccountRegistry()
  const accountId = new URL(c.req.url).searchParams.get('account')
  if (accountId !== null) {
    const ctx = registry.get(accountId)
    if (!ctx) {
      return c.json({
        status: 'degraded',
        reasons: ['unknown_account'],
        configuration: buildConfigurationStatus(registry),
        account: accountId,
      }, 503)
    }
    const readiness = buildSingleAccountReadiness(ctx, registry)
    if (readiness.recovery.globalCircuit.phase === 'open' && readiness.recovery.globalCircuit.retryAfterSeconds !== undefined)
      c.header('Retry-After', String(readiness.recovery.globalCircuit.retryAfterSeconds))
    return c.json(readiness, readiness.status === 'ready' ? 200 : 503)
  }

  const readiness = buildReadinessStatus()
  if (readiness.recovery.globalCircuit.phase === 'open' && readiness.recovery.globalCircuit.retryAfterSeconds !== undefined)
    c.header('Retry-After', String(readiness.recovery.globalCircuit.retryAfterSeconds))

  return c.json(readiness, readiness.status === 'ready' ? 200 : 503)
})

function buildSingleAccountReadiness(
  ctx: AccountContext,
  registry: ReturnType<typeof getAccountRegistry>,
) {
  const readiness = buildAccountReadiness(ctx, ctx.models?.data ?? [])
  return {
    status: readiness.reasons.length === 0 ? 'ready' as const : 'degraded' as const,
    reasons: readiness.reasons,
    warnings: readiness.warnings,
    configuration: buildConfigurationStatus(registry),
    account: buildAccountStatus(ctx),
    modelCatalog: readiness.modelCatalog,
    token: readiness.token,
    recovery: readiness.recovery,
  }
}

function buildAccountReadiness(
  ctx: AccountContext,
  models: NonNullable<AccountContext['models']>['data'],
) {
  const token = ctx.tokens.getStatus()
  const recovery = getAccountRecoveryStatus(ctx)
  const modelCatalog = buildModelCatalogStatus(ctx, models.length > 0)
  const reasons: string[] = []
  const warnings: string[] = []

  if (ctx.availability !== 'ready')
    reasons.push(ctx.unavailableReason ?? 'account_unavailable')
  if (ctx.identityState === 'unverified')
    warnings.push('account_identity_unverified')
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

  return { modelCatalog, reasons, recovery, token, warnings }
}

function buildConfigurationStatus(registry: ReturnType<typeof getAccountRegistry>) {
  return {
    explicit: registry.explicit,
    revision: registry.configuration?.revision ?? null,
  }
}

function buildAccountStatus(
  ctx: AccountContext,
  readiness = buildAccountReadiness(ctx, ctx.models?.data ?? []),
) {
  const exposeIdentity = isAccountIdentityExposureEnabled()
  const models = ctx.models?.data ?? []
  return {
    id: ctx.id,
    accountType: ctx.accountType,
    availability: ctx.availability,
    identityState: ctx.identityState,
    modelsAvailable: models.length,
    modelCatalog: readiness.modelCatalog,
    token: readiness.token,
    recovery: readiness.recovery,
    reasons: readiness.reasons,
    warnings: readiness.warnings,
    ...(ctx.unavailableReason && { unavailableReason: ctx.unavailableReason }),
    ...(exposeIdentity && {
      githubLogin: ctx.githubLogin,
      githubUserId: ctx.githubUserId,
    }),
  }
}

function buildPerAccountConcurrency(contexts: AccountContext[]) {
  return Object.fromEntries(contexts.map(ctx => [
    ctx.id,
    ctx.concurrencyLimiter
      ? { enabled: true as const, ...ctx.concurrencyLimiter.snapshot() }
      : { enabled: false as const },
  ]))
}

function getAccountRecoveryStatus(ctx: AccountContext) {
  const now = Date.now()
  const circuits = [...ctx.recovery.scopeCircuits.values()]
  const openUntilValues = circuits
    .map(circuit => circuit.openUntil)
    .filter((value): value is number => value !== undefined)
  const resolvePhase = (circuit: typeof ctx.recovery.globalCircuit) => {
    if (circuit.phase === 'open' && circuit.openUntil !== undefined && now >= circuit.openUntil)
      circuit.phase = 'half_open'
    return circuit.phase
  }
  const globalCircuit = ctx.recovery.globalCircuit
  return {
    reactiveRefreshSuppressedUntil: ctx.recovery.reactiveRefreshSuppressedUntil,
    globalCircuit: {
      phase: resolvePhase(globalCircuit),
      openUntil: globalCircuit.openUntil,
      retryAfterSeconds: globalCircuit.openUntil === undefined
        ? undefined
        : Math.max(1, Math.ceil((globalCircuit.openUntil - now) / 1000)),
    },
    scopes: {
      tracked: circuits.length,
      open: circuits.filter(circuit => resolvePhase(circuit) === 'open').length,
      halfOpen: circuits.filter(circuit => resolvePhase(circuit) === 'half_open').length,
      earliestOpenUntil: openUntilValues.length > 0 ? Math.min(...openUntilValues) : undefined,
    },
    metrics: {
      ...ctx.recovery.metrics,
      responseStatusCounts: { ...ctx.recovery.metrics.responseStatusCounts },
    },
  }
}

function resolveCopilotUpstreamHost(accountType: string): string {
  return accountType === 'individual'
    ? 'api.githubcopilot.com'
    : `api.${accountType}.githubcopilot.com`
}
