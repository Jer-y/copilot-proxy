import type { Model } from '~/services/copilot/get-models'

import consola from 'consola'

import { getModelConfig } from '~/lib/model-config'
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
// Codex derives the compact threshold at 90% of the usable context window.
const CODEX_AUTO_COMPACT_PROMPT_WINDOW_RATIO = 0.9
const codexCatalogCache = new Map<string, Promise<CodexModelsResponse>>()

export function isCodexModelsRequest(url: URL): boolean {
  return url.searchParams.has('client_version')
}

export async function toCodexModelsResponse(models: Array<Model>, url: URL): Promise<CodexModelsResponse> {
  const clientVersion = url.searchParams.get('client_version')
  if (!clientVersion || !CODEX_VERSION_PATTERN.test(clientVersion)) {
    throw new Error('Invalid Codex client_version')
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
  let cachedCatalog = codexCatalogCache.get(clientVersion)
  if (!cachedCatalog) {
    cachedCatalog = fetchCodexBundledCatalogUncached(clientVersion).catch((error: unknown) => {
      codexCatalogCache.delete(clientVersion)
      throw error
    })
    pruneCodexCatalogCache()
    codexCatalogCache.set(clientVersion, cachedCatalog)
  }

  return await cachedCatalog
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
