import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { ChatCompletionResponse, ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { getModelConfig } from '~/lib/model-config'
import { findModelWithFallback } from '~/lib/model-utils'
import {
  chatCompletionsHasExternalImageUrls,
  OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE,
  throwOpenAIInvalidRequestError,
} from '~/lib/openai-compat'
import { writeOpenAIStreamError } from '~/lib/openai-stream-error'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { resolveRoute } from '~/lib/routing-policy'
import { ChatCompletionsPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { isNullish } from '~/lib/utils'
import { validateBody } from '~/lib/validate'
import {
  createChatCompletions,
} from '~/services/copilot/create-chat-completions'

export async function handleCompletion(c: Context) {
  await enforceRateLimit(state)

  let payload = await validateBody<ChatCompletionsPayload>(c, ChatCompletionsPayloadSchema)
  if (consola.level >= 4) {
    consola.debug('Chat completions request:', summarizeChatCompletionRequest(payload))
  }

  if (chatCompletionsHasExternalImageUrls(payload)) {
    throwOpenAIInvalidRequestError(OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE)
  }

  // Find the selected model
  const selectedModel = findModelWithFallback(payload.model, state.models?.data)

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info('Current token count:', tokenCount)
    }
    else {
      consola.warn('No model selected, skipping token count calculation')
    }
  }
  catch (error) {
    consola.warn('Failed to calculate token count:', error)
  }

  await enforceManualApproval(state)

  payload = normalizeChatCompletionTokenLimit(
    payload,
    selectedModel?.capabilities.limits.max_output_tokens,
  )

  const route = resolveRoute('chat-completions', payload.model, throwOpenAIInvalidRequestError, {
    models: state.models?.data,
  })
  // chat-completions clients only ever route to chat-completions backend.
  // resolveRoute() throws 4xx if the model does not list chat-completions in its supportedApis.
  if (route.backend !== 'chat-completions' || route.kind !== 'direct') {
    throwOpenAIInvalidRequestError(
      `Model ${payload.model} cannot be served via /chat/completions. The proxy does not translate from chat-completions to other backends.`,
    )
  }

  try {
    return await handleViaChatCompletions(c, payload)
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return c.body(null)
    throw error
  }
}

/** Direct path: model supports chat-completions */
async function handleViaChatCompletions(c: Context, payload: ChatCompletionsPayload) {
  const result = await createChatCompletions(payload)

  if (isCCNonStreaming(result.body)) {
    if (consola.level >= 4) {
      consola.debug('Chat completions response:', summarizeChatCompletionResponse(result.body))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(normalizeChatCompletionResponse(result.body))
  }

  consola.debug('Streaming response')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    let completed = false
    let terminalSeen = false
    stream.onAbort(() => result.cancel?.('chat completions client disconnected before upstream stream completed'))
    try {
      for await (const chunk of streamBody) {
        if (stream.aborted)
          break
        if (consola.level >= 4) {
          consola.debug('Chat completions stream chunk:', summarizeChatCompletionStreamChunk(chunk as SSEMessage))
        }
        const message = normalizeChatCompletionStreamChunk(chunk as SSEMessage)
        terminalSeen ||= message.data === '[DONE]'
        await stream.writeSSE(message)
      }
      if (!stream.aborted && !terminalSeen) {
        throw new Error('Copilot chat completion stream terminated before the [DONE] event.')
      }
      completed = terminalSeen && !stream.aborted
    }
    catch (error) {
      await writeOpenAIStreamError(stream, error, {
        fallbackMessage: 'An unexpected error occurred while streaming the Copilot chat completion.',
        label: 'Chat completions stream passthrough',
      })
    }
    finally {
      if (!completed) {
        await result.cancel?.('chat completions client disconnected before upstream stream completed')
      }
    }
  })
}

function isCCNonStreaming(body: Awaited<ReturnType<typeof createChatCompletions>>['body']): body is ChatCompletionResponse {
  return Object.hasOwn(body, 'choices')
}

export function normalizeChatCompletionTokenLimit(
  payload: ChatCompletionsPayload,
  modelMaxOutputTokens?: number,
): ChatCompletionsPayload {
  const tokenParameter = getModelConfig(payload.model).chatCompletionTokenParameter ?? 'max_tokens'

  if (tokenParameter === 'max_completion_tokens') {
    const maxCompletionTokens = payload.max_completion_tokens
      ?? payload.max_tokens
      ?? modelMaxOutputTokens
    const { max_tokens: _legacyMaxTokens, ...rest } = payload
    return isNullish(maxCompletionTokens)
      ? rest
      : { ...rest, max_completion_tokens: maxCompletionTokens }
  }

  if (!isNullish(payload.max_tokens) || !isNullish(payload.max_completion_tokens))
    return payload

  return isNullish(modelMaxOutputTokens)
    ? payload
    : { ...payload, max_tokens: modelMaxOutputTokens }
}

function summarizeChatCompletionRequest(payload: ChatCompletionsPayload): Record<string, unknown> {
  return {
    model: payload.model,
    stream: Boolean(payload.stream),
    messageCount: payload.messages.length,
    toolCount: payload.tools?.length ?? 0,
    hasImageInput: payload.messages.some(message => Array.isArray(message.content)
      && message.content.some(part => part.type === 'image_url')),
    maxTokens: payload.max_tokens ?? undefined,
    maxCompletionTokens: payload.max_completion_tokens ?? undefined,
  }
}

function summarizeChatCompletionResponse(response: ChatCompletionResponse): Record<string, unknown> {
  return {
    id: response.id,
    model: response.model,
    choiceCount: response.choices.length,
    finishReasons: response.choices.map(choice => choice.finish_reason),
    promptTokens: response.usage?.prompt_tokens,
    completionTokens: response.usage?.completion_tokens,
  }
}

function summarizeChatCompletionStreamChunk(chunk: SSEMessage): Record<string, unknown> {
  if (typeof chunk.data !== 'string' || chunk.data === '[DONE]') {
    return { event: chunk.event, done: chunk.data === '[DONE]' }
  }

  try {
    const data = JSON.parse(chunk.data) as {
      id?: unknown
      model?: unknown
      choices?: Array<{ finish_reason?: unknown }>
    }
    return {
      event: chunk.event,
      id: typeof data.id === 'string' ? data.id : undefined,
      model: typeof data.model === 'string' ? data.model : undefined,
      choiceCount: Array.isArray(data.choices) ? data.choices.length : undefined,
      finishReasons: Array.isArray(data.choices)
        ? data.choices.map(choice => choice.finish_reason).filter(reason => reason != null)
        : undefined,
    }
  }
  catch {
    return { event: chunk.event, validJson: false }
  }
}

function normalizeChatCompletionResponse(response: ChatCompletionResponse): ChatCompletionResponse {
  return {
    object: 'chat.completion',
    ...response,
  }
}

function normalizeChatCompletionStreamChunk(chunk: SSEMessage): SSEMessage {
  if (typeof chunk.data !== 'string' || chunk.data === '[DONE]') {
    return chunk
  }

  try {
    const payload = JSON.parse(chunk.data) as Record<string, unknown>
    if (!Object.hasOwn(payload, 'choices') || Object.hasOwn(payload, 'object')) {
      return chunk
    }

    return {
      ...chunk,
      data: JSON.stringify({
        object: 'chat.completion.chunk',
        ...payload,
      }),
    }
  }
  catch {
    return chunk
  }
}
