import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { ChatCompletionResponse, ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { awaitApproval } from '~/lib/approval'
import {
  chatCompletionsHasExternalImageUrls,
  OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE,
  throwOpenAIInvalidRequestError,
} from '~/lib/openai-compat'
import { writeOpenAIStreamError } from '~/lib/openai-stream-error'
import { checkRateLimit } from '~/lib/rate-limit'
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
  await checkRateLimit(state)

  let payload = await validateBody<ChatCompletionsPayload>(c, ChatCompletionsPayloadSchema)
  if (consola.level >= 4) {
    consola.debug('Request payload:', JSON.stringify(payload).slice(-400))
  }

  if (chatCompletionsHasExternalImageUrls(payload)) {
    throwOpenAIInvalidRequestError(OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE)
  }

  // Find the selected model
  const selectedModel = state.models?.data?.find(
    model => model.id === payload.model,
  )

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

  if (state.manualApprove)
    await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    if (consola.level >= 4) {
      consola.debug('Set max_tokens to:', JSON.stringify(payload.max_tokens))
    }
  }

  const route = resolveRoute('chat-completions', payload.model, throwOpenAIInvalidRequestError)
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
      consola.debug('Non-streaming response:', JSON.stringify(result.body))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(normalizeChatCompletionResponse(result.body))
  }

  consola.debug('Streaming response')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of streamBody) {
        if (stream.aborted)
          break
        if (consola.level >= 4) {
          consola.debug('Streaming chunk:', JSON.stringify(chunk))
        }
        await stream.writeSSE(normalizeChatCompletionStreamChunk(chunk as SSEMessage))
      }
    }
    catch (error) {
      await writeOpenAIStreamError(stream, error, {
        fallbackMessage: 'An unexpected error occurred while streaming the Copilot chat completion.',
        label: 'Chat completions stream passthrough',
      })
    }
  })
}

function isCCNonStreaming(body: Awaited<ReturnType<typeof createChatCompletions>>['body']): body is ChatCompletionResponse {
  return Object.hasOwn(body, 'choices')
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
