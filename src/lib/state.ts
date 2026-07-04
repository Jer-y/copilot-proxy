import type { AsyncConcurrencyLimiter } from './concurrency-limiter'
import type { ModelsResponse } from '~/services/copilot/get-models'

export interface State {
  githubToken?: string
  copilotToken?: string
  nativeServiceInstanceToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  /**
   * When set, `/responses` requests for `codex-auto-review` (the Codex guardian
   * reviewer, resolved from Codex's bundled catalog) are aliased to this
   * Responses-capable model. Unset = no alias (codex-auto-review remains
   * unreachable via /responses — today's behavior). Set via
   * `--codex-auto-review-model`.
   */
  codexAutoReviewModel?: string

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number

  // Optional global limiter for Copilot upstream request work.
  concurrencyLimiter?: AsyncConcurrencyLimiter
}

export const state: State = {
  accountType: 'individual',
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
