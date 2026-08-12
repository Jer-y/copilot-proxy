import type { AccountRegistry } from './account/registry'
import type { AccountContext } from './account/types'
import type { AsyncConcurrencyLimiter } from './concurrency-limiter'
import type { ModelsResponse } from '~/services/copilot/get-models'

import { createAccountContext } from './account/context'

export interface State {
  defaultAccount?: AccountContext
  accounts?: AccountRegistry
  githubToken?: string
  copilotToken?: string
  nativeServiceInstanceToken?: string

  accountType: string
  models?: ModelsResponse
  modelCatalogLifecycle?: ModelCatalogLifecycle
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Optional global limiter for Copilot upstream request work.
  concurrencyLimiter?: AsyncConcurrencyLimiter
}

export type RuntimeState = State & {
  defaultAccount: AccountContext
}

export interface ModelCatalogLifecycle {
  consecutiveRefreshFailures: number
  lastRefreshAttemptAt: number
  lastRefreshFailureAt?: number
  lastRefreshSuccessAt?: number
}

let defaultAccount = createAccountContext()

/**
 * Process-wide state plus compatibility accessors for the implicit default
 * account. New account-aware code should use state.defaultAccount explicitly.
 */
export const state: RuntimeState = {
  get defaultAccount() {
    return defaultAccount
  },
  set defaultAccount(value: AccountContext) {
    defaultAccount = value
  },
  get accountType() {
    return defaultAccount.accountType
  },
  set accountType(value: string) {
    defaultAccount.accountType = value as AccountContext['accountType']
  },
  get vsCodeVersion() {
    return defaultAccount.vsCodeVersion
  },
  set vsCodeVersion(value: string | undefined) {
    defaultAccount.vsCodeVersion = value
  },
  get githubToken() {
    return defaultAccount.githubToken
  },
  set githubToken(value: string | undefined) {
    defaultAccount.githubToken = value
  },
  get copilotToken() {
    return defaultAccount.copilotToken
  },
  set copilotToken(value: string | undefined) {
    defaultAccount.copilotToken = value
  },
  get models() {
    return defaultAccount.models
  },
  set models(value) {
    defaultAccount.models = value
  },
  get modelCatalogLifecycle() {
    return defaultAccount.modelCatalogLifecycle
  },
  set modelCatalogLifecycle(value) {
    defaultAccount.modelCatalogLifecycle = value
  },
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}

defaultAccount.tokens.configure({
  showToken: () => state.showToken,
})

export function setDefaultAccountContext(ctx: AccountContext): void {
  state.defaultAccount = ctx
  ctx.tokens.configure({ showToken: () => state.showToken })
}
