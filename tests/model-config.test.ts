import { describe, expect, test } from 'bun:test'

import { getModelConfig, isThinkingModeModel } from '../src/lib/model-config'

describe('getModelConfig', () => {
  test('should return config with enableCacheControl and defaultReasoningEffort for claude-opus-4.6', () => {
    const config = getModelConfig('claude-opus-4.6')
    expect(config.enableCacheControl).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
  })

  test('should return config with thinkingMode for gpt-5.2-codex', () => {
    const config = getModelConfig('gpt-5.2-codex')
    expect(config.thinkingMode).toBe(true)
  })

  test('should match gpt-5.2-codex-max via prefix match', () => {
    const config = getModelConfig('gpt-5.2-codex-max')
    expect(config.thinkingMode).toBe(true)
    expect(config.defaultReasoningEffort).toBe('high')
    expect(config.supportedReasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
  })

  test('should return empty config for unknown-model', () => {
    const config = getModelConfig('unknown-model')
    expect(config).toEqual({})
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

  test('should return exact match config for gpt-4o', () => {
    const config = getModelConfig('gpt-4o')
    expect(config.supportsToolChoice).toBe(true)
    expect(config.supportsParallelToolCalls).toBe(true)
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
