import type { AsyncConcurrencyLimiter } from './concurrency-limiter'
import type { ModelsResponse } from '~/services/copilot/get-models'

export interface State {
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

export interface ModelCatalogLifecycle {
  consecutiveRefreshFailures: number
  lastRefreshAttemptAt: number
  lastRefreshFailureAt?: number
  lastRefreshSuccessAt?: number
}

export const state: State = {
  accountType: 'individual',
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
