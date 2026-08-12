import type { AccountContext, AccountDescriptor, AccountsConfiguration, RequiredAccountRoute } from './types'
import type { RunServerOptions } from '~/start'

import process from 'node:process'
import consola from 'consola'

import { validateAccountType } from '~/lib/cli-validators'
import { AsyncConcurrencyLimiter, resolveConcurrencyLimitConfig } from '~/lib/concurrency-limiter'
import { setDefaultAccountContext, state } from '~/lib/state'
import { cacheModels, DEFAULT_MODEL_REFRESH_INTERVAL_MS, startModelRefresh, stopModelRefresh } from '~/lib/utils'

import { assessRequiredRoute } from './capabilities'
import { createAccountContext } from './context'
import { assessAccountIdentity } from './identity'
import { jitterModelRefreshInterval, jitterTokenRefreshDelay } from './jitter'
import {
  hardenAccountStoragePaths,
  readAccountsConfiguration,
  readAccountToken,
} from './store'

export class AccountRegistry {
  private readonly contexts = new Map<string, AccountContext>()
  readonly configuration: AccountsConfiguration | undefined

  constructor(
    configuration: AccountsConfiguration | undefined,
    implicitDefault: AccountContext = state.defaultAccount,
  ) {
    this.configuration = configuration
    if (!configuration) {
      this.contexts.set(implicitDefault.id, implicitDefault)
      return
    }

    const multiAccount = configuration.accounts.length > 1
    for (const descriptor of configuration.accounts) {
      const ctx = createContextFromDescriptor(descriptor, multiAccount)
      this.contexts.set(ctx.id, ctx)
    }
  }

  get explicit(): boolean {
    return this.configuration !== undefined
  }

  get size(): number {
    return this.contexts.size
  }

  get defaultAccountId(): string {
    return this.configuration?.defaultAccount ?? 'default'
  }

  get defaultAccount(): AccountContext {
    const ctx = this.contexts.get(this.defaultAccountId)
    if (!ctx)
      throw new Error(`Default account ${this.defaultAccountId} is not registered`)
    return ctx
  }

  get routes() {
    return this.configuration?.routes ?? []
  }

  get requiredRoutes(): RequiredAccountRoute[] {
    return this.configuration?.requiredRoutes ?? []
  }

  get(accountId: string): AccountContext | undefined {
    return this.contexts.get(accountId)
  }

  list(): AccountContext[] {
    return [...this.contexts.values()]
  }

  boundAccountIdForModel(model: string): string {
    return this.routes.find(route => globMatches(route.match, model))?.account
      ?? this.defaultAccountId
  }

  async initializeExplicit(options: RunServerOptions): Promise<void> {
    if (!this.configuration)
      throw new Error('Explicit account initialization requires accounts.json')

    try {
      hardenAccountStoragePaths()
      const accounts = this.list()
      const defaultCtx = this.defaultAccount
      const defaultEnvironmentToken = consumeDefaultEnvironmentToken(process.env)
      if (defaultEnvironmentToken)
        defaultCtx.githubToken = defaultEnvironmentToken

      for (const ctx of accounts) {
        if (!ctx.githubToken)
          ctx.githubToken = readAccountToken(ctx.id)
        ctx.vsCodeVersion = state.vsCodeVersion
      }

      await mapWithConcurrency(accounts, 3, async (ctx) => {
        await this.initializeAccount(ctx)
      })

      const failedDefault = defaultCtx.availability !== 'ready'
      if (failedDefault) {
        throw new Error(
          `Default account ${defaultCtx.id} is unavailable: ${defaultCtx.unavailableReason ?? 'unknown'}`,
        )
      }

      const failedRequiredRoutes = this.requiredRoutes
        .map(requiredRoute => assessRequiredRoute(this, requiredRoute))
        .filter(assessment => !assessment.ready)
      if (failedRequiredRoutes.length > 0) {
        throw new Error(`Required Copilot routes are unavailable: ${failedRequiredRoutes.map(failure => `${failure.surface}:${failure.model}@${failure.accountId} (${failure.reason})`).join(', ')}`)
      }

      setDefaultAccountContext(defaultCtx)
      state.accounts = this
      if (
        !options.nativeService
        && options.accountType !== defaultCtx.accountType
        && wasAccountTypeExplicit(process.argv.slice(2))
      ) {
        consola.warn(
          `Ignoring explicit --account-type=${options.accountType}; accounts.json default account ${defaultCtx.id} uses ${defaultCtx.accountType}.`,
        )
      }
    }
    catch (error) {
      const reason = error instanceof Error
        ? error
        : new Error('Explicit account initialization failed.', { cause: error })
      try {
        await this.stopAndCancelRefreshes(reason)
      }
      catch (cleanupError) {
        consola.warn('Failed to fully cancel account refresh work after initialization failed.', cleanupError)
      }
      throw error
    }
  }

  stopRefreshes(): void {
    for (const ctx of this.contexts.values()) {
      ctx.tokens.stopRefresh()
      stopModelRefresh(ctx)
    }
  }

  async stopAndCancelRefreshes(reason: Error): Promise<void> {
    this.stopRefreshes()
    await Promise.all(this.list().map(ctx => ctx.tokens.cancelInFlight(reason)))
  }

  private async initializeAccount(ctx: AccountContext): Promise<void> {
    ctx.availability = 'initializing'
    ctx.unavailableReason = undefined
    if (!ctx.githubToken) {
      ctx.availability = 'unavailable'
      ctx.unavailableReason = 'github_token_unavailable'
      return
    }

    const identity = await assessAccountIdentity(ctx, ctx.githubUserId)
    ctx.identityState = identity.state
    if (identity.state !== 'ok') {
      ctx.availability = 'unavailable'
      ctx.unavailableReason = identity.state === 'mismatch'
        ? 'identity_mismatch'
        : 'identity_unverified'
      if (identity.state === 'unverified') {
        consola.warn(
          `Could not verify GitHub identity for account ${ctx.id}; marking the account unavailable.`,
          identity.error,
        )
      }
      return
    }
    ctx.githubLogin = identity.login
    ctx.githubUserId = identity.userId

    try {
      const token = await ctx.tokens.setup({ scheduleRefresh: false })
      await cacheModels(ctx)
      ctx.tokens.startRefresh(token.refresh_in)
      const refreshInterval = jitterModelRefreshInterval(
        DEFAULT_MODEL_REFRESH_INTERVAL_MS,
        ctx.id,
        this.size > 1,
      )
      startModelRefresh(ctx, refreshInterval)
      ctx.availability = 'ready'
    }
    catch (error) {
      ctx.availability = 'unavailable'
      ctx.unavailableReason = 'initialization_failed'
      consola.warn(`Failed to initialize Copilot account ${ctx.id}.`, error)
    }
  }
}

export function loadAccountRegistry(accountType: string): AccountRegistry {
  if (!validateAccountType(accountType))
    throw new Error(`Invalid account type: ${accountType}`)
  const configuration = readAccountsConfiguration()
  if (!configuration) {
    state.defaultAccount.accountType = accountType
    const registry = new AccountRegistry(undefined, state.defaultAccount)
    state.accounts = registry
    return registry
  }
  return new AccountRegistry(configuration)
}

export function getAccountRegistry(): AccountRegistry {
  if (!state.accounts)
    state.accounts = new AccountRegistry(undefined, state.defaultAccount)
  return state.accounts
}

function createContextFromDescriptor(
  descriptor: AccountDescriptor,
  multiAccount: boolean,
): AccountContext {
  const ctx = createAccountContext({
    id: descriptor.id,
    accountType: descriptor.accountType,
  })
  ctx.githubLogin = descriptor.githubLogin
  ctx.githubUserId = descriptor.githubUserId
  ctx.tokens.configure({
    refreshDelay: delayMs => jitterTokenRefreshDelay(delayMs, ctx.id, multiAccount),
    showToken: () => state.showToken,
  })
  ctx.recovery.maxTrackedScopes = multiAccount ? 32 : 128
  if (descriptor.maxConcurrency !== undefined) {
    const config = resolveConcurrencyLimitConfig({ maxConcurrency: descriptor.maxConcurrency })
    if (config)
      ctx.concurrencyLimiter = new AsyncConcurrencyLimiter(config)
  }
  return ctx
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const expression = escaped.replaceAll('*', '.*').replaceAll('?', '.')
  return new RegExp(`^${expression}$`).test(value)
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

function consumeDefaultEnvironmentToken(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined
  }
  finally {
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
  }
}

function wasAccountTypeExplicit(argv: string[]): boolean {
  return argv.some(argument => argument === '--account-type'
    || argument === '-a'
    || argument.startsWith('--account-type='))
}
