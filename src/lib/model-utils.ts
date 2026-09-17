import type { Model, ModelsResponse } from '~/services/copilot/get-models'

/** Only exact IDs in the selected account's fetched catalog are available. */
export function findModel(modelId: string, models: Array<Model> | undefined): Model | undefined {
  return models?.find(model => model.id === modelId)
}

/** Defaults come from the fetched catalog; missing limits stay unspecified. */
export function findModelMaxOutputTokens(modelId: string, models: ModelsResponse | undefined): number | undefined {
  return findModel(modelId, models?.data)?.capabilities?.limits?.max_output_tokens
}
