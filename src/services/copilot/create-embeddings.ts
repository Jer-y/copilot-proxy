import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'

export async function createEmbeddings(
  payload: EmbeddingRequest,
  options?: { signal?: AbortSignal },
) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const normalizedPayload = {
    ...payload,
    // Copilot upstream rejects scalar input even though OpenAI embeddings accepts it.
    input: Array.isArray(payload.input) ? payload.input : [payload.input],
  }

  const response = await fetch(`${copilotBaseUrl(state)}/embeddings`, {
    method: 'POST',
    headers: copilotHeaders(state),
    body: JSON.stringify(normalizedPayload),
    signal: options?.signal,
  })

  if (!response.ok)
    throw new HTTPError('Failed to create embeddings', response)

  return (await response.json()) as EmbeddingResponse
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
}

export interface Embedding {
  object: string
  embedding: Array<number>
  index: number
}

export interface EmbeddingResponse {
  object: string
  data: Array<Embedding>
  model: string
  usage: {
    prompt_tokens: number
    total_tokens: number
  }
}
