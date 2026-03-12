import type { Context } from 'hono'

import type { AnthropicMessagesPayload, AnthropicStreamState } from './anthropic-types'
import type { ChatCompletionChunk, ChatCompletionResponse } from '~/services/copilot/create-chat-completions'
import type { ResponsesResponse } from '~/services/copilot/create-responses'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'
import { isUnsupportedApiError, recordProbeResult } from '~/lib/api-probe'
import { awaitApproval } from '~/lib/approval'
import { HTTPError } from '~/lib/error'
import { resolveBackend } from '~/lib/model-config'
import { checkRateLimit } from '~/lib/rate-limit'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'

import { state } from '~/lib/state'
import { createAnthropicFromResponsesStreamState, translateAnthropicRequestToResponses, translateResponsesResponseToAnthropic, translateResponsesStreamEventToAnthropic } from '~/lib/translation'
import { isNullish } from '~/lib/utils'
import { validateBody } from '~/lib/validate'
import {
  createChatCompletions,
} from '~/services/copilot/create-chat-completions'
import { createResponses } from '~/services/copilot/create-responses'
import {
  applyModelVariant,
  translateToAnthropic,
  translateToOpenAI,
} from './non-stream-translation'
import { translateChunkToAnthropicEvents, translateErrorToAnthropicErrorEvent } from './stream-translation'

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicBeta = c.req.header('anthropic-beta')
  let anthropicPayload = await validateBody<AnthropicMessagesPayload>(c, AnthropicMessagesPayloadSchema)
  consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Determine the effective model (with variant suffix) for routing
  const effectiveModel = applyModelVariant(anthropicPayload.model, anthropicPayload, anthropicBeta)

  if (isNullish(anthropicPayload.max_tokens)) {
    const selectedModel = findModelWithFallback(effectiveModel, state.models?.data)
    anthropicPayload = {
      ...anthropicPayload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    consola.debug('Set anthropic max_tokens to:', JSON.stringify(anthropicPayload.max_tokens))
  }

  const backend = resolveBackend(effectiveModel, 'chat-completions')

  if (backend === 'responses') {
    return handleViaResponses(c, anthropicPayload, effectiveModel)
  }

  // Try chat-completions first; if unsupported, fall back to responses
  try {
    return await handleViaChatCompletions(c, anthropicPayload, anthropicBeta)
  }
  catch (error) {
    if (error instanceof HTTPError && await isUnsupportedApiError(error.response)) {
      consola.info(`Model ${effectiveModel} does not support /chat/completions, falling back to /responses`)
      recordProbeResult(effectiveModel, 'chat-completions')
      return handleViaResponses(c, anthropicPayload, effectiveModel)
    }
    throw error
  }
}

function findModelWithFallback(modelId: string, models: typeof state.models extends { data: infer T } ? T : never): typeof state.models extends { data: infer T } ? T[number] | undefined : never {
  if (!models) {
    return undefined as never
  }

  const exact = models.find(model => model.id === modelId)
  if (exact) {
    return exact as never
  }

  const baseModel = modelId.replace(/-(fast|1m)$/, '')
  if (baseModel !== modelId) {
    return models.find(model => model.id === baseModel) as never
  }

  return undefined as never
}

/** Existing path: Anthropic → CC → Anthropic */
async function handleViaChatCompletions(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
) {
  const openAIPayload = translateToOpenAI(anthropicPayload, { anthropicBeta })
  consola.debug('Translated OpenAI request payload:', JSON.stringify(openAIPayload))

  const response = await createChatCompletions(openAIPayload)

  if (isCCNonStreaming(response)) {
    consola.debug('Non-streaming response from Copilot:', JSON.stringify(response).slice(-400))
    const anthropicResponse = translateToAnthropic(response)
    consola.debug('Translated Anthropic response:', JSON.stringify(anthropicResponse))
    return c.json(anthropicResponse)
  }

  consola.debug('Streaming response from Copilot')
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug('Copilot raw stream event:', JSON.stringify(rawEvent))
      if (rawEvent.data === '[DONE]') {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      let chunk: ChatCompletionChunk
      try {
        chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk
      }
      catch {
        consola.error('Failed to parse streaming chunk:', rawEvent.data)
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify(translateErrorToAnthropicErrorEvent()),
        })
        return
      }

      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug('Translated Anthropic event:', JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

/** New path: Anthropic → Responses → Anthropic */
async function handleViaResponses(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  effectiveModel: string,
) {
  const responsesPayload = translateAnthropicRequestToResponses(anthropicPayload, { model: effectiveModel })
  consola.debug('Translated Anthropic→Responses payload:', JSON.stringify(responsesPayload).slice(-400))

  const response = await createResponses(responsesPayload)

  if (isResponsesNonStreaming(response)) {
    consola.debug('Non-streaming responses (Anthropic path):', JSON.stringify(response))
    const anthropicResponse = translateResponsesResponseToAnthropic(response)
    consola.debug('Translated Responses→Anthropic response:', JSON.stringify(anthropicResponse))
    return c.json(anthropicResponse)
  }

  // Streaming translation (Responses stream → Anthropic events)
  consola.debug('Streaming responses (Anthropic path)')
  return streamSSE(c, async (stream) => {
    const streamState = createAnthropicFromResponsesStreamState()

    for await (const rawEvent of response) {
      if (rawEvent.data === '[DONE]')
        break
      if (!rawEvent.data)
        continue

      let event
      try {
        event = JSON.parse(rawEvent.data)
      }
      catch {
        consola.error('Failed to parse Responses stream event:', rawEvent.data)
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify(translateErrorToAnthropicErrorEvent()),
        })
        return
      }

      const anthropicEvents = translateResponsesStreamEventToAnthropic(event, streamState)
      for (const evt of anthropicEvents) {
        await stream.writeSSE({
          event: evt.type,
          data: JSON.stringify(evt),
        })

        if (evt.type === 'error') {
          return
        }
      }
    }
  })
}

function isCCNonStreaming(response: Awaited<ReturnType<typeof createChatCompletions>>): response is ChatCompletionResponse {
  return Object.hasOwn(response, 'choices')
}

function isResponsesNonStreaming(response: Awaited<ReturnType<typeof createResponses>>): response is ResponsesResponse {
  return Object.hasOwn(response, 'output')
}
