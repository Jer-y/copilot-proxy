import consola from 'consola'
import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError, JSONResponseError } from '~/lib/error'
import { state } from '~/lib/state'
import { fetchCopilot } from '~/lib/upstream-fetch'
import { fetchAuthenticatedCopilot } from './authenticated-fetch'
import { normalizeCopilotResponsesEventStream, resolveCopilotResponseIdAlias } from './responses-id-normalizer'
import { instrumentCopilotEventStream, logUpstreamHeadersReceived, logUpstreamRequestCompleted } from './stream-metrics'
import { createUpstreamRequestController } from './upstream-cancel'
import { assertEventStreamResponse, readValidatedJsonResponse } from './upstream-response'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Type guard: is a message input item (has role, not a function_call/output) */
function isMessageInput(item: unknown): item is ResponsesMessageInputItem {
  return isRecord(item)
    && 'role' in item
    && typeof item.role === 'string'
    && 'content' in item
    && (item.type === undefined || item.type === 'message')
}

function isFunctionCallOutput(item: unknown): item is ResponsesFunctionCallOutputItem {
  return isRecord(item) && item.type === 'function_call_output'
}

const VISION_TYPES = new Set([
  'input_image',
  'image',
  'image_url',
  'image_file',
])

export async function createResponses(
  payload: ResponsesPayload,
  options?: { signal?: AbortSignal },
) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const clientPreviousResponseId = typeof payload.previous_response_id === 'string'
    ? payload.previous_response_id
    : undefined
  const resolvedPayload = resolveResponsesIdAliases(payload)
  const prepared = prepareResponsesPayloadForCopilot(resolvedPayload)
  const { hasVision, initiator, payload: upstreamPayload } = prepared
  const payloadSummary = summarizeResponsesPayload(upstreamPayload)

  const body = JSON.stringify(upstreamPayload)
  consola.debug('Forwarding Responses API request:', {
    ...payloadSummary,
    bodyChars: body.length,
  })

  const requestStartedAt = Date.now()
  const upstreamController = createUpstreamRequestController(options?.signal)
  const response = await fetchAuthenticatedCopilot({
    endpoint: '/responses',
    model: upstreamPayload.model,
    signal: upstreamController.signal,
    request: () => fetchCopilot(`${copilotBaseUrl(state)}/responses`, {
      method: 'POST',
      headers: {
        ...copilotHeaders(state, hasVision),
        'X-Initiator': initiator,
      },
      body,
      signal: upstreamController.signal,
    }),
  })
  logUpstreamHeadersReceived({
    endpoint: '/responses',
    requestStartedAt,
    status: response.status,
    stream: Boolean(upstreamPayload.stream),
  })

  if (!response.ok) {
    if (response.status === 413) {
      const errorText = await response.text()
      const upstreamError = parseUpstreamError(errorText)
      const message = buildPayloadTooLargeMessage(payloadSummary, body.length, upstreamError?.message)

      consola.warn(message)
      throw new JSONResponseError(message, 413, {
        error: {
          message,
          type: upstreamError?.type ?? 'invalid_request_error',
          code: upstreamError?.code || 'payload_too_large',
        },
      }, response.headers)
    }

    consola.error('Failed to create responses', response)
    throw new HTTPError('Failed to create responses', response)
  }

  if (upstreamPayload.stream) {
    await assertEventStreamResponse(
      response,
      'Invalid Copilot /responses streaming response',
    )
    const instrumentedStream = instrumentCopilotEventStream(events(response), {
      endpoint: '/responses',
      onIteratorExit: reason => upstreamController.cancel(response, reason),
      requestStartedAt,
    })
    return {
      body: normalizeCopilotResponsesEventStream(instrumentedStream, {
        clientPreviousResponseId,
      }),
      headers: response.headers,
      cancel: (reason?: unknown) => upstreamController.cancel(response, reason),
    }
  }

  const json = await readValidatedJsonResponse(
    response,
    'Invalid Copilot /responses response',
    isResponsesResponse,
  )
  logUpstreamRequestCompleted({
    endpoint: '/responses',
    requestStartedAt,
  })
  return {
    body: restoreClientPreviousResponseId(
      json,
      clientPreviousResponseId,
    ),
    headers: response.headers,
  }
}

function restoreClientPreviousResponseId(
  response: ResponsesResponse,
  clientPreviousResponseId: string | undefined,
): ResponsesResponse {
  if (
    !clientPreviousResponseId
    || typeof response.previous_response_id !== 'string'
  ) {
    return response
  }

  return {
    ...response,
    previous_response_id: clientPreviousResponseId,
  }
}

function resolveResponsesIdAliases(payload: ResponsesPayload): ResponsesPayload {
  if (typeof payload.previous_response_id !== 'string')
    return payload

  const upstreamPreviousResponseId = resolveCopilotResponseIdAlias(payload.previous_response_id)
  if (upstreamPreviousResponseId === payload.previous_response_id)
    return payload

  return {
    ...payload,
    previous_response_id: upstreamPreviousResponseId,
  }
}

function isResponsesResponse(value: unknown): value is ResponsesResponse {
  if (!value || typeof value !== 'object') {
    return false
  }

  const response = value as Partial<ResponsesResponse>
  const status = (value as { status?: unknown }).status
  return response.object === 'response'
    && typeof response.id === 'string'
    && typeof response.model === 'string'
    && Array.isArray(response.output)
    && response.output.every(item => Boolean(
      item
      && typeof item === 'object'
      && typeof (item as { type?: unknown }).type === 'string',
    ))
    && (
      status === 'completed'
      || status === 'failed'
      || status === 'incomplete'
      || status === 'in_progress'
      || status === 'queued'
      || status === 'cancelled'
    )
}

export function sanitizeResponsesPayloadForCopilotBackend(payload: ResponsesPayload): ResponsesPayload {
  if (!Object.hasOwn(payload, 'service_tier')) {
    return payload
  }

  consola.debug('Stripping service_tier (unsupported by Copilot /responses backend)')
  const upstreamPayload = { ...payload }
  delete upstreamPayload.service_tier
  return upstreamPayload
}

export function prepareResponsesPayloadForCopilot(payload: ResponsesPayload): {
  hasVision: boolean
  initiator: 'agent' | 'user'
  payload: ResponsesPayload
} {
  const upstreamPayload = sanitizeResponsesPayloadForCopilotBackend(payload)
  const analysis = analyzeResponsesPayloadForCopilot(upstreamPayload)

  return {
    ...analysis,
    payload: upstreamPayload,
  }
}

export function analyzeResponsesPayloadForCopilot(
  payload: { input?: ResponsesPayload['input'] },
): {
  hasVision: boolean
  initiator: 'agent' | 'user'
} {
  const inputArray = Array.isArray(payload.input) ? payload.input : []
  const hasVision = inputArray.length > 0 && hasVisionInput(inputArray)
  const isAgentCall = inputArray.some(item =>
    (isMessageInput(item) && item.role === 'assistant')
    || (isRecord(item) && item.type === 'function_call'),
  )

  return {
    hasVision,
    initiator: isAgentCall ? 'agent' : 'user',
  }
}

export async function forwardResponsesEndpoint(
  path: string,
  options: {
    method: 'GET' | 'POST' | 'DELETE'
    body?: string
    headers?: Record<string, string>
    signal?: AbortSignal
  },
) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const response = await fetchAuthenticatedCopilot({
    endpoint: path,
    signal: options.signal,
    request: () => fetchCopilot(`${copilotBaseUrl(state)}${path}`, {
      method: options.method,
      headers: {
        ...copilotHeaders(state),
        'X-Initiator': 'user',
        ...options.headers,
      },
      body: options.body,
      signal: options.signal,
    }),
  })

  if (!response.ok) {
    consola.error(`Failed to forward ${options.method} ${path}`, response)
    throw new HTTPError(`Failed to forward ${options.method} ${path}`, response)
  }

  return response
}

function hasVisionInput(input: Array<ResponsesInputItem>): boolean {
  return input.some((item) => {
    if (isMessageInput(item) && Array.isArray(item.content)) {
      return item.content.some(part => isRecord(part) && typeof part.type === 'string' && VISION_TYPES.has(part.type))
    }

    return isFunctionCallOutput(item)
      && Array.isArray(item.output)
      && item.output.some(part => isRecord(part) && typeof part.type === 'string' && VISION_TYPES.has(part.type))
  })
}

function parseUpstreamError(errorText: string): ResponsesResponseError | undefined {
  try {
    const parsed = JSON.parse(errorText) as unknown
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }

    if ('error' in parsed && parsed.error && typeof parsed.error === 'object') {
      const error = parsed.error as Record<string, unknown>
      if (typeof error.message === 'string') {
        return {
          message: error.message,
          type: typeof error.type === 'string' ? error.type : undefined,
          code: typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined,
        }
      }
    }

    if ('message' in parsed && typeof parsed.message === 'string') {
      return {
        message: parsed.message,
        type: 'type' in parsed && typeof parsed.type === 'string' ? parsed.type : undefined,
        code: 'code' in parsed && typeof parsed.code === 'string' && parsed.code.length > 0 ? parsed.code : undefined,
      }
    }
  }
  catch {
    // Ignore parse failure and fall back to the raw status text in the caller.
  }

  return undefined
}

function buildPayloadTooLargeMessage(
  summary: ResponsesPayloadSummary,
  bodyChars: number,
  upstreamMessage?: string,
): string {
  const parts = [
    'Upstream /responses rejected the request with 413 Payload Too Large.',
    'This is typically caused by an oversized prompt body, often from accumulated inline image history.',
    `body_chars=${bodyChars}`,
    `input_items=${summary.inputItems}`,
    `message_items=${summary.messageItems}`,
    `image_parts=${summary.imageParts}`,
    `data_url_images=${summary.inlineDataUrlImages}`,
    `inline_image_chars=${summary.inlineImageChars}`,
    `max_inline_image_chars=${summary.maxInlineImageChars}`,
  ]

  if (upstreamMessage) {
    parts.push(`upstream_message=${upstreamMessage}`)
  }

  return parts.join(' ')
}

export interface ResponsesPayloadSummary {
  model: string
  stream: boolean
  tools: number
  inputType: 'string' | 'array'
  inputItems: number
  messageItems: number
  functionCalls: number
  functionCallOutputs: number
  imageParts: number
  inlineDataUrlImages: number
  inlineImageChars: number
  maxInlineImageChars: number
}

export function summarizeResponsesPayload(payload: ResponsesPayload): ResponsesPayloadSummary {
  const summary: ResponsesPayloadSummary = {
    model: payload.model,
    stream: Boolean(payload.stream),
    tools: payload.tools?.length ?? 0,
    inputType: typeof payload.input === 'string' ? 'string' : 'array',
    inputItems: Array.isArray(payload.input) ? payload.input.length : 0,
    messageItems: 0,
    functionCalls: 0,
    functionCallOutputs: 0,
    imageParts: 0,
    inlineDataUrlImages: 0,
    inlineImageChars: 0,
    maxInlineImageChars: 0,
  }

  if (!Array.isArray(payload.input)) {
    return summary
  }

  for (const item of payload.input) {
    if (isMessageInput(item)) {
      summary.messageItems++

      if (!Array.isArray(item.content)) {
        continue
      }

      for (const part of item.content) {
        const inlineImageChars = getInlineImageChars(part)
        if (inlineImageChars === undefined) {
          continue
        }

        summary.imageParts++
        summary.inlineImageChars += inlineImageChars
        summary.maxInlineImageChars = Math.max(summary.maxInlineImageChars, inlineImageChars)

        if (hasInlineImageData(part)) {
          summary.inlineDataUrlImages++
        }
      }

      continue
    }

    if (isRecord(item) && item.type === 'function_call') {
      summary.functionCalls++
      continue
    }

    if (isFunctionCallOutput(item)) {
      summary.functionCallOutputs++

      if (!Array.isArray(item.output)) {
        continue
      }

      for (const part of item.output) {
        const inlineImageChars = getInlineImageChars(part)
        if (inlineImageChars === undefined) {
          continue
        }

        summary.imageParts++
        summary.inlineImageChars += inlineImageChars
        summary.maxInlineImageChars = Math.max(summary.maxInlineImageChars, inlineImageChars)

        if (hasInlineImageData(part)) {
          summary.inlineDataUrlImages++
        }
      }
    }
  }

  return summary
}

function getInlineImageChars(part: unknown): number | undefined {
  if (!isRecord(part))
    return undefined

  const partType = typeof part.type === 'string' ? part.type : undefined
  if (!partType || !VISION_TYPES.has(partType)) {
    return undefined
  }

  if (typeof part.image_url === 'string' && part.image_url.startsWith('data:')) {
    return part.image_url.length
  }

  if (part.image_url && typeof part.image_url === 'object') {
    const imageUrl = part.image_url as Record<string, unknown>
    if (typeof imageUrl.url === 'string' && imageUrl.url.startsWith('data:')) {
      return imageUrl.url.length
    }
  }

  if (part.source && typeof part.source === 'object') {
    const source = part.source as Record<string, unknown>
    if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
      return `data:${source.media_type};base64,${source.data}`.length
    }
  }

  return undefined
}

function hasInlineImageData(part: unknown): boolean {
  return getInlineImageChars(part) !== undefined
}

// Payload types

type ResponsesHostedToolChoiceType
  = | 'file_search'
    | 'web_search_preview'
    | 'computer'
    | 'computer_use_preview'
    | 'computer_use'
    | 'web_search_preview_2025_03_11'
    | 'image_generation'
    | 'code_interpreter'

export type ResponsesToolChoice
  = | 'none'
    | 'auto'
    | 'required'
    | { type: 'function', name: string }
    | { type: 'allowed_tools', mode: 'auto' | 'required', tools: Array<Record<string, unknown>> }
    | { type: 'mcp', server_label: string, name?: string | null }
    | { type: 'custom', name: string }
    | { type: ResponsesHostedToolChoiceType }
    | { type: 'apply_patch' }
    | { type: 'shell' }

export interface ResponsesTextConfig {
  format?: {
    type: string
    [key: string]: unknown
  }
  verbosity?: 'low' | 'medium' | 'high' | null
}

export interface ResponsesPayload {
  model: string
  instructions?: string | null
  input: string | Array<ResponsesInputItem>
  tools?: Array<ResponsesTool>
  tool_choice?: ResponsesToolChoice
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
    summary?: 'auto' | 'concise' | 'detailed' | 'none' | null
    generate_summary?: 'auto' | 'concise' | 'detailed' | null
  } | null
  text?: ResponsesTextConfig
  parallel_tool_calls?: boolean | null
  previous_response_id?: string | null
  store?: boolean
  background?: boolean | null
  stream?: boolean | null
  stream_options?: {
    include_obfuscation?: boolean
  } | null
  include?: Array<string> | null
  prompt_cache_key?: string
  prompt_cache_retention?: 'in_memory' | '24h' | string | null
  truncation?: 'auto' | 'disabled' | string | null
  context_management?: Array<ResponsesContextManagementItem> | null
  max_tool_calls?: number | null
  service_tier?: string | null
  conversation?: string | { id: string } | null
  prompt?: {
    id: string
    version?: string | null
    variables?: Record<string, unknown> | null
  } | null
  metadata?: Record<string, unknown> | null
  safety_identifier?: string
  user?: string
  temperature?: number | null
  top_p?: number | null
  top_logprobs?: number | null
  max_output_tokens?: number | null
}

export interface ResponsesContextManagementItem {
  type: string
  compact_threshold?: number
  [key: string]: unknown
}

// Input item types (discriminated union)

export interface ResponsesMessageInputItem {
  type?: 'message'
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | Array<{ type: string, [key: string]: unknown }>
  [key: string]: unknown
}

export interface ResponsesOtherInputItem {
  type: string
  [key: string]: unknown
}

export interface ResponsesFunctionCallItem {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
  status?: 'completed' | 'in_progress' | 'incomplete'
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string | Array<ResponsesFunctionCallOutputContent>
  status?: 'completed' | 'incomplete' | 'in_progress'
  is_error?: boolean
}

export type ResponsesFunctionCallOutputContent
  = | { type: 'input_text', text: string, [key: string]: unknown }
    | { type: 'input_image', image_url?: string | null, file_id?: string | null, [key: string]: unknown }
    | { type: 'input_file', [key: string]: unknown }

export type ResponsesInputItem
  = | ResponsesMessageInputItem
    | ResponsesFunctionCallItem
    | ResponsesFunctionCallOutputItem
    | ResponsesOtherInputItem

export interface ResponsesTool {
  type: string
  name?: string
  description?: string
  parameters?: Record<string, unknown> | null
  strict?: boolean
  copilot_cache_control?: { type: 'ephemeral' } | null
  [key: string]: unknown
}

// Response types

export interface ResponsesResponseError {
  message: string
  type?: string
  code?: string
}

export interface ResponsesResponse {
  id: string
  object: 'response'
  created_at?: number
  completed_at?: number | null
  instructions?: string | null
  max_output_tokens?: number | null
  previous_response_id?: string | null
  store?: boolean
  model: string
  output: Array<ResponsesOutputItem>
  text?: ResponsesTextConfig
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
    summary?: 'auto' | 'concise' | 'detailed' | null
  } | null
  metadata?: Record<string, unknown> | null
  temperature?: number | null
  top_p?: number | null
  parallel_tool_calls?: boolean
  tool_choice?: ResponsesToolChoice
  tools?: Array<ResponsesTool>
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens: number }
    output_tokens_details?: { reasoning_tokens: number }
  }
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress' | 'queued' | 'cancelled'
  error?: ResponsesResponseError | null
  incomplete_details?: { reason?: string } | null
}

export interface ResponsesOutputItem {
  type: 'message' | 'function_call' | 'reasoning'
  id?: string
  status?: 'completed' | 'in_progress'
  // For message type
  role?: 'assistant'
  content?: Array<{ type: 'output_text', text: string, [key: string]: unknown }>
  // For function_call type
  name?: string
  arguments?: string
  call_id?: string
  // For reasoning type
  summary?: Array<{ type: 'summary_text', text: string }>
}

// Stream event types (discriminated union)

export type ResponsesStreamEvent
  = (
    | { type: 'response.created', response: ResponsesResponse }
    | { type: 'response.in_progress', response: ResponsesResponse }
    | { type: 'response.output_item.added', output_index: number, item: ResponsesOutputItem }
    | { type: 'response.output_text.delta', output_index: number, content_index: number, delta: string, logprobs: Array<Record<string, unknown>>, item_id: string }
    | { type: 'response.output_text.done', output_index: number, content_index: number, text: string, logprobs: Array<Record<string, unknown>>, item_id: string }
    | { type: 'response.function_call_arguments.delta', output_index: number, item_id: string, delta: string }
    | { type: 'response.function_call_arguments.done', output_index: number, item_id: string, arguments: string, name: string, item?: ResponsesOutputItem }
    | { type: 'response.content_part.added', output_index: number, content_index: number, part: Record<string, unknown>, item_id: string }
    | { type: 'response.content_part.done', output_index: number, content_index: number, part: Record<string, unknown>, item_id: string }
    | { type: 'response.output_item.done', output_index: number, item: ResponsesOutputItem }
    | { type: 'response.completed', response: ResponsesResponse }
    | { type: 'response.incomplete', response: ResponsesResponse }
    | { type: 'response.failed', response: ResponsesResponse }
    | { type: 'error', code: string | null, message: string, param: string | null }
    | { type: 'error', error: ResponsesResponseError }
  ) & { sequence_number: number }
