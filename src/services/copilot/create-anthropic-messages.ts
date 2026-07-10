/**
 * Native Anthropic Messages API passthrough for Claude models.
 *
 * Instead of translating Anthropic → OpenAI Chat Completions and back,
 * this service forwards the Anthropic payload directly to Copilot's
 * native `/v1/messages` endpoint.
 */

import type {
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from '~/lib/translation/types'

import consola from 'consola'
import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { fetchCopilot } from '~/lib/upstream-fetch'
import { instrumentCopilotEventStream, logUpstreamHeadersReceived, logUpstreamRequestCompleted } from './stream-metrics'
import { createUpstreamRequestController } from './upstream-cancel'
import { assertEventStreamResponse, readValidatedJsonResponse } from './upstream-response'

const MID_CONVERSATION_SYSTEM_BETA = 'mid-conversation-system-2026-04-07'

export interface AnthropicCountTokensResponse {
  input_tokens: number
}

interface AnthropicRequestOptions {
  signal?: AbortSignal
  anthropicBeta?: string
}

export async function createAnthropicMessages(
  payload: AnthropicMessagesPayload,
  options?: AnthropicRequestOptions,
) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const requestStartedAt = Date.now()
  const body = JSON.stringify(payload)
  const upstreamController = createUpstreamRequestController(options?.signal)
  const response = await fetchCopilot(`${copilotBaseUrl(state)}/v1/messages`, {
    method: 'POST',
    headers: buildAnthropicRequestHeaders(payload, options),
    body,
    signal: upstreamController.signal,
  })
  logUpstreamHeadersReceived({
    endpoint: '/v1/messages',
    requestStartedAt,
    status: response.status,
    stream: Boolean(payload.stream),
  })

  if (!response.ok) {
    consola.error('Failed to create anthropic messages', response)
    throw new HTTPError('Failed to create anthropic messages', response)
  }

  if (payload.stream) {
    await assertEventStreamResponse(
      response,
      'Invalid Copilot /v1/messages streaming response',
    )
    const instrumentedStream = instrumentCopilotEventStream(events(response), {
      endpoint: '/v1/messages',
      requestStartedAt,
    })
    return {
      body: instrumentedStream,
      headers: response.headers,
      streaming: true as const,
      cancel: (reason?: unknown) => upstreamController.cancel(response, reason),
    }
  }

  const json = await readValidatedJsonResponse(
    response,
    'Invalid Copilot /v1/messages response',
    isAnthropicResponse,
  )
  logUpstreamRequestCompleted({
    endpoint: '/v1/messages',
    requestStartedAt,
  })
  return { body: json, headers: response.headers, streaming: false as const }
}

export async function createAnthropicCountTokens(
  payload: AnthropicMessagesPayload,
  options?: AnthropicRequestOptions,
) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const requestStartedAt = Date.now()
  const response = await fetchCopilot(`${copilotBaseUrl(state)}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: buildAnthropicRequestHeaders(payload, options),
    body: JSON.stringify(payload),
    signal: options?.signal,
  })
  logUpstreamHeadersReceived({
    endpoint: '/v1/messages/count_tokens',
    requestStartedAt,
    status: response.status,
    stream: false,
  })

  if (!response.ok) {
    consola.error('Failed to count anthropic message tokens', response)
    throw new HTTPError('Failed to count anthropic message tokens', response)
  }

  const json = await readValidatedJsonResponse(
    response,
    'Invalid Copilot /v1/messages/count_tokens response',
    isAnthropicCountTokensResponse,
  )
  logUpstreamRequestCompleted({
    endpoint: '/v1/messages/count_tokens',
    requestStartedAt,
  })
  return { body: json, headers: response.headers }
}

function buildAnthropicRequestHeaders(
  payload: AnthropicMessagesPayload,
  options?: AnthropicRequestOptions,
): Record<string, string> {
  const enableVision = payload.messages.some(messageContainsVisionInput)
  const isAgentCall = payload.messages.some(messageContinuesAgentLoop)
  const anthropicBeta = mergeAnthropicBetaHeaders(
    options?.anthropicBeta,
    payload.messages.some(message => message.role === 'system')
      ? MID_CONVERSATION_SYSTEM_BETA
      : undefined,
  )

  return {
    ...copilotHeaders(state, enableVision),
    'X-Initiator': isAgentCall ? 'agent' : 'user',
    ...(anthropicBeta ? { 'anthropic-beta': anthropicBeta } : {}),
  }
}

function mergeAnthropicBetaHeaders(...headers: Array<string | undefined>): string | undefined {
  const betas = new Set<string>()
  for (const header of headers) {
    for (const beta of header?.split(',') ?? []) {
      const normalized = beta.trim()
      if (normalized) {
        betas.add(normalized)
      }
    }
  }
  return betas.size > 0 ? [...betas].join(',') : undefined
}

function isAnthropicResponse(value: unknown): value is AnthropicResponse {
  if (!value || typeof value !== 'object') {
    return false
  }

  const response = value as Partial<AnthropicResponse>
  const usage = response.usage as Partial<AnthropicResponse['usage']> | undefined
  return response.type === 'message'
    && response.role === 'assistant'
    && typeof response.id === 'string'
    && typeof response.model === 'string'
    && Array.isArray(response.content)
    && typeof usage === 'object'
    && usage !== null
    && typeof usage.input_tokens === 'number'
    && typeof usage.output_tokens === 'number'
}

function isAnthropicCountTokensResponse(value: unknown): value is AnthropicCountTokensResponse {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Partial<AnthropicCountTokensResponse>).input_tokens === 'number'
}

function messageContainsVisionInput(
  message: AnthropicMessagesPayload['messages'][number],
): boolean {
  if (message.role !== 'user' || !Array.isArray(message.content)) {
    return false
  }

  return message.content.some(block =>
    block.type === 'image'
    || (block.type === 'tool_result' && toolResultContainsImage(block)),
  )
}

function messageContinuesAgentLoop(
  message: AnthropicMessagesPayload['messages'][number],
): boolean {
  return message.role === 'assistant'
    || (
      message.role === 'user'
      && Array.isArray(message.content)
      && message.content.some((block): block is AnthropicToolResultBlock => block.type === 'tool_result')
    )
}

function toolResultContainsImage(block: AnthropicToolResultBlock): boolean {
  if (!Array.isArray(block.content)) {
    return false
  }

  return block.content.some((contentBlock: AnthropicUserContentBlock) => contentBlock.type === 'image')
}
