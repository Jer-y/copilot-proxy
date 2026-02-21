import type { AnthropicMessagesPayload } from '~/routes/messages/anthropic-types'
import type { Model } from '~/services/copilot/get-models'

import { describe, expect, test } from 'bun:test'

import { findModelWithFallback, isClaudeCodeRequest } from '../src/routes/messages/count-tokens-handler'
import { translateToOpenAI } from '../src/routes/messages/non-stream-translation'

/**
 * Integration-style tests that verify the full translateToOpenAI call chain
 * with anthropicBeta options, simulating the handler → translation → model routing flow.
 */

function makePayload(model: string, extra?: Partial<AnthropicMessagesPayload>): AnthropicMessagesPayload {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 10,
    stream: false,
    ...extra,
  }
}

describe('Variant routing integration', () => {
  test('fast mode via header + speed field routes to claude-opus-4.6-fast', () => {
    const result = translateToOpenAI(
      makePayload('claude-opus-4-6', { speed: 'fast' }),
      { anthropicBeta: 'fast-mode-2026-02-01' },
    )
    expect(result.model).toBe('claude-opus-4.6-fast')
  })

  test('fast mode via speed field alone routes to claude-opus-4.6-fast', () => {
    const result = translateToOpenAI(
      makePayload('claude-opus-4-6', { speed: 'fast' }),
    )
    expect(result.model).toBe('claude-opus-4.6-fast')
  })

  test('fast mode via header alone routes to claude-opus-4.6-fast', () => {
    const result = translateToOpenAI(
      makePayload('claude-opus-4.6'),
      { anthropicBeta: 'fast-mode-2026-02-01' },
    )
    expect(result.model).toBe('claude-opus-4.6-fast')
  })

  test('1m context via header routes to claude-opus-4.6-1m', () => {
    const result = translateToOpenAI(
      makePayload('claude-opus-4.6'),
      { anthropicBeta: 'context-1m-2025-08-07' },
    )
    expect(result.model).toBe('claude-opus-4.6-1m')
  })

  test('no special signal routes to claude-opus-4.6', () => {
    const result = translateToOpenAI(makePayload('claude-opus-4-6'))
    expect(result.model).toBe('claude-opus-4.6')
  })

  test('fast + 1m together: fast takes priority', () => {
    const result = translateToOpenAI(
      makePayload('claude-opus-4.6', { speed: 'fast' }),
      { anthropicBeta: 'context-1m-2025-08-07, fast-mode-2026-02-01' },
    )
    expect(result.model).toBe('claude-opus-4.6-fast')
  })

  test('beta header with claude-code prefix and context-1m together', () => {
    const result = translateToOpenAI(
      makePayload('claude-opus-4.6'),
      { anthropicBeta: 'claude-code-2025-01-01, context-1m-2025-08-07' },
    )
    expect(result.model).toBe('claude-opus-4.6-1m')
  })

  test('model with date suffix is normalized then variant applied', () => {
    const result = translateToOpenAI(
      makePayload('claude-opus-4-6-20250514', { speed: 'fast' }),
    )
    expect(result.model).toBe('claude-opus-4.6-fast')
  })

  test('speed field does not leak into OpenAI payload', () => {
    const result = translateToOpenAI(
      makePayload('claude-opus-4.6', { speed: 'fast' }),
    )
    expect((result as Record<string, unknown>).speed).toBeUndefined()
  })

  test('non-opus models are not affected by variant signals', () => {
    const result = translateToOpenAI(
      makePayload('claude-sonnet-4.6', { speed: 'fast' }),
      { anthropicBeta: 'fast-mode-2026-02-01' },
    )
    expect(result.model).toBe('claude-sonnet-4.6')
  })
})

describe('findModelWithFallback', () => {
  const baseModel: Model = {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6',
    version: '1',
    capabilities: { family: 'claude', limits: {}, object: 'model', supports: {}, tokenizer: 'o200k_base', type: 'chat' },
    model_picker_enabled: true,
    object: 'model',
    preview: false,
    vendor: 'anthropic',
  }

  test('exact match returns the model', () => {
    const result = findModelWithFallback('claude-opus-4.6', [baseModel])
    expect(result?.id).toBe('claude-opus-4.6')
  })

  test('variant -fast falls back to base model', () => {
    const result = findModelWithFallback('claude-opus-4.6-fast', [baseModel])
    expect(result?.id).toBe('claude-opus-4.6')
  })

  test('variant -1m falls back to base model', () => {
    const result = findModelWithFallback('claude-opus-4.6-1m', [baseModel])
    expect(result?.id).toBe('claude-opus-4.6')
  })

  test('returns undefined when neither variant nor base exists', () => {
    const result = findModelWithFallback('unknown-model-fast', [baseModel])
    expect(result).toBeUndefined()
  })

  test('returns undefined for undefined models list', () => {
    const result = findModelWithFallback('claude-opus-4.6', undefined)
    expect(result).toBeUndefined()
  })

  test('prefers exact variant match over fallback', () => {
    const fastModel: Model = { ...baseModel, id: 'claude-opus-4.6-fast', name: 'Claude Opus 4.6 Fast' }
    const result = findModelWithFallback('claude-opus-4.6-fast', [baseModel, fastModel])
    expect(result?.id).toBe('claude-opus-4.6-fast')
  })
})

describe('isClaudeCodeRequest', () => {
  test('detects claude-code when it is the only token', () => {
    expect(isClaudeCodeRequest('claude-code-2025-01-01')).toBe(true)
  })

  test('detects claude-code regardless of position in header', () => {
    expect(isClaudeCodeRequest('fast-mode-2026-02-01, claude-code-2025-01-01')).toBe(true)
    expect(isClaudeCodeRequest('claude-code-2025-01-01, fast-mode-2026-02-01')).toBe(true)
  })

  test('returns false when no claude-code token', () => {
    expect(isClaudeCodeRequest('fast-mode-2026-02-01')).toBe(false)
  })

  test('returns false for undefined', () => {
    expect(isClaudeCodeRequest(undefined)).toBe(false)
  })
})
