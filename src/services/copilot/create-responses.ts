import consola from 'consola'
import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError, JSONResponseError } from '~/lib/error'
import { state } from '~/lib/state'
import { instrumentCopilotEventStream, logUpstreamHeadersReceived, logUpstreamRequestCompleted } from './stream-metrics'

/** Type guard: is a message input item (has role, not a function_call/output) */
function isMessageInput(item: ResponsesInputItem): item is ResponsesMessageInputItem {
  return 'role' in item
    && typeof item.role === 'string'
    && 'content' in item
    && (item.type === undefined || item.type === 'message')
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

  const inputArray = Array.isArray(payload.input) ? payload.input : []
  const hasVision = inputArray.length > 0 && hasVisionInput(inputArray)
  const payloadSummary = summarizeResponsesPayload(payload)

  const isAgentCall = inputArray.some(item =>
    (isMessageInput(item) && item.role === 'assistant')
    || ('type' in item && item.type === 'function_call'),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, hasVision),
    'X-Initiator': isAgentCall ? 'agent' : 'user',
  }

  const body = JSON.stringify(payload)
  consola.debug('Forwarding Responses API request:', {
    ...payloadSummary,
    bodyChars: body.length,
  })

  const requestStartedAt = Date.now()
  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: 'POST',
    headers,
    body,
    signal: options?.signal,
  })
  logUpstreamHeadersReceived({
    endpoint: '/responses',
    requestStartedAt,
    status: response.status,
    stream: Boolean(payload.stream),
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
      })
    }

    consola.error('Failed to create responses', response)
    throw new HTTPError('Failed to create responses', response)
  }

  if (payload.stream) {
    const instrumentedStream = instrumentCopilotEventStream(events(response), {
      endpoint: '/responses',
      requestStartedAt,
    })
    return { body: instrumentedStream, headers: response.headers }
  }

  const json = (await response.json()) as ResponsesResponse
  logUpstreamRequestCompleted({
    endpoint: '/responses',
    requestStartedAt,
  })
  return { body: json, headers: response.headers }
}

function hasVisionInput(input: Array<ResponsesInputItem>): boolean {
  return input.some((item) => {
    if (!isMessageInput(item) || !Array.isArray(item.content)) {
      return false
    }
    return item.content.some(part => VISION_TYPES.has(part.type))
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

    if ('type' in item && item.type === 'function_call') {
      summary.functionCalls++
      continue
    }

    if ('type' in item && item.type === 'function_call_output') {
      summary.functionCallOutputs++
    }
  }

  return summary
}

function getInlineImageChars(part: Record<string, unknown>): number | undefined {
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

function hasInlineImageData(part: Record<string, unknown>): boolean {
  return getInlineImageChars(part) !== undefined
}

// Payload types

export type ResponsesToolChoice = 'none' | 'auto' | 'required' | { type: 'function', name: string }

export interface ResponsesTextConfig {
  format?: {
    type: string
    [key: string]: unknown
  }
  verbosity?: 'medium'
}

export interface ResponsesPayload {
  model: string
  instructions?: string
  input: string | Array<ResponsesInputItem>
  tools?: Array<ResponsesTool>
  tool_choice?: ResponsesToolChoice
  reasoning?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh'
    summary?: 'auto' | 'concise' | 'detailed' | 'none'
  }
  text?: ResponsesTextConfig
  parallel_tool_calls?: boolean
  store?: boolean
  stream?: boolean
  include?: Array<string>
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
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
  id: string
  call_id: string
  name: string
  arguments: string
  status?: 'completed' | 'in_progress'
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output'
  call_id: string
  output: string
}

export type ResponsesInputItem
  = | ResponsesMessageInputItem
    | ResponsesFunctionCallItem
    | ResponsesFunctionCallOutputItem
    | ResponsesOtherInputItem

export interface ResponsesTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown> | null
  strict?: boolean
  copilot_cache_control?: { type: 'ephemeral' } | null
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
  model: string
  output: Array<ResponsesOutputItem>
  text?: ResponsesTextConfig
  reasoning?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | null
    summary?: Array<{ type: 'summary_text', text: string }> | null
  }
  metadata?: Record<string, unknown>
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
    input_tokens_details?: { cached_tokens: number }
    output_tokens_details?: { reasoning_tokens: number }
  }
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress'
  error?: ResponsesResponseError | null
  incomplete_details?: { reason?: string } | null
}

export interface ResponsesOutputItem {
  type: 'message' | 'function_call' | 'reasoning'
  id?: string
  status?: 'completed' | 'in_progress'
  // For message type
  role?: 'assistant'
  content?: Array<{ type: 'output_text', text: string }>
  // For function_call type
  name?: string
  arguments?: string
  call_id?: string
  // For reasoning type
  summary?: Array<{ type: 'summary_text', text: string }>
}

// Stream event types (discriminated union)

export type ResponsesStreamEvent
  = | { type: 'response.created', response: ResponsesResponse }
    | { type: 'response.in_progress', response: ResponsesResponse }
    | { type: 'response.output_item.added', output_index: number, item: ResponsesOutputItem }
    | { type: 'response.output_text.delta', output_index: number, content_index: number, delta: string, item_id?: string }
    | { type: 'response.output_text.done', output_index: number, content_index: number, text: string, item_id?: string }
    | { type: 'response.function_call_arguments.delta', output_index: number, item_id: string, delta: string }
    | { type: 'response.function_call_arguments.done', output_index: number, item_id: string, arguments: string, item?: ResponsesOutputItem }
    | { type: 'response.content_part.added', output_index: number, content_index: number, part: Record<string, unknown>, item_id?: string }
    | { type: 'response.content_part.done', output_index: number, content_index: number, part: Record<string, unknown>, item_id?: string }
    | { type: 'response.output_item.done', output_index: number, item: ResponsesOutputItem }
    | { type: 'response.completed', response: ResponsesResponse }
    | { type: 'response.incomplete', response: ResponsesResponse }
    | { type: 'response.failed', response: ResponsesResponse }
    | { type: 'error', error: ResponsesResponseError }
