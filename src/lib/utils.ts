import type { AccountContext } from '~/lib/account/types'
import type { ModelsResponse } from '~/services/copilot/get-models'

import consola from 'consola'

import { getModels } from '~/services/copilot/get-models'
import { getVSCodeVersion } from '~/services/get-vscode-version'

import { state } from './state'

export const DEFAULT_MODEL_REFRESH_INTERVAL_MS = 15 * 60 * 1000

type ModelRefreshTimer = ReturnType<typeof setTimeout>
interface ModelRefreshRuntime {
  generation: number
  timer?: ModelRefreshTimer
}
const modelRefreshRuntimes = new WeakMap<AccountContext, ModelRefreshRuntime>()

interface ModelCatalogFetchDependencies {
  now?: () => number
}

type ModelCatalogFetcher = () => Promise<ModelsResponse>

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

export function cacheModels(
  fetchModels?: ModelCatalogFetcher,
  dependencies?: ModelCatalogFetchDependencies,
): Promise<void>
export function cacheModels(
  ctx: AccountContext,
  fetchModels?: ModelCatalogFetcher,
  dependencies?: ModelCatalogFetchDependencies,
): Promise<void>
export async function cacheModels(
  ctxOrFetchModels: AccountContext | ModelCatalogFetcher = state.defaultAccount,
  fetchModelsOrDependencies: ModelCatalogFetcher | ModelCatalogFetchDependencies = {},
  maybeDependencies: ModelCatalogFetchDependencies = {},
): Promise<void> {
  const { ctx, dependencies, fetchModels } = resolveModelCatalogArguments(
    ctxOrFetchModels,
    fetchModelsOrDependencies,
    maybeDependencies,
  )
  const now = dependencies.now ?? Date.now
  const attemptAt = now()
  try {
    const models = await fetchModels()
    assertModelCatalogSnapshot(models)
    ctx.models = models
    recordModelCatalogRefreshSuccess(ctx, attemptAt, now())
  }
  catch (error) {
    recordModelCatalogRefreshFailure(ctx, attemptAt, now())
    throw error
  }
}

export function refreshModelsSafely(
  fetchModels?: ModelCatalogFetcher,
  dependencies?: ModelCatalogFetchDependencies,
): Promise<boolean>
export function refreshModelsSafely(
  ctx: AccountContext,
  fetchModels?: ModelCatalogFetcher,
  dependencies?: ModelCatalogFetchDependencies,
): Promise<boolean>
export async function refreshModelsSafely(
  ctxOrFetchModels: AccountContext | ModelCatalogFetcher = state.defaultAccount,
  fetchModelsOrDependencies: ModelCatalogFetcher | ModelCatalogFetchDependencies = {},
  maybeDependencies: ModelCatalogFetchDependencies = {},
): Promise<boolean> {
  const { ctx, dependencies, fetchModels } = resolveModelCatalogArguments(
    ctxOrFetchModels,
    fetchModelsOrDependencies,
    maybeDependencies,
  )
  const now = dependencies.now ?? Date.now
  const attemptAt = now()
  try {
    const models = await fetchModels()
    assertModelCatalogSnapshot(models)
    // Replace the complete snapshot atomically so requests already holding the
    // previous object keep a consistent view while new requests see the update.
    ctx.models = models
    recordModelCatalogRefreshSuccess(ctx, attemptAt, now())
    consola.info(`Refreshed Copilot model inventory (${models.data.length} models)`)
    return true
  }
  catch (error) {
    recordModelCatalogRefreshFailure(ctx, attemptAt, now())
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

function recordModelCatalogRefreshSuccess(
  ctx: AccountContext,
  attemptAt: number,
  successAt: number,
): void {
  ctx.modelCatalogLifecycle = {
    consecutiveRefreshFailures: 0,
    lastRefreshAttemptAt: attemptAt,
    lastRefreshSuccessAt: successAt,
    ...(ctx.modelCatalogLifecycle?.lastRefreshFailureAt !== undefined && {
      lastRefreshFailureAt: ctx.modelCatalogLifecycle.lastRefreshFailureAt,
    }),
  }
}

function recordModelCatalogRefreshFailure(
  ctx: AccountContext,
  attemptAt: number,
  failureAt: number,
): void {
  ctx.modelCatalogLifecycle = {
    consecutiveRefreshFailures: (ctx.modelCatalogLifecycle?.consecutiveRefreshFailures ?? 0) + 1,
    lastRefreshAttemptAt: attemptAt,
    lastRefreshFailureAt: failureAt,
    ...(ctx.modelCatalogLifecycle?.lastRefreshSuccessAt !== undefined && {
      lastRefreshSuccessAt: ctx.modelCatalogLifecycle.lastRefreshSuccessAt,
    }),
  }
}

export function startModelRefresh(
  intervalMs?: number,
): void
export function startModelRefresh(
  ctx: AccountContext,
  intervalMs?: number,
): void
export function startModelRefresh(
  ctxOrInterval: AccountContext | number = state.defaultAccount,
  maybeInterval = DEFAULT_MODEL_REFRESH_INTERVAL_MS,
): void {
  const ctx = typeof ctxOrInterval === 'number' ? state.defaultAccount : ctxOrInterval
  const intervalMs = typeof ctxOrInterval === 'number' ? ctxOrInterval : maybeInterval
  stopModelRefresh(ctx)
  const runtime = getModelRefreshRuntime(ctx)
  const generation = runtime.generation
  const scheduleNext = () => {
    if (generation !== runtime.generation)
      return
    runtime.timer = setTimeout(() => {
      runtime.timer = undefined
      void refreshModelsSafely(ctx).finally(scheduleNext)
    }, intervalMs)
    runtime.timer.unref?.()
  }
  scheduleNext()
}

export function stopModelRefresh(ctx: AccountContext = state.defaultAccount): void {
  const runtime = getModelRefreshRuntime(ctx)
  runtime.generation++
  if (runtime.timer !== undefined) {
    clearTimeout(runtime.timer)
    runtime.timer = undefined
  }
}

export function isModelRefreshScheduled(ctx: AccountContext = state.defaultAccount): boolean {
  return getModelRefreshRuntime(ctx).timer !== undefined
}

export async function cacheVSCodeVersion(
  contexts: Iterable<AccountContext> = [state.defaultAccount],
) {
  const response = await getVSCodeVersion()
  state.vsCodeVersion = response
  for (const ctx of contexts)
    ctx.vsCodeVersion = response

  consola.info(`Using VSCode version: ${response}`)
}

function getModelRefreshRuntime(ctx: AccountContext): ModelRefreshRuntime {
  const existing = modelRefreshRuntimes.get(ctx)
  if (existing)
    return existing
  const runtime: ModelRefreshRuntime = { generation: 0 }
  modelRefreshRuntimes.set(ctx, runtime)
  return runtime
}

function resolveModelCatalogArguments(
  ctxOrFetchModels: AccountContext | ModelCatalogFetcher,
  fetchModelsOrDependencies: ModelCatalogFetcher | ModelCatalogFetchDependencies,
  maybeDependencies: ModelCatalogFetchDependencies,
): {
  ctx: AccountContext
  dependencies: ModelCatalogFetchDependencies
  fetchModels: ModelCatalogFetcher
} {
  if (typeof ctxOrFetchModels === 'function') {
    return {
      ctx: state.defaultAccount,
      fetchModels: ctxOrFetchModels,
      dependencies: typeof fetchModelsOrDependencies === 'function'
        ? maybeDependencies
        : fetchModelsOrDependencies,
    }
  }

  return {
    ctx: ctxOrFetchModels,
    fetchModels: typeof fetchModelsOrDependencies === 'function'
      ? fetchModelsOrDependencies
      : () => getModels(ctxOrFetchModels),
    dependencies: typeof fetchModelsOrDependencies === 'function'
      ? maybeDependencies
      : fetchModelsOrDependencies,
  }
}
