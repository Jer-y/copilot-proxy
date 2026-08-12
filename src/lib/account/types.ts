import type { RecoveryRegistry } from './recovery-registry'
import type { TokenLifecycle } from './token-lifecycle'
import type { AccountType } from '~/lib/cli-validators'
import type { AsyncConcurrencyLimiter } from '~/lib/concurrency-limiter'
import type { ModelCatalogLifecycle } from '~/lib/state'
import type { ModelsResponse } from '~/services/copilot/get-models'

export type AccountIdentityState = 'ok' | 'unverified' | 'mismatch'
export type AccountAvailability = 'ready' | 'initializing' | 'unavailable'
export type ClientSurface
  = | 'responses-http'
    | 'responses-websocket'
    | 'anthropic-messages'
    | 'chat-completions'
    | 'embeddings'

export interface AccountDescriptor {
  id: string
  accountType: AccountType
  githubLogin: string
  githubUserId: number
  maxConcurrency?: number
}

export interface AccountRouteRule {
  match: string
  account: string
}

export interface RequiredAccountRoute {
  surface: ClientSurface
  model: string
}

export interface AccountsConfiguration {
  version: 1
  revision: number
  defaultAccount: string
  requiredRoutes: RequiredAccountRoute[]
  accounts: AccountDescriptor[]
  routes: AccountRouteRule[]
}

/**
 * All mutable state that belongs to one GitHub/Copilot identity.
 *
 * Token lifecycle and recovery registries are attached in the next mechanical
 * refactor step. Keeping the data boundary explicit first lets legacy callers
 * continue through State's compatibility accessors without changing behavior.
 */
export interface AccountContext {
  readonly id: string
  accountType: AccountType
  vsCodeVersion?: string

  githubLogin?: string
  githubUserId?: number
  identityState: AccountIdentityState
  copilotPlan?: string

  githubToken?: string
  copilotToken?: string
  models?: ModelsResponse
  modelCatalogLifecycle?: ModelCatalogLifecycle
  concurrencyLimiter?: AsyncConcurrencyLimiter
  readonly tokens: TokenLifecycle
  readonly recovery: RecoveryRegistry

  availability: AccountAvailability
  unavailableReason?: string
}

export interface CreateAccountContextOptions {
  accountType?: AccountType
  id?: string
}
