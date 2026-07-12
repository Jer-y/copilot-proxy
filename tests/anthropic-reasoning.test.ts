import type { ModelConfig } from '~/lib/model-config'
import type { AnthropicMessagesPayload } from '~/lib/translation/types'

import { describe, expect, test } from 'bun:test'

import {
  mapAnthropicReasoningToResponses,
  resolveAnthropicReasoningEffort,
} from '../src/lib/translation/anthropic-reasoning'

describe('Anthropic reasoning helpers', () => {
  test('explicit disabled thinking maps to Responses effort none when supported', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'future-model',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'disabled' },
    }
    const modelConfig: ModelConfig = {
      supportedApis: ['responses'],
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high'],
    }

    const effort = resolveAnthropicReasoningEffort(payload, modelConfig)
    expect(effort).toBe('none')
    expect(mapAnthropicReasoningToResponses(effort, modelConfig)).toEqual({ effort: 'none' })
  })

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

  test('max is preserved exactly when the Responses model advertises max', () => {
    const modelConfig: ModelConfig = {
      supportedApis: ['responses'],
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    }

    expect(mapAnthropicReasoningToResponses('max', modelConfig)).toEqual({ effort: 'max' })
  })

  test('an exact effort is forwarded when capability metadata is unavailable', () => {
    const modelConfig: ModelConfig = {
      supportedApis: ['responses'],
    }

    expect(mapAnthropicReasoningToResponses('none', modelConfig)).toEqual({ effort: 'none' })
    expect(mapAnthropicReasoningToResponses('max', modelConfig)).toEqual({ effort: 'max' })
  })

  test('an explicitly unsupported effort is not silently downgraded', () => {
    const modelConfig: ModelConfig = {
      supportedApis: ['responses'],
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    }

    expect(mapAnthropicReasoningToResponses('max', modelConfig)).toBeUndefined()
  })
})
