import type { Context } from 'hono'

import type { AnthropicMessagesPayload, AnthropicStreamState } from './anthropic-types'
import type { ChatCompletionChunk, ChatCompletionResponse } from '~/services/copilot/create-chat-completions'
import type { ResponsesResponse } from '~/services/copilot/create-responses'
import type { Model } from '~/services/copilot/get-models'

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
import { assertCopilotCompatibleAnthropicRequest } from '~/lib/translation/anthropic-compat'
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
import { createAnthropicSSEWriter } from './sse-writer'
import { translateChunkToAnthropicEvents, translateErrorToAnthropicErrorEvent } from './stream-translation'

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicBeta = c.req.header('anthropic-beta')
  let anthropicPayload = await validateBody<AnthropicMessagesPayload>(c, AnthropicMessagesPayloadSchema)
  if (consola.level >= 4) {
    consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  // Determine the effective routed model, including Claude variant suffixes.
  const effectiveModel = applyModelVariant(anthropicPayload.model, anthropicPayload, anthropicBeta)

  if (isNullish(anthropicPayload.max_tokens)) {
    const selectedModel = findModelWithFallback(effectiveModel, state.models?.data)
    anthropicPayload = {
      ...anthropicPayload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    if (consola.level >= 4) {
      consola.debug('Set anthropic max_tokens to:', JSON.stringify(anthropicPayload.max_tokens))
    }
  }

  assertCopilotCompatibleAnthropicRequest(anthropicPayload)

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

function findModelWithFallback(modelId: string, models: Array<Model> | undefined): Model | undefined {
  if (!models) {
    return undefined
  }

  const exact = models.find(model => model.id === modelId)
  if (exact) {
    return exact
  }

  const baseModel = modelId.replace(/-(fast|1m)$/, '')
  if (baseModel !== modelId) {
    return models.find(model => model.id === baseModel)
  }

  return undefined
}

/** Existing path: Anthropic → CC → Anthropic */
async function handleViaChatCompletions(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
) {
  const openAIPayload = translateToOpenAI(anthropicPayload, { anthropicBeta })
  if (consola.level >= 4) {
    consola.debug('Translated OpenAI request payload:', JSON.stringify(openAIPayload))
  }

  const response = await createChatCompletions(openAIPayload)

  if (isCCNonStreaming(response)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming response from Copilot:', JSON.stringify(response).slice(-400))
    }
    const anthropicResponse = translateToAnthropic(response)
    if (consola.level >= 4) {
      consola.debug('Translated Anthropic response:', JSON.stringify(anthropicResponse))
    }
    return c.json(anthropicResponse)
  }

  consola.debug('Streaming response from Copilot')
  return streamSSE(c, async (stream) => {
    const anthropicWriter = createAnthropicSSEWriter(stream)
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    try {
      for await (const rawEvent of response) {
        if (consola.level >= 4) {
          consola.debug('Copilot raw stream event:', JSON.stringify(rawEvent))
        }
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
          await anthropicWriter.writeEvent(
            translateErrorToAnthropicErrorEvent('Failed to parse a streaming chunk from the Copilot upstream response.'),
          )
          return
        }

        const events = translateChunkToAnthropicEvents(chunk, streamState)

        for (const event of events) {
          if (consola.level >= 4) {
            consola.debug('Translated Anthropic event:', JSON.stringify(event))
          }
          await anthropicWriter.writeEvent(event)
        }
      }
    }
    catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'An unexpected error occurred while translating the Copilot stream.'
      consola.error('Chat Completions stream translation failed:', error)
      await anthropicWriter.writeEvent(translateErrorToAnthropicErrorEvent(message))
    }
    finally {
      await anthropicWriter.close()
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
  if (consola.level >= 4) {
    consola.debug('Translated Anthropic→Responses payload:', JSON.stringify(responsesPayload).slice(-400))
  }

  const response = await createResponses(responsesPayload)

  if (isResponsesNonStreaming(response)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming responses (Anthropic path):', JSON.stringify(response))
    }
    const anthropicResponse = translateResponsesResponseToAnthropic(response)
    if (consola.level >= 4) {
      consola.debug('Translated Responses→Anthropic response:', JSON.stringify(anthropicResponse))
    }
    return c.json(anthropicResponse)
  }

  // Streaming translation (Responses stream → Anthropic events)
  consola.debug('Streaming responses (Anthropic path)')
  return streamSSE(c, async (stream) => {
    const anthropicWriter = createAnthropicSSEWriter(stream)
    const streamState = createAnthropicFromResponsesStreamState()

    try {
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
          await anthropicWriter.writeEvent(
            translateErrorToAnthropicErrorEvent('Failed to parse a streaming event from the Copilot Responses upstream response.'),
          )
          return
        }

        const anthropicEvents = translateResponsesStreamEventToAnthropic(event, streamState)
        for (const evt of anthropicEvents) {
          await anthropicWriter.writeEvent(evt)

          if (evt.type === 'error') {
            return
          }
        }
      }
    }
    catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'An unexpected error occurred while translating the Copilot Responses stream.'
      consola.error('Responses stream translation failed:', error)
      await anthropicWriter.writeEvent(translateErrorToAnthropicErrorEvent(message))
    }
    finally {
      await anthropicWriter.close()
    }
  })
}

function isCCNonStreaming(response: Awaited<ReturnType<typeof createChatCompletions>>): response is ChatCompletionResponse {
  return Object.hasOwn(response, 'choices')
}

function isResponsesNonStreaming(response: Awaited<ReturnType<typeof createResponses>>): response is ResponsesResponse {
  return Object.hasOwn(response, 'output')
}
