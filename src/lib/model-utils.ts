import type { Model, ModelsResponse } from '~/services/copilot/get-models'

/**
 * Find a model by ID, with fallback suffix stripping for variant models.
 * e.g., "claude-opus-4.6-fast" → tries exact, then falls back to "claude-opus-4.6"
 */
export function findModelWithFallback(modelId: string, models: Array<Model> | undefined): Model | undefined {
  if (!models)
    return undefined

  const exact = models.find(model => model.id === modelId)
  if (exact)
    return exact

  const baseModel = modelId.replace(/-(fast|1m)$/, '')
  if (baseModel !== modelId)
    return models.find(model => model.id === baseModel)

  return undefined
}

/**
 * Get a model's max_output_tokens from the models list.
 * Returns undefined if model not found or has no limit.
 */
export function findModelMaxOutputTokens(modelId: string, models: ModelsResponse | undefined): number | undefined {
  const model = findModelWithFallback(modelId, models?.data)
  return model?.capabilities?.limits?.max_output_tokens
}
