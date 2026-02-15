import consola from 'consola'
import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'

export async function createResponses(payload: ResponsesPayload) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const inputArray = Array.isArray(payload.input) ? payload.input : []
  const hasVision = inputArray.length > 0 && hasVisionInput(inputArray)

  const isAgentCall = inputArray.some(item =>
    ['assistant'].includes(item.role),
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
    if (!Array.isArray(item.content)) {
      return false
    }
    return item.content.some(part => visionTypes.has(part.type))
  })
}

// Payload types

export interface ResponsesPayload {
  model: string
  instructions?: string
  input: string | Array<ResponsesInputItem>
  tools?: Array<ResponsesTool>
  reasoning?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh'
    summary?: 'auto' | 'concise' | 'detailed' | 'none'
  }
  parallel_tool_calls?: boolean
  store?: boolean
  stream?: boolean
  include?: Array<string>
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
}

export interface ResponsesInputItem {
  role: 'user' | 'assistant' | 'system' | 'developer'
  content: string | Array<{ type: string, [key: string]: unknown }>
  [key: string]: unknown
}

export interface ResponsesTool {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, unknown> | null
  strict?: boolean
}

// Response types

export interface ResponsesResponse {
  id: string
  object: 'response'
  model: string
  output: Array<ResponsesOutputItem>
  usage?: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
  status: 'completed' | 'failed' | 'incomplete' | 'in_progress'
}

export interface ResponsesOutputItem {
  type: 'message' | 'function_call' | 'reasoning'
  id?: string
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
