import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { fetchCopilot } from '~/lib/upstream-fetch'
import { readValidatedJsonResponse } from './upstream-response'

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

  const response = await fetchCopilot(`${copilotBaseUrl(state)}/embeddings`, {
    method: 'POST',
    headers: copilotHeaders(state),
    body: JSON.stringify(normalizedPayload),
    signal: options?.signal,
  })

  if (!response.ok)
    throw new HTTPError('Failed to create embeddings', response)

  const upstreamBody = await readValidatedJsonResponse(
    response,
    'Invalid Copilot /embeddings response',
    value => isUpstreamEmbeddingResponse(value, normalizedPayload.input.length),
  )
  // Copilot currently omits the OpenAI envelope's top-level object/model fields
  // while returning valid data and usage. Normalize those fields at the proxy
  // boundary instead of rejecting a real upstream success.
  const body: EmbeddingResponse = {
    ...upstreamBody,
    object: upstreamBody.object ?? 'list',
    model: upstreamBody.model ?? payload.model,
  }
  return { body, headers: response.headers }
}

interface UpstreamEmbeddingResponse {
  object?: 'list'
  data: Array<Embedding>
  model?: string
  usage: EmbeddingResponse['usage']
}

function isUpstreamEmbeddingResponse(
  value: unknown,
  expectedEmbeddings: number,
): value is UpstreamEmbeddingResponse {
  if (!value || typeof value !== 'object') {
    return false
  }

  const response = value as Partial<UpstreamEmbeddingResponse>
  return (response.object === undefined || response.object === 'list')
    && (response.model === undefined || typeof response.model === 'string')
    && Array.isArray(response.data)
    && response.data.length === expectedEmbeddings
    && response.data.every(isEmbedding)
    && typeof response.usage === 'object'
    && response.usage !== null
    && typeof response.usage.prompt_tokens === 'number'
    && typeof response.usage.total_tokens === 'number'
}

function isEmbedding(value: unknown): value is Embedding {
  if (!value || typeof value !== 'object') {
    return false
  }

  const embedding = value as Partial<Embedding>
  return embedding.object === 'embedding'
    && typeof embedding.index === 'number'
    && Number.isInteger(embedding.index)
    && embedding.index >= 0
    && Array.isArray(embedding.embedding)
    && embedding.embedding.length > 0
    && embedding.embedding.every(value => typeof value === 'number' && Number.isFinite(value))
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
