import type { AccountsConfiguration } from './types'

import { cacheModels } from '~/lib/utils'
import { getVSCodeVersion } from '~/services/get-vscode-version'

import { verifyAccountToken } from './auth'
import { assessRequiredRoute, boundAccountIdForRequiredRoute } from './capabilities'
import { AccountRegistry } from './registry'
import { hardenAccountStoragePaths, readAccountToken } from './store'

export interface OfflineAccountValidationOptions {
  accountIds?: Iterable<string>
  tokenOverrides?: ReadonlyMap<string, string>
  validateCriticalRoutes?: boolean
}

/**
 * Validates candidate account state without publishing it or scheduling any
 * background work. This is the no-runtime equivalent of the native-service
 * restart/readiness gate: GitHub identity, Copilot token acquisition, model
 * catalog loading, default-account readiness, and required-route capability
 * checks all use the candidate configuration.
 */
export async function validateAccountsOffline(
  configuration: AccountsConfiguration,
  options: OfflineAccountValidationOptions = {},
): Promise<void> {
  const registry = new AccountRegistry(configuration)
  const accountIds = new Set(options.accountIds ?? [])
  if (options.validateCriticalRoutes) {
    accountIds.add(configuration.defaultAccount)
    for (const route of configuration.requiredRoutes)
      accountIds.add(boundAccountIdForRequiredRoute(registry, route))
  }
  if (accountIds.size === 0)
    return

  if ([...accountIds].some(accountId => !options.tokenOverrides?.has(accountId)))
    hardenAccountStoragePaths()

  const vsCodeVersion = await getVSCodeVersion()
  await mapWithConcurrency([...accountIds], 3, async (accountId) => {
    const descriptor = configuration.accounts.find(account => account.id === accountId)
    const ctx = registry.get(accountId)
    if (!descriptor || !ctx)
      throw new Error(`Unknown account: ${accountId}`)

    const token = options.tokenOverrides?.get(accountId) ?? readAccountToken(accountId)
    if (!token)
      throw new Error(`Account ${accountId} has no persisted token`)

    ctx.githubToken = token
    ctx.vsCodeVersion = vsCodeVersion
    try {
      const identity = await verifyAccountToken(
        descriptor.accountType,
        token,
        descriptor.githubUserId,
      )
      ctx.githubLogin = identity.login
      ctx.githubUserId = identity.userId
      ctx.identityState = 'ok'
      await ctx.tokens.setup({ scheduleRefresh: false })
      await cacheModels(ctx)
      if ((ctx.models?.data.length ?? 0) === 0)
        throw new Error('Copilot model catalog is empty')
      ctx.availability = 'ready'
    }
    catch (error) {
      ctx.availability = 'unavailable'
      ctx.unavailableReason = 'offline_validation_failed'
      throw new Error(
        `Account ${accountId} failed Copilot validation: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    finally {
      ctx.tokens.stopRefresh()
      await ctx.tokens.cancelInFlight()
    }
  })

  if (!options.validateCriticalRoutes)
    return

  const failures = configuration.requiredRoutes
    .map(route => assessRequiredRoute(registry, route))
    .filter(assessment => !assessment.ready)
  if (failures.length > 0) {
    throw new Error(
      `Required Copilot routes are unavailable: ${failures.map(failure => `${failure.surface}:${failure.model}@${failure.accountId} (${failure.reason})`).join(', ')}`,
    )
  }
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      await task(values[index]!)
    }
  })
  await Promise.all(workers)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
