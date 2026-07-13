import type { Model, ModelsResponse } from '~/services/copilot/get-models'

import { describe, expect, test } from 'bun:test'

import { getModelConfig } from '../src/lib/model-config'
import { findModelMaxOutputTokens } from '../src/lib/model-utils'
import { state } from '../src/lib/state'

describe('getModelConfig', () => {
  test('should return config with enableCacheControl and defaultReasoningEffort for claude-opus-4.6', () => {
    const config = getModelConfig('claude-opus-4.6')
    expect(config.enableCacheControl).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(config.verifiedMaxOutputTokens).toBe(128000)
    expect(config.supportedApis).toEqual(['anthropic-messages', 'chat-completions'])
    expect(config.preferredApi).toBe('anthropic-messages')
  })

  test('should configure claude-opus-4.7 with native 1m full reasoning support', () => {
    const config = getModelConfig('claude-opus-4.7')
    expect(config.enableCacheControl).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportsToolChoice).toBe(false)
    expect(config.supportsParallelToolCalls).toBe(true)
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(config.verifiedMaxOutputTokens).toBe(128000)
    expect(config.supportedApis).toEqual(['anthropic-messages', 'chat-completions'])
    expect(config.preferredApi).toBe('anthropic-messages')
  })

  test('should configure claude-opus-4.8 with native 1m full reasoning support', () => {
    const config = getModelConfig('claude-opus-4.8')
    expect(config.enableCacheControl).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportsToolChoice).toBe(false)
    expect(config.supportsParallelToolCalls).toBe(true)
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(config.verifiedMaxOutputTokens).toBe(128000)
    expect(config.supportedApis).toEqual(['anthropic-messages', 'chat-completions'])
    expect(config.preferredApi).toBe('anthropic-messages')
  })

  test('should return config with reasoningMode for gpt-5.2-codex', () => {
    const config = getModelConfig('gpt-5.2-codex')
    expect(config.reasoningMode).toBe('thinking')
    expect(config.supportedApis).toEqual(['responses'])
  })

  test('should let o3-mini variants inherit the responses config', () => {
    const config = getModelConfig('o3-mini-high')
    expect(config.reasoningMode).toBe('thinking')
    expect(config.supportedApis).toEqual(['responses'])
  })

  test('should match gpt-5.2-codex-max via prefix match', () => {
    const config = getModelConfig('gpt-5.2-codex-max')
    expect(config.reasoningMode).toBe('thinking')
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportedReasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  test('should return default config for unknown-model', () => {
    const config = getModelConfig('unknown-model')
    expect(config.supportedApis).toEqual(['chat-completions'])
  })

  test('should not match adjacent model versions by raw prefix', () => {
    const config = getModelConfig('gpt-5.20')
    expect(config.supportedApis).toEqual(['chat-completions'])
  })

  test('should return default Claude config for claude-unknown', () => {
    const config = getModelConfig('claude-unknown')
    expect(config.enableCacheControl).toBe(true)
    expect(config.supportsToolChoice).toBe(false)
  })

  test('should return exact match config for claude-sonnet-4', () => {
    const config = getModelConfig('claude-sonnet-4')
    expect(config.enableCacheControl).toBe(true)
    expect(config.supportsToolChoice).toBe(false)
    expect(config.supportsParallelToolCalls).toBe(false)
  })

  test('should return exact match config for claude-sonnet-4.6', () => {
    const config = getModelConfig('claude-sonnet-4.6')
    expect(config.enableCacheControl).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high'])
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
    expect(config.supportedApis).toEqual(['anthropic-messages', 'chat-completions'])
    expect(config.preferredApi).toBe('anthropic-messages')
  })

  test('should return exact match config for gpt-4o', () => {
    const config = getModelConfig('gpt-4o')
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
  })

  test('should configure gpt-5.4 for current chat and responses surfaces', () => {
    const config = getModelConfig('gpt-5.4')
    expect(config.supportedApis).toEqual(['chat-completions', 'responses'])
    expect(config.preferredApi).toBe('responses')
    expect(config.chatCompletionTokenParameter).toBe('max_completion_tokens')
    expect(config.reasoningMode).toBe('thinking')
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportedReasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
  })

  test('should configure gpt-5.5 as responses-only', () => {
    const config = getModelConfig('gpt-5.5')
    expect(config.supportedApis).toEqual(['responses'])
    expect(config.reasoningMode).toBe('thinking')
    expect(config.defaultReasoningEffort).toBe('medium')
    expect(config.supportedReasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
  })

  test('should configure gpt-5.6 as responses-only with max reasoning', () => {
    const config = getModelConfig('gpt-5.6')
    expect(config.supportedApis).toEqual(['responses'])
    expect(config.reasoningMode).toBe('thinking')
    expect(config.defaultReasoningEffort).toBe('medium')
    expect(config.supportedReasoningEfforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
  })

  test('should match gpt-5.6 variants (sol/luna/terra) via prefix match', () => {
    for (const id of ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra']) {
      const config = getModelConfig(id)
      expect(config.supportedApis).toEqual(['responses'])
      expect(config.reasoningMode).toBe('thinking')
    }
  })

  test('should configure gpt-5.1 as both APIs', () => {
    const config = getModelConfig('gpt-5.1')
    expect(config.supportedApis).toEqual(['chat-completions', 'responses'])
    expect(config.preferredApi).toBe('responses')
  })

  test('should configure gpt-5 as both APIs', () => {
    const config = getModelConfig('gpt-5')
    expect(config.supportedApis).toEqual(['chat-completions', 'responses'])
    expect(config.preferredApi).toBe('responses')
  })

  test('should configure gpt-5.1-codex as responses-only', () => {
    const config = getModelConfig('gpt-5.1-codex')
    expect(config.supportedApis).toEqual(['responses'])
    expect(config.reasoningMode).toBe('thinking')
  })

  test('should configure gpt-5-codex as responses-only', () => {
    const config = getModelConfig('gpt-5-codex')
    expect(config.supportedApis).toEqual(['responses'])
    expect(config.reasoningMode).toBe('thinking')
    expect(config.defaultReasoningEffort).toBe('high')
  })

  test('should match gemini models via prefix', () => {
    const config = getModelConfig('gemini-3.1-pro-preview')
    expect(config.supportedApis).toEqual(['chat-completions'])
  })

  test('uses live capabilities for a current Responses model missing from static config', () => {
    const previousModels = state.models
    state.models = {
      object: 'list',
      data: [{
        id: 'mai-code-1-flash-picker',
        capabilities: {
          family: 'mai-code',
          limits: {},
          object: 'model_capabilities',
          supports: {
            tool_calls: true,
            parallel_tool_calls: true,
            reasoning_effort: ['low', 'medium', 'high'],
          },
          tokenizer: 'o200k_base',
          type: 'chat',
        },
        model_picker_enabled: true,
        name: 'MAI Code Flash',
        object: 'model',
        preview: true,
        supported_endpoints: ['/responses', 'ws:/responses'],
        vendor: 'github-copilot',
        version: '1',
      } satisfies Model],
    }

    try {
      const config = getModelConfig('mai-code-1-flash-picker')
      expect(config.supportedApis).toEqual(['responses'])
      expect(config.preferredApi).toBe('responses')
      expect(config.reasoningMode).toBe('thinking')
      expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high'])
      expect(config.supportsToolChoice).toBe(true)
      expect(config.supportsParallelToolCalls).toBe(true)
    }
    finally {
      state.models = previousModels
    }
  })
})

describe('findModelMaxOutputTokens', () => {
  test('uses verified Opus limits as a floor without hiding newer live limits', () => {
    const withLimit = (maxOutputTokens: number) => ({
      object: 'list' as const,
      data: [{
        id: 'claude-opus-4.8',
        capabilities: {
          limits: { max_output_tokens: maxOutputTokens },
        },
      }],
    }) as unknown as ModelsResponse

    expect(findModelMaxOutputTokens('claude-opus-4.8', withLimit(64000))).toBe(128000)
    expect(findModelMaxOutputTokens('claude-opus-4.8', withLimit(256000))).toBe(256000)
  })
})
