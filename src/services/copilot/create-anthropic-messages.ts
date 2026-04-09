/**
 * Native Anthropic Messages API passthrough for Claude models.
 *
 * Instead of translating Anthropic → OpenAI Chat Completions and back,
 * this service forwards the Anthropic payload directly to Copilot's
 * native `/v1/messages` endpoint (proven to exist via VS Code Copilot
 * Chat deep-dive analysis).
 */

import type { AnthropicMessagesPayload, AnthropicResponse } from '~/lib/translation/types'

import consola from 'consola'
import { events } from 'fetch-event-stream'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { instrumentCopilotEventStream, logUpstreamHeadersReceived, logUpstreamRequestCompleted } from './stream-metrics'

const ANTHROPIC_BETA = 'advanced-tool-use-2025-11-20'

export async function createAnthropicMessages(
  payload: AnthropicMessagesPayload,
  options?: { signal?: AbortSignal, anthropicBeta?: string },
) {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  // Vision detection: scan for base64 image blocks in Anthropic format
  const enableVision = payload.messages.some(
    msg => Array.isArray(msg.content) && msg.content.some(
      (block: any) => block.type === 'image',
    ),
  )

  // Agent/user detection: if messages contain assistant turns or tool_result,
  // this is an agent continuation (tool-use loop), not a fresh user request.
  const isAgentCall = payload.messages.some(msg =>
    msg.role === 'assistant'
    || (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(
      (block: any) => block.type === 'tool_result',
    )),
  )

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    'X-Initiator': isAgentCall ? 'agent' : 'user',
    'anthropic-beta': options?.anthropicBeta ?? ANTHROPIC_BETA,
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
