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
import { instrumentCopilotEventStream, logUpstreamHeadersReceived, logUpstreamRequestCompleted } from './stream-metrics'

export async function createAnthropicMessages(
  payload: AnthropicMessagesPayload,
  options?: { signal?: AbortSignal, anthropicBeta?: string },
) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  const enableVision = payload.messages.some(messageContainsVisionInput)
  const isAgentCall = payload.messages.some(messageContinuesAgentLoop)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    'X-Initiator': isAgentCall ? 'agent' : 'user',
    ...(options?.anthropicBeta ? { 'anthropic-beta': options.anthropicBeta } : {}),
  }

  const requestStartedAt = Date.now()
  const body = JSON.stringify(payload)
  const response = await fetch(`${copilotBaseUrl(state)}/v1/messages`, {
    method: 'POST',
    headers,
    body,
    signal: options?.signal,
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
    const instrumentedStream = instrumentCopilotEventStream(events(response), {
      endpoint: '/v1/messages',
      requestStartedAt,
    })
    return { body: instrumentedStream, headers: response.headers, streaming: true as const }
  }

  const json = (await response.json()) as AnthropicResponse
  logUpstreamRequestCompleted({
    endpoint: '/v1/messages',
    requestStartedAt,
  })
  return { body: json, headers: response.headers, streaming: false as const }
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
