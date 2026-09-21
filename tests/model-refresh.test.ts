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

const originalModels = state.defaultAccount.models
const originalModelCatalogLifecycle = state.defaultAccount.modelCatalogLifecycle

afterEach(() => {
  stopModelRefresh(state.defaultAccount)
  state.defaultAccount.models = originalModels
  state.defaultAccount.modelCatalogLifecycle = originalModelCatalogLifecycle
})

describe('model inventory refresh', () => {
  test('failed startup fetch clears a previous initialization snapshot', async () => {
    state.defaultAccount.models = makeModels('previous-run')
    await expect(cacheModels(state.defaultAccount, { fetchModels: async () => {
      throw new Error('models unavailable')
    } })).rejects.toThrow('models unavailable')
    expect(state.defaultAccount.models).toBeUndefined()
  })

  test('an empty initial inventory cannot initialize an account', async () => {
    await expect(cacheModels(state.defaultAccount, { fetchModels: async () => ({ object: 'list', data: [] }) })).rejects.toThrow('model catalog is empty')
    expect(state.defaultAccount.models).toBeUndefined()
  })

  test('a successful empty refresh removes models instead of resurrecting a static catalog', async () => {
    state.defaultAccount.models = makeModels('removed-model')
    expect(await refreshModelsSafely(state.defaultAccount, { fetchModels: async () => ({ object: 'list', data: [] }) })).toBe(true)
    expect(state.defaultAccount.models?.data).toEqual([])
  })

  test('atomically replaces the model snapshot after a successful refresh', async () => {
    const previous = makeModels('old-model')
    const next = makeModels('new-model')
    state.defaultAccount.models = previous

    const times = [1_000, 1_100]
    expect(await refreshModelsSafely(state.defaultAccount, { fetchModels: async () => next, now: () => times.shift() ?? 0 })).toBe(true)
    expect(state.defaultAccount.models).toBe(next)
    expect(previous.data[0]?.id).toBe('old-model')
    expect(state.defaultAccount.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 1_000,
      lastRefreshSuccessAt: 1_100,
    })
  })

  test('keeps the prior snapshot when a periodic refresh fails', async () => {
    const previous = makeModels('stable-model')
    state.defaultAccount.models = previous
    state.defaultAccount.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 1_000,
      lastRefreshSuccessAt: 1_100,
    }
    const times = [2_000, 2_100]

    expect(await refreshModelsSafely(state.defaultAccount, { fetchModels: async () => {
      throw new Error('temporary models failure')
    }, now: () => times.shift() ?? 0 })).toBe(false)
    expect(state.defaultAccount.models).toBe(previous)
    expect(state.defaultAccount.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 1,
      lastRefreshAttemptAt: 2_000,
      lastRefreshFailureAt: 2_100,
      lastRefreshSuccessAt: 1_100,
    })
  })

  test('does not replace the prior snapshot with a malformed successful response', async () => {
    const previous = makeModels('stable-model')
    state.defaultAccount.models = previous
    state.defaultAccount.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 1_000,
      lastRefreshSuccessAt: 1_100,
    }
    const times = [2_000, 2_100]
    const malformed = { object: 'list' } as unknown as ModelsResponse

    expect(await refreshModelsSafely(state.defaultAccount, { fetchModels: async () => malformed, now: () => times.shift() ?? 0 })).toBe(false)

    expect(state.defaultAccount.models).toBe(previous)
    expect(state.defaultAccount.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 1,
      lastRefreshAttemptAt: 2_000,
      lastRefreshFailureAt: 2_100,
      lastRefreshSuccessAt: 1_100,
    })
  })

  test('keeps the prior snapshot when refreshed model capabilities are incomplete', async () => {
    const previous = makeModels('stable-model')
    state.defaultAccount.models = previous
    state.defaultAccount.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 1_000,
      lastRefreshSuccessAt: 1_100,
    }
    const times = [2_000, 2_100]
    const malformed = {
      object: 'list',
      data: [{ id: 'broken-model', supported_endpoints: ['/chat/completions'] }],
    } as unknown as ModelsResponse

    expect(await refreshModelsSafely(state.defaultAccount, { fetchModels: async () => malformed, now: () => times.shift() ?? 0 })).toBe(false)

    expect(state.defaultAccount.models).toBe(previous)
    expect(state.defaultAccount.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 1,
      lastRefreshAttemptAt: 2_000,
      lastRefreshFailureAt: 2_100,
      lastRefreshSuccessAt: 1_100,
    })
  })

  test('keeps the prior snapshot when refreshed model identity fields have invalid types', async () => {
    const previous = makeModels('stable-model')
    state.defaultAccount.models = previous
    const malformed = makeModels('broken-model') as unknown as {
      data: Array<Record<string, unknown>>
      object: string
    }
    malformed.data[0]!.name = 42

    expect(await refreshModelsSafely(state.defaultAccount, { fetchModels: async () => malformed as unknown as ModelsResponse })).toBe(false)
    expect(state.defaultAccount.models).toBe(previous)
  })

  test('accepts capability metadata without limits for non-routing catalog entries', async () => {
    const next = makeModels('embedding-inference')
    delete next.data[0]?.capabilities.limits

    expect(await refreshModelsSafely(state.defaultAccount, { fetchModels: async () => next })).toBe(true)
    expect(state.defaultAccount.models).toBe(next)
  })

  test('marks the initial catalog fetch as fresh', async () => {
    const times = [3_000, 3_100]
    const models = makeModels('initial-model')

    await cacheModels(state.defaultAccount, { fetchModels: async () => models, now: () => times.shift() ?? 0 })

    expect(state.defaultAccount.models).toBe(models)
    expect(state.defaultAccount.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 3_000,
      lastRefreshSuccessAt: 3_100,
    })
  })

  test('rejects a malformed initial catalog without marking it fresh', async () => {
    state.defaultAccount.models = undefined
    state.defaultAccount.modelCatalogLifecycle = undefined
    const times = [4_000, 4_100]
    const malformed = { object: 'list', data: [{ id: '' }] } as unknown as ModelsResponse

    await expect(cacheModels(state.defaultAccount, { fetchModels: async () => malformed, now: () => times.shift() ?? 0 })).rejects.toThrow('non-empty id')

    expect(state.defaultAccount.models).toBeUndefined()
    expect(state.defaultAccount).toMatchObject({
      modelCatalogLifecycle: {
        consecutiveRefreshFailures: 1,
        lastRefreshAttemptAt: 4_000,
        lastRefreshFailureAt: 4_100,
      },
    })
  })

  test('clears the stale state after a later successful refresh', async () => {
    state.defaultAccount.models = makeModels('stale-model')
    state.defaultAccount.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 2,
      lastRefreshAttemptAt: 4_000,
      lastRefreshFailureAt: 4_100,
      lastRefreshSuccessAt: 3_100,
    }
    const times = [5_000, 5_100]

    expect(await refreshModelsSafely(state.defaultAccount, { fetchModels: async () => makeModels('recovered-model'), now: () => times.shift() ?? 0 })).toBe(true)

    expect(state.defaultAccount.models?.data[0]?.id).toBe('recovered-model')
    expect(state.defaultAccount.modelCatalogLifecycle).toEqual({
      consecutiveRefreshFailures: 0,
      lastRefreshAttemptAt: 5_000,
      lastRefreshFailureAt: 4_100,
      lastRefreshSuccessAt: 5_100,
    })
  })

  test('replaces an existing periodic schedule instead of accumulating timers', () => {
    startModelRefresh(state.defaultAccount, 60_000)
    startModelRefresh(state.defaultAccount, 60_000)
    expect(isModelRefreshScheduled(state.defaultAccount)).toBe(true)
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
