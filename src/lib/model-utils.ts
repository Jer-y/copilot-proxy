import type { Model, ModelsResponse } from '~/services/copilot/get-models'

import { getModelConfig } from './model-config'

/**
 * Find a model by ID, with fallback suffix stripping for future model variants.
 * e.g., "gpt-5.2-codex-experimental-latency" tries exact, then falls back to
 * "gpt-5.2-codex" when that base model is present.
 */
export function findModelWithFallback(modelId: string, models: Array<Model> | undefined): Model | undefined {
  if (!models)
    return undefined

  const exact = models.find(model => model.id === modelId)
  if (exact)
    return exact

  const prefixMatch = models
    .filter(model => modelId.startsWith(`${model.id}-`))
    .sort((a, b) => b.id.length - a.id.length)[0]
  if (prefixMatch)
    return prefixMatch

  return undefined
}

/**
 * Get the best verified max_output_tokens value for a model. Live model
 * metadata can lag the request boundary, so a dated static verification acts
 * as a floor while newer, larger live values remain authoritative.
 */
export function findModelMaxOutputTokens(modelId: string, models: ModelsResponse | undefined): number | undefined {
  const model = findModelWithFallback(modelId, models?.data)
  const advertisedLimit = model?.capabilities?.limits?.max_output_tokens
  const verifiedLimit = getModelConfig(modelId).verifiedMaxOutputTokens

  if (advertisedLimit === undefined) {
    return verifiedLimit
  }
  if (verifiedLimit === undefined) {
    return advertisedLimit
  }
  return Math.max(advertisedLimit, verifiedLimit)
}
