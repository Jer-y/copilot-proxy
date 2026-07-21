import type { ModelsResponse } from '~/services/copilot/get-models'

import consola from 'consola'

import { getModels } from '~/services/copilot/get-models'
import { getVSCodeVersion } from '~/services/get-vscode-version'

import { state } from './state'

export const DEFAULT_MODEL_REFRESH_INTERVAL_MS = 15 * 60 * 1000

type ModelRefreshTimer = ReturnType<typeof setTimeout>
let modelRefreshTimer: ModelRefreshTimer | undefined
let modelRefreshGeneration = 0

interface ModelCatalogFetchDependencies {
  now?: () => number
}

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

export async function cacheModels(
  fetchModels: typeof getModels = getModels,
  dependencies: ModelCatalogFetchDependencies = {},
): Promise<void> {
  const now = dependencies.now ?? Date.now
  const attemptAt = now()
  try {
    const models = await fetchModels()
    assertModelCatalogSnapshot(models)
    state.models = models
    recordModelCatalogRefreshSuccess(attemptAt, now())
  }
  catch (error) {
    recordModelCatalogRefreshFailure(attemptAt, now())
    throw error
  }
}

export async function refreshModelsSafely(
  fetchModels: typeof getModels = getModels,
  dependencies: ModelCatalogFetchDependencies = {},
): Promise<boolean> {
  const now = dependencies.now ?? Date.now
  const attemptAt = now()
  try {
    const models = await fetchModels()
    assertModelCatalogSnapshot(models)
    // Replace the complete snapshot atomically so requests already holding the
    // previous object keep a consistent view while new requests see the update.
    state.models = models
    recordModelCatalogRefreshSuccess(attemptAt, now())
    consola.info(`Refreshed Copilot model inventory (${models.data.length} models)`)
    return true
  }
  catch (error) {
    recordModelCatalogRefreshFailure(attemptAt, now())
    consola.warn('Failed to refresh Copilot model inventory; keeping the previous snapshot.', error)
    return false
  }
}

export function assertModelCatalogSnapshot(models: ModelsResponse): void {
  if (!models || typeof models !== 'object' || !Array.isArray(models.data))
    throw new TypeError('Copilot model inventory must contain a data array')

  for (const [index, model] of models.data.entries()) {
    if (!model || typeof model !== 'object' || typeof model.id !== 'string' || !model.id.trim())
      throw new TypeError(`Copilot model inventory entry ${index} must contain a non-empty id`)
    for (const [field, value] of [
      ['name', model.name],
      ['object', model.object],
      ['vendor', model.vendor],
      ['version', model.version],
    ] as const) {
      if (typeof value !== 'string')
        throw new TypeError(`Copilot model inventory entry ${index} must contain a string ${field}`)
    }
    if (typeof model.model_picker_enabled !== 'boolean')
      throw new TypeError(`Copilot model inventory entry ${index} must contain boolean model_picker_enabled`)
    if (typeof model.preview !== 'boolean')
      throw new TypeError(`Copilot model inventory entry ${index} must contain boolean preview`)
    const capabilities = model.capabilities as unknown
    if (!isRecord(capabilities))
      throw new TypeError(`Copilot model inventory entry ${index} must contain capabilities`)
    for (const field of ['family', 'object', 'type'] as const) {
      if (typeof capabilities[field] !== 'string')
        throw new TypeError(`Copilot model inventory entry ${index} capabilities must contain a string ${field}`)
    }
    if (capabilities.limits !== undefined && !isRecord(capabilities.limits))
      throw new TypeError(`Copilot model inventory entry ${index} capabilities must contain limits`)
    if (capabilities.supports !== undefined && !isRecord(capabilities.supports))
      throw new TypeError(`Copilot model inventory entry ${index} capabilities must contain supports`)
    if (
      capabilities.tokenizer !== undefined
      && (typeof capabilities.tokenizer !== 'string' || !capabilities.tokenizer.trim())
    ) {
      throw new TypeError(`Copilot model inventory entry ${index} capabilities must contain a tokenizer`)
    }
    if (isRecord(capabilities.limits)) {
      for (const field of ['max_context_window_tokens', 'max_output_tokens', 'max_prompt_tokens', 'max_inputs'] as const) {
        const value = capabilities.limits[field]
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
          throw new TypeError(`Copilot model inventory entry ${index} capabilities.limits.${field} must be a non-negative number`)
      }
    }
    if (isRecord(capabilities.supports)) {
      for (const field of ['tool_calls', 'parallel_tool_calls', 'dimensions', 'vision', 'web_search'] as const) {
        const value = capabilities.supports[field]
        if (value !== undefined && typeof value !== 'boolean')
          throw new TypeError(`Copilot model inventory entry ${index} capabilities.supports.${field} must be boolean`)
      }
      const reasoningEffort = capabilities.supports.reasoning_effort
      if (
        reasoningEffort !== undefined
        && (!Array.isArray(reasoningEffort) || !reasoningEffort.every(value => typeof value === 'string'))
      ) {
        throw new TypeError(`Copilot model inventory entry ${index} capabilities.supports.reasoning_effort must be a string array`)
      }
    }
    if (
      model.supported_endpoints !== undefined
      && (!Array.isArray(model.supported_endpoints) || !model.supported_endpoints.every(endpoint => typeof endpoint === 'string'))
    ) {
      throw new TypeError(`Copilot model inventory entry ${index} has invalid supported_endpoints`)
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordModelCatalogRefreshSuccess(attemptAt: number, successAt: number): void {
  state.modelCatalogLifecycle = {
    consecutiveRefreshFailures: 0,
    lastRefreshAttemptAt: attemptAt,
    lastRefreshSuccessAt: successAt,
    ...(state.modelCatalogLifecycle?.lastRefreshFailureAt !== undefined && {
      lastRefreshFailureAt: state.modelCatalogLifecycle.lastRefreshFailureAt,
    }),
  }
}

function recordModelCatalogRefreshFailure(attemptAt: number, failureAt: number): void {
  state.modelCatalogLifecycle = {
    consecutiveRefreshFailures: (state.modelCatalogLifecycle?.consecutiveRefreshFailures ?? 0) + 1,
    lastRefreshAttemptAt: attemptAt,
    lastRefreshFailureAt: failureAt,
    ...(state.modelCatalogLifecycle?.lastRefreshSuccessAt !== undefined && {
      lastRefreshSuccessAt: state.modelCatalogLifecycle.lastRefreshSuccessAt,
    }),
  }
}

export function startModelRefresh(
  intervalMs = DEFAULT_MODEL_REFRESH_INTERVAL_MS,
): void {
  stopModelRefresh()
  const generation = modelRefreshGeneration
  const scheduleNext = () => {
    if (generation !== modelRefreshGeneration)
      return
    modelRefreshTimer = setTimeout(() => {
      modelRefreshTimer = undefined
      void refreshModelsSafely().finally(scheduleNext)
    }, intervalMs)
    modelRefreshTimer.unref?.()
  }
  scheduleNext()
}

export function stopModelRefresh(): void {
  modelRefreshGeneration++
  if (modelRefreshTimer !== undefined) {
    clearTimeout(modelRefreshTimer)
    modelRefreshTimer = undefined
  }
}

export function isModelRefreshScheduled(): boolean {
  return modelRefreshTimer !== undefined
}

export async function cacheVSCodeVersion() {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}
