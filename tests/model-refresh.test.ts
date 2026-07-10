import type { ModelsResponse } from '~/services/copilot/get-models'

import { afterEach, describe, expect, test } from 'bun:test'

import { state } from '~/lib/state'
import {
  isModelRefreshScheduled,
  refreshModelsSafely,
  startModelRefresh,
  stopModelRefresh,
} from '~/lib/utils'

const originalModels = state.models

afterEach(() => {
  stopModelRefresh()
  state.models = originalModels
})

describe('model inventory refresh', () => {
  test('atomically replaces the model snapshot after a successful refresh', async () => {
    const previous = makeModels('old-model')
    const next = makeModels('new-model')
    state.models = previous

    expect(await refreshModelsSafely(async () => next)).toBe(true)
    expect(state.models).toBe(next)
    expect(previous.data[0]?.id).toBe('old-model')
  })

  test('keeps the prior snapshot when a periodic refresh fails', async () => {
    const previous = makeModels('stable-model')
    state.models = previous

    expect(await refreshModelsSafely(async () => {
      throw new Error('temporary models failure')
    })).toBe(false)
    expect(state.models).toBe(previous)
  })

  test('replaces an existing periodic schedule instead of accumulating timers', () => {
    startModelRefresh(60_000)
    startModelRefresh(60_000)
    expect(isModelRefreshScheduled()).toBe(true)
  })
})

function makeModels(id: string): ModelsResponse {
  return {
    object: 'list',
    data: [{
      id,
      name: id,
      object: 'model',
      model_picker_enabled: true,
      preview: false,
      vendor: 'test',
      version: '1',
      capabilities: {
        family: 'test',
        limits: {},
        object: 'model_capabilities',
        supports: {},
        tokenizer: 'test',
        type: 'chat',
      },
    }],
  }
}
