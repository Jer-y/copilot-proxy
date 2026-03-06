import consola from 'consola'
import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'

/** Type guard: is a message input item (has role, not a function_call/output) */
function isMessageInput(item: ResponsesInputItem): item is ResponsesMessageInputItem {
  return 'role' in item
    && typeof item.role === 'string'
    && 'content' in item
    && (item.type === undefined || item.type === 'message')
}

export async function createResponses(payload: ResponsesPayload) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const inputArray = Array.isArray(payload.input) ? payload.input : []
  const hasVision = inputArray.length > 0 && hasVisionInput(inputArray)

  const isAgentCall = inputArray.some(item =>
    (isMessageInput(item) && item.role === 'assistant')
    || ('type' in item && item.type === 'function_call'),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, hasVision),
    'X-Initiator': isAgentCall ? 'agent' : 'user',
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    consola.error('Failed to create responses', response)
    throw new HTTPError('Failed to create responses', response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ResponsesResponse
}

function hasVisionInput(input: Array<ResponsesInputItem>): boolean {
  const visionTypes = new Set([
    'input_image',
    'image',
    'image_url',
    'image_file',
  ])

  return input.some((item) => {
    if (!isMessageInput(item) || !Array.isArray(item.content)) {
      return false
    }
    return item.content.some(part => visionTypes.has(part.type))
  })
}

// Payload types

export type ResponsesToolChoice = 'none' | 'auto' | 'required' | { type: 'function', name: string }

export interface ResponsesTextConfig {
  format?: { type: 'text' | 'json_object' | string }
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
  model: string
  output: Array<ResponsesOutputItem>
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
    | { type: 'response.output_text.delta', output_index: number, content_index: number, delta: string }
    | { type: 'response.function_call_arguments.delta', output_index: number, item_id: string, delta: string }
    | { type: 'response.content_part.added', output_index: number, content_index: number, part: Record<string, unknown> }
    | { type: 'response.content_part.done', output_index: number, content_index: number, part: Record<string, unknown> }
    | { type: 'response.output_item.done', output_index: number, item: ResponsesOutputItem }
    | { type: 'response.completed', response: ResponsesResponse }
    | { type: 'response.failed', response: ResponsesResponse }
    | { type: 'error', error: ResponsesResponseError }
