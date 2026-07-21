import type { ModelsResponse } from '~/services/copilot/get-models'

import { afterEach, describe, expect, test } from 'bun:test'

import { state } from '~/lib/state'
import {
  cacheModels,
  isModelRefreshScheduled,
  refreshModelsSafely,
  startModelRefresh,
  stopModelRefresh,
} from '~/lib/utils'

const originalModels = state.models
const originalModelCatalogLifecycle = state.modelCatalogLifecycle

afterEach(() => {
  stopModelRefresh()
  state.models = originalModels
  state.modelCatalogLifecycle = originalModelCatalogLifecycle
})

describe('model inventory refresh', () => {
  test('atomically replaces the model snapshot after a successful refresh', async () => {
    const previous = makeModels('old-model')
    const next = makeModels('new-model')
    state.models = previous

    const times = [1_000, 1_100]
    expect(await refreshModelsSafely(async () => next, {
      now: () => times.shift() ?? 0,
    })).toBe(true)
    expect(state.models).toBe(next)
    expect(previous.data[0]?.id).toBe('old-model')
    expect(state.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 1_000,
      lastRefreshSuccessAt: 1_100,
    })
  })

  test('keeps the prior snapshot when a periodic refresh fails', async () => {
    const previous = makeModels('stable-model')
    state.models = previous
    state.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 1_000,
      lastRefreshSuccessAt: 1_100,
    }
    const times = [2_000, 2_100]

    expect(await refreshModelsSafely(async () => {
      throw new Error('temporary models failure')
    }, { now: () => times.shift() ?? 0 })).toBe(false)
    expect(state.models).toBe(previous)
    expect(state.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 1,
      lastRefreshAttemptAt: 2_000,
      lastRefreshFailureAt: 2_100,
      lastRefreshSuccessAt: 1_100,
    })
  })

  test('does not replace the prior snapshot with a malformed successful response', async () => {
    const previous = makeModels('stable-model')
    state.models = previous
    state.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 1_000,
      lastRefreshSuccessAt: 1_100,
    }
    const times = [2_000, 2_100]
    const malformed = { object: 'list' } as unknown as ModelsResponse

    expect(await refreshModelsSafely(async () => malformed, {
      now: () => times.shift() ?? 0,
    })).toBe(false)

    expect(state.models).toBe(previous)
    expect(state.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 1,
      lastRefreshAttemptAt: 2_000,
      lastRefreshFailureAt: 2_100,
      lastRefreshSuccessAt: 1_100,
    })
  })

  test('keeps the prior snapshot when refreshed model capabilities are incomplete', async () => {
    const previous = makeModels('stable-model')
    state.models = previous
    state.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 1_000,
      lastRefreshSuccessAt: 1_100,
    }
    const times = [2_000, 2_100]
    const malformed = {
      object: 'list',
      data: [{ id: 'broken-model', supported_endpoints: ['/chat/completions'] }],
    } as unknown as ModelsResponse

    expect(await refreshModelsSafely(async () => malformed, {
      now: () => times.shift() ?? 0,
    })).toBe(false)

    expect(state.models).toBe(previous)
    expect(state.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 1,
      lastRefreshAttemptAt: 2_000,
      lastRefreshFailureAt: 2_100,
      lastRefreshSuccessAt: 1_100,
    })
  })

  test('keeps the prior snapshot when refreshed model identity fields have invalid types', async () => {
    const previous = makeModels('stable-model')
    state.models = previous
    const malformed = makeModels('broken-model') as unknown as {
      data: Array<Record<string, unknown>>
      object: string
    }
    malformed.data[0]!.name = 42

    expect(await refreshModelsSafely(async () => malformed as unknown as ModelsResponse)).toBe(false)
    expect(state.models).toBe(previous)
  })

  test('accepts capability metadata without limits for non-routing catalog entries', async () => {
    const next = makeModels('embedding-inference')
    delete next.data[0]?.capabilities.limits

    expect(await refreshModelsSafely(async () => next)).toBe(true)
    expect(state.models).toBe(next)
  })

  test('marks the initial catalog fetch as fresh', async () => {
    const times = [3_000, 3_100]
    const models = makeModels('initial-model')

    await cacheModels(async () => models, { now: () => times.shift() ?? 0 })

    expect(state.models).toBe(models)
    expect(state.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 3_000,
      lastRefreshSuccessAt: 3_100,
    })
  })

  test('rejects a malformed initial catalog without marking it fresh', async () => {
    state.models = undefined
    state.modelCatalogLifecycle = undefined
    const times = [4_000, 4_100]
    const malformed = { object: 'list', data: [{ id: '' }] } as unknown as ModelsResponse

    await expect(cacheModels(async () => malformed, {
      now: () => times.shift() ?? 0,
    })).rejects.toThrow('non-empty id')

    expect(state.models).toBeUndefined()
    expect(state).toMatchObject({
      modelCatalogLifecycle: {
        consecutiveRefreshFailures: 1,
        lastRefreshAttemptAt: 4_000,
        lastRefreshFailureAt: 4_100,
      },
    })
  })

  test('clears the stale state after a later successful refresh', async () => {
    state.models = makeModels('stale-model')
    state.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 2,
      lastRefreshAttemptAt: 4_000,
      lastRefreshFailureAt: 4_100,
      lastRefreshSuccessAt: 3_100,
    }
    const times = [5_000, 5_100]

    expect(await refreshModelsSafely(async () => makeModels('recovered-model'), {
      now: () => times.shift() ?? 0,
    })).toBe(true)

    expect(state.models?.data[0]?.id).toBe('recovered-model')
    expect(state.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 5_000,
      lastRefreshFailureAt: 4_100,
      lastRefreshSuccessAt: 5_100,
    })
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
