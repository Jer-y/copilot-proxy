import type { AnthropicMessagesPayload } from './types'
import type { ModelConfig } from '~/lib/model-config'
import type { ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload } from '~/services/copilot/create-responses'

export type AnthropicReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

function mapThinkingBudgetToEffort(budgetTokens: number): Exclude<AnthropicReasoningEffort, 'xhigh' | 'max'> {
  if (budgetTokens <= 4_096) {
    return 'low'
  }

  if (budgetTokens <= 16_384) {
    return 'medium'
  }

  return 'high'
}

export function resolveAnthropicReasoningEffort(
  payload: AnthropicMessagesPayload,
  modelConfig: ModelConfig,
): AnthropicReasoningEffort | undefined {
  if (payload.thinking?.type === 'disabled') {
    return undefined
  }

  if (payload.output_config?.effort) {
    return payload.output_config.effort
  }

  if (payload.thinking?.type === 'enabled' && payload.thinking.budget_tokens) {
    return mapThinkingBudgetToEffort(payload.thinking.budget_tokens)
  }

  if (payload.thinking?.type === 'adaptive') {
    return normalizeAnthropicReasoningEffort(modelConfig.defaultReasoningEffort)
  }

  return undefined
}

export function mapAnthropicReasoningToChatCompletions(
  effort: AnthropicReasoningEffort | undefined,
  modelConfig: ModelConfig,
): ChatCompletionsPayload['reasoning_effort'] | undefined {
  if (!effort) {
    return undefined
  }

  const supported = new Set(modelConfig.supportedReasoningEfforts ?? [])
  if (supported.size === 0) {
    return undefined
  }

  if (supported.has(effort)) {
    return effort
  }

  if (effort === 'max') {
    // Preserve explicit max-effort requests so Copilot can return its
    // upstream-aligned invalid_reasoning_effort error instead of silently
    // downgrading the request to high.
    return 'max'
  }

  return undefined
}

export function mapAnthropicReasoningToResponses(
  effort: AnthropicReasoningEffort | undefined,
  modelConfig: ModelConfig,
): ResponsesPayload['reasoning'] | undefined {
  if (!effort) {
    return undefined
  }

  const supported = new Set(modelConfig.supportedReasoningEfforts ?? [])
  if (supported.size === 0) {
    return undefined
  }

  const candidates: Array<NonNullable<NonNullable<ResponsesPayload['reasoning']>['effort']>> = effort === 'max'
    ? ['xhigh', 'high']
    : [effort]

  const resolved = candidates.find(candidate => supported.has(candidate))
  if (!resolved) {
    return undefined
  }

  return { effort: resolved }
}

function normalizeAnthropicReasoningEffort(
  effort: ModelConfig['defaultReasoningEffort'],
): AnthropicReasoningEffort | undefined {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') {
    return effort
  }

  return undefined
}
