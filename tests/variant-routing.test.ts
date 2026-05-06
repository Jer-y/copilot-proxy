import type { AnthropicMessagesPayload } from '~/lib/translation/types'
import type { Model } from '~/services/copilot/get-models'

import { describe, expect, test } from 'bun:test'

import { findModelWithFallback } from '../src/lib/model-utils'
import {
  applyModelVariant,
  parseBetaFeatures,
  sanitizeAnthropicBetaHeader,
} from '../src/routes/messages/model-variants'

function makePayload(model: string, extra?: Partial<AnthropicMessagesPayload>): AnthropicMessagesPayload {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 10,
    stream: false,
    ...extra,
  }
}

describe('model variant routing', () => {
  test('fast mode via header and speed field routes to claude-opus-4.6-fast', () => {
    const result = applyModelVariant(
      'claude-opus-4-6',
      makePayload('claude-opus-4-6', { speed: 'fast' }),
      'fast-mode-2026-02-01',
    )
    expect(result).toBe('claude-opus-4.6-fast')
  })

  test('fast mode via speed field alone routes to claude-opus-4.6-fast', () => {
    const payload = makePayload('claude-opus-4-6', { speed: 'fast' })
    expect(applyModelVariant(payload.model, payload, undefined)).toBe('claude-opus-4.6-fast')
  })

  test('fast mode via header alone routes to claude-opus-4.6-fast', () => {
    const payload = makePayload('claude-opus-4.6')
    expect(applyModelVariant(payload.model, payload, 'fast-mode-2026-02-01')).toBe('claude-opus-4.6-fast')
  })

  test('1m context via header routes to claude-opus-4.6-1m', () => {
    const payload = makePayload('claude-opus-4.6')
    expect(applyModelVariant(payload.model, payload, 'context-1m-2025-08-07')).toBe('claude-opus-4.6-1m')
  })

  test('1m context routes claude-opus-4.7 to internal model', () => {
    const payload = makePayload('claude-opus-4.7')
    expect(applyModelVariant(payload.model, payload, 'context-1m-2025-08-07')).toBe('claude-opus-4.7-1m-internal')
  })

  test('1m context normalizes claude-opus-4-7 before routing', () => {
    const payload = makePayload('claude-opus-4-7')
    expect(applyModelVariant(payload.model, payload, 'context-1m-2025-08-07')).toBe('claude-opus-4.7-1m-internal')
  })

  test('no special signal only normalizes the model name', () => {
    const payload = makePayload('claude-opus-4-6')
    expect(applyModelVariant(payload.model, payload, undefined)).toBe('claude-opus-4.6')
  })

  test('fast takes priority over 1m when both signals are present', () => {
    const payload = makePayload('claude-opus-4.6', { speed: 'fast' })
    expect(applyModelVariant(payload.model, payload, 'context-1m-2025-08-07, fast-mode-2026-02-01')).toBe('claude-opus-4.6-fast')
  })

  test('beta header with claude-code prefix and context-1m together', () => {
    const payload = makePayload('claude-opus-4.6')
    expect(applyModelVariant(payload.model, payload, 'claude-code-2025-01-01, context-1m-2025-08-07')).toBe('claude-opus-4.6-1m')
  })

  test('model with date suffix is normalized before applying variant', () => {
    const payload = makePayload('claude-opus-4-6-20250514', { speed: 'fast' })
    expect(applyModelVariant(payload.model, payload, undefined)).toBe('claude-opus-4.6-fast')
  })

  test('non-opus models are not affected by variant signals', () => {
    const payload = makePayload('claude-sonnet-4.6', { speed: 'fast' })
    expect(applyModelVariant(payload.model, payload, 'fast-mode-2026-02-01')).toBe('claude-sonnet-4.6')
  })

  test('unknown models are returned unchanged', () => {
    const payload = makePayload('some-unknown-model')
    expect(applyModelVariant(payload.model, payload, undefined)).toBe('some-unknown-model')
  })
})

describe('anthropic beta helpers', () => {
  test('parseBetaFeatures handles comma-separated values', () => {
    const features = parseBetaFeatures('claude-code-2025-01-01, context-1m-2025-08-07')
    expect(features.has('claude-code-2025-01-01')).toBe(true)
    expect(features.has('context-1m-2025-08-07')).toBe(true)
  })

  test('parseBetaFeatures returns empty set for missing or empty headers', () => {
    expect(parseBetaFeatures(undefined).size).toBe(0)
    expect(parseBetaFeatures('').size).toBe(0)
  })

  test('sanitizeAnthropicBetaHeader strips features not forwarded to Copilot', () => {
    expect(sanitizeAnthropicBetaHeader('advisor-tool-2026-03-01')).toBeUndefined()
    expect(sanitizeAnthropicBetaHeader('context-1m-2025-08-07')).toBeUndefined()
    expect(sanitizeAnthropicBetaHeader('fast-mode-2026-02-01')).toBeUndefined()
    expect(sanitizeAnthropicBetaHeader('context-1m-2025-08-07,fast-mode-2026-02-01')).toBeUndefined()
  })

  test('sanitizeAnthropicBetaHeader preserves forwarded features', () => {
    expect(sanitizeAnthropicBetaHeader('claude-code-2025-01-01')).toBe('claude-code-2025-01-01')
    expect(sanitizeAnthropicBetaHeader('claude-code-2025-01-01, context-1m-2025-08-07, advisor-tool-2026-03-01')).toBe('claude-code-2025-01-01')
  })

  test('sanitizeAnthropicBetaHeader returns undefined for undefined input', () => {
    expect(sanitizeAnthropicBetaHeader(undefined)).toBeUndefined()
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

  test('variant -1m-internal falls back to base model', () => {
    const opus47Model: Model = { ...baseModel, id: 'claude-opus-4.7', name: 'Claude Opus 4.7' }
    const result = findModelWithFallback('claude-opus-4.7-1m-internal', [opus47Model])
    expect(result?.id).toBe('claude-opus-4.7')
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
