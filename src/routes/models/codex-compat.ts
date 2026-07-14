import type { Model } from '~/services/copilot/get-models'

import consola from 'consola'

import { HTTPError } from '~/lib/error'
import { getModelConfig } from '~/lib/model-config'
import { throwOpenAIInvalidRequestError } from '~/lib/openai-compat'
import { fetchWithTimeout } from '~/lib/upstream-fetch'

type CodexInputModality = 'text' | 'image'

interface CodexModelInfo extends Record<string, unknown> {
  slug: string
  input_modalities?: Array<CodexInputModality>
  supports_search_tool?: boolean
  supports_image_detail_original?: boolean
}

interface CodexModelsResponse {
  models: Array<CodexModelInfo>
}

const CODEX_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\d.a-z-]+)?$/i
const CODEX_CATALOG_FETCH_TIMEOUT_MS = 5_000
const CODEX_CATALOG_CACHE_MAX_ENTRIES = 16
const CODEX_CATALOG_FAILURE_CACHE_MS = 30_000
export const CODEX_CATALOG_MAX_IN_FLIGHT = 4
export const CODEX_CATALOG_MAX_PENDING_KEYS = 16
export const CODEX_CATALOG_MAX_FAILURE_KEYS = 32
// Codex derives the compact threshold at 90% of the usable context window.
const CODEX_AUTO_COMPACT_PROMPT_WINDOW_RATIO = 0.9
const codexCatalogCache = new Map<string, CodexModelsResponse>()
const codexCatalogFailureCache = new Map<string, CodexCatalogFailure>()
const codexCatalogInFlight = new Map<string, Promise<CodexModelsResponse>>()
const codexCatalogFetchWaiters: Array<() => void> = []
let activeCodexCatalogFetches = 0

interface CodexCatalogFailure {
  error: unknown
  expiresAt: number
}

export function isCodexModelsRequest(url: URL): boolean {
  return url.searchParams.has('client_version')
}

export async function toCodexModelsResponse(models: Array<Model>, url: URL): Promise<CodexModelsResponse> {
  const clientVersion = url.searchParams.get('client_version')
  if (!clientVersion || !CODEX_VERSION_PATTERN.test(clientVersion)) {
    throwOpenAIInvalidRequestError('Invalid Codex client_version')
  }

  const bundledCatalog = await fetchCodexBundledCatalog(clientVersion)
  const bundledModelsBySlug = new Map(
    bundledCatalog.models.map(model => [model.slug, model]),
  )
  const codexModels: Array<CodexModelInfo> = []
  const droppedModels: Array<string> = []

  for (const model of models) {
    if (!model.model_picker_enabled || !modelSupportsResponses(model)) {
      continue
    }

    const codexModel = toCodexModelInfo(model, bundledModelsBySlug.get(model.id))
    if (codexModel) {
      codexModels.push(codexModel)
    }
    else {
      droppedModels.push(model.id)
    }
  }

  if (droppedModels.length > 0) {
    consola.debug(`Dropped Copilot model(s) missing from Codex bundled catalog: ${droppedModels.join(', ')}`)
  }

  return { models: codexModels }
}

export function createCodexModelsResponseEtag(response: CodexModelsResponse): string {
  let hash = 0x811C9DC5
  for (const char of JSON.stringify(response)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }

  return `"codex-models-${hash.toString(16).padStart(8, '0')}"`
}

function toCodexModelInfo(model: Model, bundledModel: CodexModelInfo | undefined): CodexModelInfo | undefined {
  if (!bundledModel) {
    return undefined
  }

  const context = getCodexContextWindow(model)
  const inputModalities = getInputModalities(model, bundledModel)
  const patchedModel: CodexModelInfo = {
    ...bundledModel,
    supported_in_api: true,
    supports_parallel_tool_calls: getSupportsParallelToolCalls(model),
    supports_image_detail_original: getSupportsImageDetailOriginal(),
    supports_search_tool: getSupportsSearchTool(model, bundledModel),
  }

  if (inputModalities) {
    patchedModel.input_modalities = inputModalities
  }

  if (context) {
    patchedModel.context_window = context.contextWindow
    patchedModel.max_context_window = context.contextWindow
    patchedModel.auto_compact_token_limit = context.autoCompactTokenLimit
    patchedModel.effective_context_window_percent = context.effectiveContextWindowPercent
  }

  return patchedModel
}

async function fetchCodexBundledCatalog(clientVersion: string): Promise<CodexModelsResponse> {
  const cachedCatalog = codexCatalogCache.get(clientVersion)
  if (cachedCatalog)
    return cachedCatalog

  const cachedFailure = getCachedCodexCatalogFailure(clientVersion)
  if (cachedFailure)
    throw cachedFailure

  const existingRequest = codexCatalogInFlight.get(clientVersion)
  if (existingRequest)
    return await existingRequest

  pruneExpiredCodexCatalogFailures()
  if (codexCatalogInFlight.size >= CODEX_CATALOG_MAX_PENDING_KEYS) {
    throwCodexCatalogCapacityError(
      'Codex catalog fetch queue is full.',
      'catalog_fetch_queue_full',
      Math.ceil(CODEX_CATALOG_FETCH_TIMEOUT_MS / 1000),
    )
  }
  // Reserve enough failure-cache capacity for every admitted in-flight key.
  // This keeps the negative cache bounded even if all queued requests fail.
  if (codexCatalogFailureCache.size + codexCatalogInFlight.size >= CODEX_CATALOG_MAX_FAILURE_KEYS) {
    throwCodexCatalogCapacityError(
      'Codex catalog failure cache is full.',
      'catalog_failure_cache_full',
      getCodexCatalogFailureRetryAfterSeconds(),
    )
  }

  const request = withCodexCatalogFetchSlot(
    () => fetchCodexBundledCatalogUncached(clientVersion),
  ).then((catalog) => {
    cacheSuccessfulCodexCatalog(clientVersion, catalog)
    return catalog
  }).catch((error: unknown) => {
    cacheCodexCatalogFailure(clientVersion, error)
    throw error
  }).finally(() => {
    if (codexCatalogInFlight.get(clientVersion) === request)
      codexCatalogInFlight.delete(clientVersion)
  })
  codexCatalogInFlight.set(clientVersion, request)

  return await request
}

function cacheSuccessfulCodexCatalog(clientVersion: string, catalog: CodexModelsResponse): void {
  pruneCodexCatalogCache()
  codexCatalogCache.set(clientVersion, catalog)
}

function cacheCodexCatalogFailure(clientVersion: string, error: unknown): void {
  const failure: CodexCatalogFailure = {
    error,
    expiresAt: Date.now() + CODEX_CATALOG_FAILURE_CACHE_MS,
  }
  codexCatalogFailureCache.set(clientVersion, failure)
  const timer = setTimeout(() => {
    if (codexCatalogFailureCache.get(clientVersion) === failure)
      codexCatalogFailureCache.delete(clientVersion)
  }, CODEX_CATALOG_FAILURE_CACHE_MS)
  timer.unref?.()
}

function getCachedCodexCatalogFailure(clientVersion: string): unknown {
  const failure = codexCatalogFailureCache.get(clientVersion)
  if (!failure)
    return undefined
  if (failure.expiresAt <= Date.now()) {
    codexCatalogFailureCache.delete(clientVersion)
    return undefined
  }
  return failure.error
}

function pruneExpiredCodexCatalogFailures(): void {
  const now = Date.now()
  for (const [clientVersion, failure] of codexCatalogFailureCache) {
    if (failure.expiresAt <= now)
      codexCatalogFailureCache.delete(clientVersion)
  }
}

function getCodexCatalogFailureRetryAfterSeconds(): number {
  const earliestExpiry = Math.min(
    ...Array.from(codexCatalogFailureCache.values(), failure => failure.expiresAt),
  )
  return Number.isFinite(earliestExpiry)
    ? Math.max(1, Math.ceil((earliestExpiry - Date.now()) / 1000))
    : Math.ceil(CODEX_CATALOG_FAILURE_CACHE_MS / 1000)
}

function throwCodexCatalogCapacityError(
  reason: string,
  code: 'catalog_failure_cache_full' | 'catalog_fetch_queue_full',
  retryAfterSeconds: number,
): never {
  const message = `${reason} Retry after ${retryAfterSeconds} seconds.`
  throw new HTTPError(
    message,
    Response.json({
      error: {
        message,
        type: 'rate_limit_error',
        code,
      },
    }, {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    }),
  )
}

export function resetCodexCatalogStateForTesting(): void {
  if (activeCodexCatalogFetches !== 0 || codexCatalogFetchWaiters.length !== 0 || codexCatalogInFlight.size !== 0)
    throw new Error('Cannot reset Codex catalog state while fetches are pending')
  codexCatalogCache.clear()
  codexCatalogFailureCache.clear()
}

async function withCodexCatalogFetchSlot<T>(fetchCatalog: () => Promise<T>): Promise<T> {
  await acquireCodexCatalogFetchSlot()
  try {
    return await fetchCatalog()
  }
  finally {
    releaseCodexCatalogFetchSlot()
  }
}

function acquireCodexCatalogFetchSlot(): Promise<void> {
  if (activeCodexCatalogFetches < CODEX_CATALOG_MAX_IN_FLIGHT) {
    activeCodexCatalogFetches++
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    codexCatalogFetchWaiters.push(() => {
      activeCodexCatalogFetches++
      resolve()
    })
  })
}

function releaseCodexCatalogFetchSlot(): void {
  activeCodexCatalogFetches--
  codexCatalogFetchWaiters.shift()?.()
}

function pruneCodexCatalogCache(): void {
  while (codexCatalogCache.size >= CODEX_CATALOG_CACHE_MAX_ENTRIES) {
    const oldestKey = codexCatalogCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    codexCatalogCache.delete(oldestKey)
  }
}

async function fetchCodexBundledCatalogUncached(clientVersion: string): Promise<CodexModelsResponse> {
  const response = await fetchWithTimeout(
    `https://raw.githubusercontent.com/openai/codex/rust-v${clientVersion}/codex-rs/models-manager/models.json`,
    {},
    {
      timeoutMs: CODEX_CATALOG_FETCH_TIMEOUT_MS,
      timeoutLabel: `Codex bundled model catalog ${clientVersion}`,
    },
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch Codex bundled model catalog for ${clientVersion}: ${response.status} ${response.statusText}`)
  }

  const catalog = await response.json()
  if (!isCodexModelsResponse(catalog)) {
    throw new Error(`Invalid Codex bundled model catalog for ${clientVersion}`)
  }

  return catalog
}

function isCodexModelsResponse(value: unknown): value is CodexModelsResponse {
  return typeof value === 'object'
    && value !== null
    && Array.isArray((value as { models?: unknown }).models)
    && (value as { models: Array<unknown> }).models.every(isCodexModelInfo)
}

function isCodexModelInfo(value: unknown): value is CodexModelInfo {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { slug?: unknown }).slug === 'string'
}

function modelSupportsResponses(model: Model): boolean {
  if (model.supported_endpoints?.length) {
    return model.supported_endpoints.some(endpoint => isResponsesEndpoint(endpoint))
  }

  return getModelConfig(model.id).supportedApis.includes('responses')
}

function isResponsesEndpoint(endpoint: string): boolean {
  const normalized = endpoint.toLowerCase()
  return normalized === 'responses'
    || normalized === '/responses'
    || normalized === '/v1/responses'
    || normalized === 'ws:/responses'
    || normalized === 'wss:/responses'
}

function getCodexContextWindow(model: Model): {
  contextWindow: number
  effectiveContextWindowPercent: number
  autoCompactTokenLimit: number
} | undefined {
  const limits = model.capabilities.limits
  const contextWindow = toPositiveInteger(limits.max_context_window_tokens)
    ?? toPositiveInteger(limits.max_prompt_tokens)
  if (!contextWindow) {
    return undefined
  }

  const promptWindow = toPositiveInteger(limits.max_prompt_tokens)
    ?? contextWindow
  const effectiveContextWindowPercent = promptWindow < contextWindow
    ? Math.max(1, Math.floor((promptWindow / contextWindow) * 100))
    : 100

  return {
    contextWindow,
    effectiveContextWindowPercent,
    autoCompactTokenLimit: Math.floor(promptWindow * CODEX_AUTO_COMPACT_PROMPT_WINDOW_RATIO),
  }
}

function toPositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }

  return Math.floor(value)
}

function getInputModalities(model: Model, bundledModel: CodexModelInfo): Array<CodexInputModality> | undefined {
  if (model.capabilities.supports.vision === true) {
    return ['text', 'image']
  }

  if (model.capabilities.supports.vision === false) {
    return ['text']
  }

  return getBundledInputModalities(bundledModel)
}

function getBundledInputModalities(model: CodexModelInfo): Array<CodexInputModality> | undefined {
  if (!Array.isArray(model.input_modalities)) {
    return undefined
  }

  const modalities = model.input_modalities.filter(isCodexInputModality)
  return modalities.length > 0 ? modalities : undefined
}

function isCodexInputModality(value: unknown): value is CodexInputModality {
  return value === 'text' || value === 'image'
}

function getSupportsSearchTool(model: Model, bundledModel: CodexModelInfo): boolean {
  const upstreamSupport = model.capabilities.supports.web_search
  if (upstreamSupport !== undefined) {
    return upstreamSupport
  }

  return bundledModel.supports_search_tool ?? false
}

function getSupportsImageDetailOriginal(): boolean {
  // Copilot /responses currently rejects input_image detail="original"; do not advertise it to Codex.
  return false
}

function getSupportsParallelToolCalls(model: Model): boolean {
  return model.capabilities.supports.parallel_tool_calls
    ?? getModelConfig(model.id).supportsParallelToolCalls
    ?? false
}
