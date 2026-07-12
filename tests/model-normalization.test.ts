import { describe, expect, test } from 'bun:test'

import {
  normalizeAnthropicModelName,
  sanitizeAnthropicBetaHeader,
  toAnthropicClientModelName,
} from '../src/routes/messages/model-normalization'

describe('Anthropic model normalization', () => {
  test('normalizes dated Claude model IDs to Copilot base IDs', () => {
    expect(normalizeAnthropicModelName('claude-opus-4-6-20250514')).toBe('claude-opus-4.6')
    expect(normalizeAnthropicModelName('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4.5')
  })

  test('normalizes hyphenated Claude minor versions', () => {
    expect(normalizeAnthropicModelName('claude-opus-4-7')).toBe('claude-opus-4.7')
    expect(normalizeAnthropicModelName('claude-opus-4-8')).toBe('claude-opus-4.8')
  })

  test('does not route speed or context beta signals to hidden Claude variants', () => {
    expect(normalizeAnthropicModelName('claude-opus-4.6')).toBe('claude-opus-4.6')
    expect(normalizeAnthropicModelName('claude-opus-4.7')).toBe('claude-opus-4.7')
  })

  test('leaves unknown and non-Claude models unchanged', () => {
    expect(normalizeAnthropicModelName('some-unknown-model')).toBe('some-unknown-model')
    expect(normalizeAnthropicModelName('gpt-5.3-codex')).toBe('gpt-5.3-codex')
  })

  test('uses official hyphenated Claude IDs for generated client configuration', () => {
    expect(toAnthropicClientModelName('claude-opus-4.8')).toBe('claude-opus-4-8')
    expect(toAnthropicClientModelName('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(toAnthropicClientModelName('gpt-5.6-sol')).toBe('gpt-5.6-sol')
  })
})

describe('Anthropic beta header sanitization', () => {
  test('strips advisor beta when the advisor tool is removed locally', () => {
    expect(sanitizeAnthropicBetaHeader('advisor-tool-2026-03-01')).toBeUndefined()
  })

  test('preserves Claude context and fast beta features for upstream', () => {
    expect(sanitizeAnthropicBetaHeader('context-1m-2025-08-07')).toBe('context-1m-2025-08-07')
    expect(sanitizeAnthropicBetaHeader('fast-mode-2026-02-01')).toBe('fast-mode-2026-02-01')
    expect(sanitizeAnthropicBetaHeader('context-1m-2025-08-07, fast-mode-2026-02-01')).toBe('context-1m-2025-08-07, fast-mode-2026-02-01')
  })

  test('preserves forwarded features while removing only stripped ones', () => {
    expect(sanitizeAnthropicBetaHeader('claude-code-2025-01-01')).toBe('claude-code-2025-01-01')
    expect(sanitizeAnthropicBetaHeader('claude-code-2025-01-01, context-1m-2025-08-07, advisor-tool-2026-03-01')).toBe('claude-code-2025-01-01, context-1m-2025-08-07')
  })

  test('returns undefined for undefined input', () => {
    expect(sanitizeAnthropicBetaHeader(undefined)).toBeUndefined()
  })
})
