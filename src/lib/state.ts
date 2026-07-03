import type { ModelsResponse } from '~/services/copilot/get-models'

export interface State {
  githubToken?: string
  copilotToken?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  /**
   * Stabilize per-item ids within a single OpenAI `/responses` stream. Off by
   * default so the endpoint forwards upstream ids verbatim; opt in via
   * `--normalize-openai-responses-item-ids`.
   */
  normalizeOpenAIResponsesItemIds: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
}

export const state: State = {
  accountType: 'individual',
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
  normalizeOpenAIResponsesItemIds: false,
}
