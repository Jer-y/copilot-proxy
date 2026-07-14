import consola from 'consola'
import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { fetchCopilot } from '~/lib/upstream-fetch'
import { fetchAuthenticatedCopilot } from './authenticated-fetch'
import { instrumentCopilotEventStream, logUpstreamHeadersReceived, logUpstreamRequestCompleted } from './stream-metrics'
import { createUpstreamRequestController } from './upstream-cancel'
import { assertEventStreamResponse, readValidatedJsonResponse } from './upstream-response'

export async function createChatCompletions(
  payload: ChatCompletionsPayload,
  options?: { signal?: AbortSignal },
) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const enableVision = payload.messages.some(
    x =>
      typeof x.content !== 'string'
      && x.content?.some(x => x.type === 'image_url'),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some(msg =>
    ['assistant', 'tool'].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const requestStartedAt = Date.now()
  const body = JSON.stringify(payload)
  const upstreamController = createUpstreamRequestController(options?.signal)
  const response = await fetchAuthenticatedCopilot({
    endpoint: '/chat/completions',
    model: payload.model,
    signal: upstreamController.signal,
    request: () => fetchCopilot(`${copilotBaseUrl(state)}/chat/completions`, {
      method: 'POST',
      headers: {
        ...copilotHeaders(state, enableVision),
        'X-Initiator': isAgentCall ? 'agent' : 'user',
      },
      body,
      signal: upstreamController.signal,
    }),
  })
  logUpstreamHeadersReceived({
    endpoint: '/chat/completions',
    requestStartedAt,
    status: response.status,
    stream: Boolean(payload.stream),
  })

  if (!response.ok) {
    consola.error('Failed to create chat completions', response)
    throw new HTTPError('Failed to create chat completions', response)
  }

  if (payload.stream) {
    await assertEventStreamResponse(
      response,
      'Invalid Copilot /chat/completions streaming response',
      { preserveJsonErrorEnvelope: true },
    )

    const instrumentedStream = instrumentCopilotEventStream(events(response), {
      endpoint: '/chat/completions',
      onIteratorExit: reason => upstreamController.cancel(response, reason),
      requestStartedAt,
    })
    return {
      body: instrumentedStream,
      headers: response.headers,
      cancel: (reason?: unknown) => upstreamController.cancel(response, reason),
    }
  }

  const json = await readValidatedJsonResponse(
    response,
    'Invalid Copilot /chat/completions response',
    isChatCompletionResponse,
    { preserveErrorEnvelope: true },
  )
  logUpstreamRequestCompleted({
    endpoint: '/chat/completions',
    requestStartedAt,
  })
  return { body: json, headers: response.headers }
}

function isChatCompletionResponse(value: unknown): value is ChatCompletionResponse {
  if (!value || typeof value !== 'object')
    return false
  const response = value as Partial<ChatCompletionResponse>
  return typeof response.id === 'string'
    && typeof response.model === 'string'
    && Array.isArray(response.choices)
    && response.choices.every(choice => Boolean(
      choice
      && typeof choice === 'object'
      && choice.message
      && typeof choice.message === 'object',
    ))
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object?: 'chat.completion'
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: 'assistant'
  content: string | null
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  encrypted_content?: string | null
  phase?: string | null
  outputTokens?: number
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: 'json_object' } | { type: 'json_schema', json_schema: { name: string, strict?: boolean, schema: Record<string, unknown> } } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | 'none'
    | 'auto'
    | 'required'
    | { type: 'function', function: { name: string } }
    | null
  user?: string | null
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
  parallel_tool_calls?: boolean | null
  snippy?: { enabled: boolean } | null
}

export interface Tool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
  copilot_cache_control?: { type: 'ephemeral' } | null
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'developer'
  content: string | Array<ContentPart> | null

  name?: string
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  encrypted_content?: string | null
  phase?: string | null
  outputTokens?: number
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
  copilot_cache_control?: { type: 'ephemeral' } | null
}

export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: 'text'
  text: string
}

export interface ImagePart {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'low' | 'high' | 'auto'
  }
}
