/**
 * Runtime API probe cache.
 *
 * When a model returns `unsupported_api_for_model`, we cache the fact that
 * it doesn't support that API type, so future requests skip straight to
 * the correct backend.
 *
 * Stores per-model-per-API entries: a single model can have multiple
 * unsupported APIs recorded simultaneously.
 */

import type { BackendApiType } from './model-config'

import consola from 'consola'

/** TTL for probe cache entries (30 minutes) */
const PROBE_CACHE_TTL_MS = 30 * 60 * 1000

/** model:api → timestamp */
const probeCache = new Map<string, number>()

function probeKey(modelId: string, api: BackendApiType): string {
  return `${modelId}:${api}`
}

/**
 * Check if an API has been previously probed as unsupported for a model.
 */
export function isApiProbedUnsupported(modelId: string, api: BackendApiType): boolean {
  const key = probeKey(modelId, api)
  const ts = probeCache.get(key)
  if (ts === undefined)
    return false

  // Check TTL
  if (Date.now() - ts > PROBE_CACHE_TTL_MS) {
    probeCache.delete(key)
    return false
  }

  return true
}

/**
 * Record that a model doesn't support a given API type.
 */
export function recordProbeResult(modelId: string, unsupportedApi: BackendApiType): void {
  consola.debug(`Probe cache: ${modelId} does not support ${unsupportedApi}`)
  probeCache.set(probeKey(modelId, unsupportedApi), Date.now())
}

/**
 * Check if an HTTPError indicates `unsupported_api_for_model`.
 * Parses the error body and returns the error code if found.
 */
export async function isUnsupportedApiError(response: Response): Promise<boolean> {
  try {
    const cloned = response.clone()
    const body = await cloned.json() as Record<string, unknown>
    const error = body?.error as Record<string, unknown> | undefined
    const code = error?.code
      ?? (typeof error?.message === 'string' && error.message.includes('unsupported_api_for_model')
        ? 'unsupported_api_for_model'
        : undefined)
    return code === 'unsupported_api_for_model'
  }
  catch {
    return false
  }
}

/** Clear the probe cache (for testing) */
export function clearProbeCache(): void {
  probeCache.clear()
}
