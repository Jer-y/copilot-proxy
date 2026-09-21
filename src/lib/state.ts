import type { AccountRegistry } from './account/registry'
import type { AccountContext } from './account/types'
import type { AsyncConcurrencyLimiter } from './concurrency-limiter'

import { createAccountContext } from './account/context'

export interface State {
  defaultAccount: AccountContext
  accounts?: AccountRegistry
  nativeServiceInstanceToken?: string

  rateLimitWait: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Optional global limiter for Copilot upstream request work.
  concurrencyLimiter?: AsyncConcurrencyLimiter
}

export interface ModelCatalogLifecycle {
  consecutiveRefreshFailures: number
  lastRefreshAttemptAt: number
  lastRefreshFailureAt?: number
  lastRefreshSuccessAt?: number
}

/** Process-wide controls and the currently selected default account. */
export const state: State = {
  defaultAccount: createAccountContext(),
  rateLimitWait: false,
}
