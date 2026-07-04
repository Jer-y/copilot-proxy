import type { ResponsesPayload } from '../src/services/copilot/create-responses'

import { describe, expect, test } from 'bun:test'

import { applyCodexAutoReviewAlias, CODEX_AUTO_REVIEW_MODEL } from '../src/lib/codex-auto-review-alias'

function payloadFor(model: string): ResponsesPayload {
  return { model, input: 'ping' }
}

describe('applyCodexAutoReviewAlias', () => {
  test('rewrites codex-auto-review to the configured target', () => {
    const payload = payloadFor(CODEX_AUTO_REVIEW_MODEL)
    const applied = applyCodexAutoReviewAlias(payload, 'gpt-5.4-mini')
    expect(applied).toBe('gpt-5.4-mini')
    expect(payload.model).toBe('gpt-5.4-mini')
  })

  test('is a no-op when the target is undefined', () => {
    const payload = payloadFor(CODEX_AUTO_REVIEW_MODEL)
    const applied = applyCodexAutoReviewAlias(payload, undefined)
    expect(applied).toBeUndefined()
    expect(payload.model).toBe(CODEX_AUTO_REVIEW_MODEL)
  })

  test('leaves other models unchanged', () => {
    const payload = payloadFor('gpt-5.5')
    const applied = applyCodexAutoReviewAlias(payload, 'gpt-5.4-mini')
    expect(applied).toBeUndefined()
    expect(payload.model).toBe('gpt-5.5')
  })

  test('does not alias the guardian model to itself', () => {
    const payload = payloadFor(CODEX_AUTO_REVIEW_MODEL)
    const applied = applyCodexAutoReviewAlias(payload, CODEX_AUTO_REVIEW_MODEL)
    expect(applied).toBeUndefined()
    expect(payload.model).toBe(CODEX_AUTO_REVIEW_MODEL)
  })
})
