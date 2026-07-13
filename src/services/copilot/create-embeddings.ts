import { Buffer } from 'node:buffer'

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
    value => isUpstreamEmbeddingResponse(
      value,
      normalizedPayload.input.length,
      payload.encoding_format,
    ),
  )
  // Copilot currently omits the OpenAI envelope's top-level object/model fields
  // while returning valid data and usage. Normalize those fields at the proxy
  // boundary instead of rejecting a real upstream success.
  const body: EmbeddingResponse = {
    ...upstreamBody,
    data: upstreamBody.data.map(embedding => ({
      ...embedding,
      embedding: payload.encoding_format === 'base64' && Array.isArray(embedding.embedding)
        ? encodeFloat32Embedding(embedding.embedding)
        : embedding.embedding,
    })),
    object: upstreamBody.object ?? 'list',
    model: upstreamBody.model ?? payload.model,
  }
  return { body, headers: response.headers }
}

interface UpstreamEmbeddingResponse {
  object?: 'list'
  data: Array<UpstreamEmbedding>
  model?: string
  usage: EmbeddingResponse['usage']
}

interface UpstreamEmbedding extends Omit<Embedding, 'embedding'> {
  embedding: Array<number> | string
}

function isUpstreamEmbeddingResponse(
  value: unknown,
  expectedEmbeddings: number,
  encodingFormat: EmbeddingRequest['encoding_format'],
): value is UpstreamEmbeddingResponse {
  if (!value || typeof value !== 'object') {
    return false
  }

  const response = value as Partial<UpstreamEmbeddingResponse>
  return (response.object === undefined || response.object === 'list')
    && (response.model === undefined || typeof response.model === 'string')
    && Array.isArray(response.data)
    && response.data.length === expectedEmbeddings
    && response.data.every(embedding => isEmbedding(embedding, encodingFormat))
    && typeof response.usage === 'object'
    && response.usage !== null
    && typeof response.usage.prompt_tokens === 'number'
    && typeof response.usage.total_tokens === 'number'
}

function isEmbedding(
  value: unknown,
  encodingFormat: EmbeddingRequest['encoding_format'],
): value is UpstreamEmbedding {
  if (!value || typeof value !== 'object') {
    return false
  }

  const embedding = value as Partial<Embedding>
  return embedding.object === 'embedding'
    && typeof embedding.index === 'number'
    && Number.isInteger(embedding.index)
    && embedding.index >= 0
    && (
      isFloatEmbedding(embedding.embedding)
      || (encodingFormat === 'base64' && isBase64Float32Embedding(embedding.embedding))
    )
}

function isFloatEmbedding(value: unknown): value is Array<number> {
  return Array.isArray(value)
    && value.length > 0
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
}

function isBase64Float32Embedding(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    return false
  }
  if (!/^(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/i.test(value)) {
    return false
  }
  const byteLength = Buffer.from(value, 'base64').byteLength
  return byteLength > 0 && byteLength % Float32Array.BYTES_PER_ELEMENT === 0
}

function encodeFloat32Embedding(embedding: Array<number>): string {
  // OpenAI SDKs decode base64 embedding payloads as packed Float32 values.
  // Write the service's little-endian wire representation explicitly so the
  // result is stable across runtimes instead of depending on host endianness.
  const bytes = new Uint8Array(embedding.length * Float32Array.BYTES_PER_ELEMENT)
  const view = new DataView(bytes.buffer)
  for (const [index, value] of embedding.entries()) {
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, value, true)
  }
  return Buffer.from(bytes).toString('base64')
}

export interface EmbeddingRequest {
  input: string | Array<string>
  model: string
  dimensions?: number
  encoding_format?: 'float' | 'base64'
  user?: string
}

export interface Embedding {
  object: string
  embedding: Array<number> | string
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
