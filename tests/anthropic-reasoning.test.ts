import type { ModelConfig } from '~/lib/model-config'
import type { AnthropicMessagesPayload } from '~/lib/translation/types'

import { describe, expect, test } from 'bun:test'

import {
  mapAnthropicReasoningToResponses,
  resolveAnthropicReasoningEffort,
} from '../src/lib/translation/anthropic-reasoning'

describe('Anthropic reasoning helpers', () => {
  test('adaptive thinking preserves xhigh model defaults for Anthropic-compatible effort', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'future-model',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'adaptive' },
    }

    const modelConfig: ModelConfig = {
      supportedApis: ['responses'],
      defaultReasoningEffort: 'xhigh',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    }

    const effort = resolveAnthropicReasoningEffort(payload, modelConfig)
    expect(effort).toBe('xhigh')
    expect(mapAnthropicReasoningToResponses(effort, modelConfig)).toEqual({ effort: 'xhigh' })
  })
})
