import { describe, expect, test } from 'bun:test'

import { getModelConfig, isThinkingModeModel, resolveBackend } from '../src/lib/model-config'

describe('getModelConfig', () => {
  test('should return config with enableCacheControl and defaultReasoningEffort for claude-opus-4.6', () => {
    const config = getModelConfig('claude-opus-4.6')
    expect(config.enableCacheControl).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(config.supportedApis).toEqual(['chat-completions'])
  })

  test('should let claude-opus-4.6-fast inherit the claude-opus-4.6 config', () => {
    const config = getModelConfig('claude-opus-4.6-fast')
    expect(config.enableCacheControl).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(config.supportedApis).toEqual(['chat-completions'])
  })

  test('should let claude-opus-4.6-1m inherit the claude-opus-4.6 config', () => {
    const config = getModelConfig('claude-opus-4.6-1m')
    expect(config.enableCacheControl).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(config.supportedApis).toEqual(['chat-completions'])
  })

  test('should return config with reasoningMode for gpt-5.2-codex', () => {
    const config = getModelConfig('gpt-5.2-codex')
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
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'max'])
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
    expect(config.supportedApis).toEqual(['chat-completions'])
  })

  test('should return exact match config for gpt-4o', () => {
    const config = getModelConfig('gpt-4o')
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
  })

  test('should configure gpt-5.4 as responses-only', () => {
    const config = getModelConfig('gpt-5.4')
    expect(config.supportedApis).toEqual(['responses'])
    expect(config.reasoningMode).toBe('thinking')
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportedReasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  test('should configure gpt-5.1 as both APIs', () => {
    const config = getModelConfig('gpt-5.1')
    expect(config.supportedApis).toEqual(['chat-completions', 'responses'])
    expect(config.preferredApi).toBe('chat-completions')
  })

  test('should match gemini models via prefix', () => {
    const config = getModelConfig('gemini-3.1-pro-preview')
    expect(config.supportedApis).toEqual(['chat-completions'])
  })
})

describe('isThinkingModeModel', () => {
  test('should return true for gpt-5.2-codex', () => {
    expect(isThinkingModeModel('gpt-5.2-codex')).toBe(true)
  })

  test('should return false for claude-opus-4.6', () => {
    expect(isThinkingModeModel('claude-opus-4.6')).toBe(false)
  })

  test('should return true for gpt-5', () => {
    expect(isThinkingModeModel('gpt-5')).toBe(true)
  })

  test('should return true for o3-mini', () => {
    expect(isThinkingModeModel('o3-mini')).toBe(true)
  })

  test('should return true for o4-mini', () => {
    expect(isThinkingModeModel('o4-mini')).toBe(true)
  })

  test('should return false for gpt-4o', () => {
    expect(isThinkingModeModel('gpt-4o')).toBe(false)
  })

  test('should return false for unknown-model', () => {
    expect(isThinkingModeModel('unknown-model')).toBe(false)
  })
})

describe('resolveBackend', () => {
  test('should return chat-completions for claude (cc-only model)', () => {
    expect(resolveBackend('claude-opus-4.6', 'chat-completions')).toBe('chat-completions')
  })

  test('should return chat-completions for claude even if responses requested', () => {
    expect(resolveBackend('claude-opus-4.6', 'responses')).toBe('chat-completions')
  })

  test('should route claude-opus-4.6-fast exactly like claude-opus-4.6', () => {
    expect(resolveBackend('claude-opus-4.6-fast', 'chat-completions')).toBe('chat-completions')
    expect(resolveBackend('claude-opus-4.6-fast', 'responses')).toBe('chat-completions')
  })

  test('should route claude-opus-4.6-1m exactly like claude-opus-4.6', () => {
    expect(resolveBackend('claude-opus-4.6-1m', 'chat-completions')).toBe('chat-completions')
    expect(resolveBackend('claude-opus-4.6-1m', 'responses')).toBe('chat-completions')
  })

  test('should return chat-completions for claude-sonnet-4.6 even if responses requested', () => {
    expect(resolveBackend('claude-sonnet-4.6', 'responses')).toBe('chat-completions')
  })

  test('should return responses for gpt-5.4 (responses-only model)', () => {
    expect(resolveBackend('gpt-5.4', 'responses')).toBe('responses')
  })

  test('should return responses for gpt-5.4 even if cc requested', () => {
    expect(resolveBackend('gpt-5.4', 'chat-completions')).toBe('responses')
  })

  test('should return requested API for gpt-5.1 (both supported)', () => {
    expect(resolveBackend('gpt-5.1', 'chat-completions')).toBe('chat-completions')
    expect(resolveBackend('gpt-5.1', 'responses')).toBe('responses')
  })

  test('should return responses for codex models', () => {
    expect(resolveBackend('gpt-5.1-codex', 'chat-completions')).toBe('responses')
    expect(resolveBackend('gpt-5.1-codex-max', 'chat-completions')).toBe('responses')
  })
})
