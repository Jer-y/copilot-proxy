import { describe, expect, test } from 'bun:test'

import { findModel, findModelMaxOutputTokens } from '~/lib/model-utils'
import { makeModel } from './model-fixtures'

describe('fetched model lookup', () => {
  test('requires an exact catalog ID instead of guessing a family or variant', () => {
    const model = makeModel('gpt-5.2-codex', ['/responses'])
    expect(findModel(model.id, [model])).toBe(model)
    expect(findModel('gpt-5.2-codex-experimental-latency', [model])).toBeUndefined()
    expect(findModel('gpt-5.2', [model])).toBeUndefined()
    expect(findModel(model.id, undefined)).toBeUndefined()
    expect(findModel(model.id, [])).toBeUndefined()
  })

  test('uses only the selected account catalog output limit', () => {
    const model = makeModel('claude-opus-4.8', ['/v1/messages'])
    const models = { object: 'list', data: [model] }
    expect(findModelMaxOutputTokens(model.id, models)).toBe(64_000)
    model.capabilities.limits = { max_output_tokens: 16_000 }
    expect(findModelMaxOutputTokens(model.id, models)).toBe(16_000)
    model.capabilities.limits = { max_output_tokens: 256_000 }
    expect(findModelMaxOutputTokens(model.id, models)).toBe(256_000)
    model.capabilities.limits = {}
    expect(findModelMaxOutputTokens(model.id, models)).toBeUndefined()
    expect(findModelMaxOutputTokens(model.id, undefined)).toBeUndefined()
    expect(findModelMaxOutputTokens('claude-opus-4.8-other', models)).toBeUndefined()
  })
})
