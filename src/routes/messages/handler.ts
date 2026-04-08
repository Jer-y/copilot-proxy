import type { Context } from 'hono'

import type { AnthropicMessagesPayload, AnthropicStreamState } from './anthropic-types'
import type { ChatCompletionChunk, ChatCompletionResponse } from '~/services/copilot/create-chat-completions'
import type { ResponsesResponse } from '~/services/copilot/create-responses'
import type { Model } from '~/services/copilot/get-models'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'
import { isUnsupportedApiError, recordProbeResult } from '~/lib/api-probe'
import { awaitApproval } from '~/lib/approval'
import { HTTPError, JSONResponseError } from '~/lib/error'
import { resolveBackend } from '~/lib/model-config'
import { checkRateLimit } from '~/lib/rate-limit'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'

import { state } from '~/lib/state'
import { createAnthropicFromResponsesStreamState, translateAnthropicRequestToResponses, translateResponsesResponseToAnthropic, translateResponsesStreamEventToAnthropic } from '~/lib/translation'
import { assertCopilotCompatibleAnthropicRequest } from '~/lib/translation/anthropic-compat'
import { expandDocumentBlocks } from '~/lib/translation/anthropic-documents'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { isNullish } from '~/lib/utils'
import { validateBody } from '~/lib/validate'
import {
  createChatCompletions,
} from '~/services/copilot/create-chat-completions'
import { createResponses } from '~/services/copilot/create-responses'
import {
  createBufferedChatCompletionsState,
  finalizeBufferedChatCompletions,
  hasThinkingAssistantOutput,
  hasVisibleAssistantOutput,
  ingestChatCompletionsChunk,
} from './chat-completions-buffer'
import {
  applyModelVariant,
  translateToAnthropic,
  translateToOpenAI,
} from './non-stream-translation'
import { createAnthropicSSEWriter } from './sse-writer'
import { canRecoverUpstreamTerminationAsMessage, finalizeAnthropicStreamFromState, translateChunkToAnthropicEvents, translateErrorToAnthropicErrorEvent } from './stream-translation'

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

  const requestedModel = anthropicPayload.model
  // Determine the effective routed model, including Claude variant suffixes.
  const effectiveModel = applyModelVariant(requestedModel, anthropicPayload, anthropicBeta)
  const selectedModel = findModelWithFallback(effectiveModel, state.models?.data)
  const modelMaxOutputTokens = selectedModel?.capabilities.limits.max_output_tokens

  if (isNullish(anthropicPayload.max_tokens)) {
    anthropicPayload = {
      ...anthropicPayload,
      max_tokens: modelMaxOutputTokens,
    }
    if (consola.level >= 4) {
      consola.debug('Set anthropic max_tokens to:', JSON.stringify(anthropicPayload.max_tokens))
    }
  }
  else if (modelMaxOutputTokens && anthropicPayload.max_tokens > modelMaxOutputTokens) {
    consola.info(
      `Clamping anthropic max_tokens from ${anthropicPayload.max_tokens} to backend model limit ${modelMaxOutputTokens} for ${effectiveModel}.`,
    )
    anthropicPayload = {
      ...anthropicPayload,
      max_tokens: modelMaxOutputTokens,
    }
  }

  await expandDocumentBlocks(anthropicPayload)
  assertCopilotCompatibleAnthropicRequest(anthropicPayload)

  const signal = c.req.raw.signal
  const backend = resolveBackend(effectiveModel, 'chat-completions')

  if (backend === 'responses') {
    try {
      return await handleViaResponses(c, anthropicPayload, effectiveModel, requestedModel, signal)
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return c.body(null)
      throw error
    }
  }

  // Try chat-completions first; if unsupported, fall back to responses
  try {
    return await handleViaChatCompletions(c, anthropicPayload, anthropicBeta, effectiveModel, requestedModel, signal)
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return c.body(null)
    if (error instanceof HTTPError && await isUnsupportedApiError(error.response)) {
      consola.info(`Model ${effectiveModel} does not support /chat/completions, falling back to /responses`)
      recordProbeResult(effectiveModel, 'chat-completions')
      try {
        return await handleViaResponses(c, anthropicPayload, effectiveModel, requestedModel, signal)
      }
      catch (fallbackError) {
        if (fallbackError instanceof Error && fallbackError.name === 'AbortError')
          return c.body(null)
        throw fallbackError
      }
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
  effectiveModel: string,
  requestedModel: string,
  signal: AbortSignal,
) {
  const openAIPayload = translateToOpenAI(anthropicPayload, { anthropicBeta })
  const clientRequestedStreaming = anthropicPayload.stream === true
  const upstreamPayload = clientRequestedStreaming
    ? openAIPayload
    : {
        ...openAIPayload,
        stream: true,
      }
  if (consola.level >= 4) {
    consola.debug('Translated OpenAI request payload:', JSON.stringify(upstreamPayload))
  }

  const result = await createChatCompletions(upstreamPayload, { signal })

  if (isCCNonStreaming(result.body)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming response from Copilot:', JSON.stringify(result.body).slice(-400))
    }
    assertAnthropicMessageCanComplete(result.body)
    const anthropicResponse = translateToAnthropic(result.body, { requestedModel })
    if (consola.level >= 4) {
      consola.debug('Translated Anthropic response:', JSON.stringify(anthropicResponse))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(anthropicResponse)
  }

  if (!clientRequestedStreaming) {
    consola.debug('Buffering streaming response from Copilot for non-streaming Anthropic request')

    const bufferedState = createBufferedChatCompletionsState()

    try {
      for await (const rawEvent of result.body) {
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
          throwAnthropicApiError('Failed to parse a streaming chunk from the Copilot upstream response.')
        }

        ingestChatCompletionsChunk(chunk, bufferedState)
      }
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return c.body(null)
      const upstreamTerminated = isRecoverableUpstreamTermination(error)
      if (upstreamTerminated && bufferedState.hasNonThinkingContent) {
        consola.warn('Buffered Chat Completions stream terminated without a finish chunk; returning the partial assistant message.')
      }
      else if (upstreamTerminated) {
        const message = bufferedState.hasThinkingContent && !bufferedState.hasNonThinkingContent
          ? 'Upstream Copilot connection terminated after reasoning output, before any assistant text or tool call was produced.'
          : 'Upstream Copilot connection terminated before the response completed.'
        throwAnthropicApiError(message)
      }
      else if (error instanceof JSONResponseError) {
        throw error
      }
      else {
        const message = error instanceof Error
          ? error.message
          : 'An unexpected error occurred while buffering the Copilot stream.'
        throwAnthropicApiError(message)
      }
    }

    const bufferedResponse = finalizeBufferedChatCompletions(bufferedState)
    if (!bufferedResponse) {
      throwAnthropicApiError('Upstream Copilot returned no chat completion choices for a buffered stream.')
    }

    assertAnthropicMessageCanComplete(bufferedResponse)

    const anthropicResponse = translateToAnthropic(bufferedResponse, { requestedModel })
    if (consola.level >= 4) {
      consola.debug('Translated buffered Anthropic response:', JSON.stringify(anthropicResponse))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(anthropicResponse)
  }

  consola.debug('Streaming response from Copilot')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    const anthropicWriter = createAnthropicSSEWriter(stream)
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      messageStopSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      currentBlockType: null,
      thinkingSignature: null,
      pendingLeadingText: '',
      hasThinkingContent: false,
      hasNonThinkingContent: false,
      toolCalls: {},
      requestedModel,
    }

    try {
      for await (const rawEvent of streamBody) {
        if (stream.aborted)
          break
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

      const finalEvents = finalizeAnthropicStreamFromState(streamState)
      for (const event of finalEvents) {
        if (consola.level >= 4) {
          consola.debug('Translated Anthropic event:', JSON.stringify(event))
        }
        await anthropicWriter.writeEvent(event)
      }
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return

      const upstreamTerminated = isRecoverableUpstreamTermination(error)
      const recoveredEvents = upstreamTerminated && canRecoverUpstreamTerminationAsMessage(streamState)
        ? finalizeAnthropicStreamFromState(streamState)
        : []

      if (recoveredEvents.length > 0) {
        consola.warn('Chat Completions stream terminated without a finish chunk; synthesizing Anthropic message_stop.')
        for (const event of recoveredEvents) {
          if (consola.level >= 4) {
            consola.debug('Translated Anthropic event:', JSON.stringify(event))
          }
          await anthropicWriter.writeEvent(event)
        }
        return
      }

      if (upstreamTerminated) {
        const message = streamState.hasThinkingContent && !streamState.hasNonThinkingContent
          ? 'Upstream Copilot connection terminated after reasoning output, before any assistant text or tool call was produced.'
          : 'Upstream Copilot connection terminated before the response completed.'
        consola.warn('Chat Completions stream terminated without recoverable assistant output; returning Anthropic error event.')
        await anthropicWriter.writeEvent(translateErrorToAnthropicErrorEvent(message))
        return
      }

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
  requestedModel: string,
  signal: AbortSignal,
) {
  const responsesPayload = translateAnthropicRequestToResponses(anthropicPayload, { model: effectiveModel })
  if (consola.level >= 4) {
    consola.debug('Translated Anthropic→Responses payload:', JSON.stringify(responsesPayload).slice(-400))
  }

  const result = await createResponses(responsesPayload, { signal })

  if (isResponsesNonStreaming(result.body)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming responses (Anthropic path):', JSON.stringify(result.body))
    }
    const anthropicResponse = translateResponsesResponseToAnthropic(result.body, { requestedModel })
    if (consola.level >= 4) {
      consola.debug('Translated Responses→Anthropic response:', JSON.stringify(anthropicResponse))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(anthropicResponse)
  }

  // Streaming translation (Responses stream → Anthropic events)
  consola.debug('Streaming responses (Anthropic path)')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    const anthropicWriter = createAnthropicSSEWriter(stream)
    const streamState = createAnthropicFromResponsesStreamState({ requestedModel })

    try {
      for await (const rawEvent of streamBody) {
        if (stream.aborted)
          break
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

      const finalEvents = finalizeAnthropicStreamFromState(streamState)
      for (const evt of finalEvents) {
        await anthropicWriter.writeEvent(evt)
      }
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return

      const upstreamTerminated = isRecoverableUpstreamTermination(error)
      const recoveredEvents = upstreamTerminated && canRecoverUpstreamTerminationAsMessage(streamState)
        ? finalizeAnthropicStreamFromState(streamState)
        : []

      if (recoveredEvents.length > 0) {
        consola.warn('Responses stream terminated without a completion event; synthesizing Anthropic message_stop.')
        for (const evt of recoveredEvents) {
          await anthropicWriter.writeEvent(evt)
        }
        return
      }

      if (upstreamTerminated) {
        const message = streamState.hasThinkingContent && !streamState.hasNonThinkingContent
          ? 'Upstream Copilot connection terminated after reasoning output, before any assistant text or tool call was produced.'
          : 'Upstream Copilot connection terminated before the response completed.'
        consola.warn('Responses stream terminated without recoverable assistant output; returning Anthropic error event.')
        await anthropicWriter.writeEvent(translateErrorToAnthropicErrorEvent(message))
        return
      }

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

function isCCNonStreaming(body: Awaited<ReturnType<typeof createChatCompletions>>['body']): body is ChatCompletionResponse {
  return Object.hasOwn(body, 'choices')
}

function isResponsesNonStreaming(body: Awaited<ReturnType<typeof createResponses>>['body']): body is ResponsesResponse {
  return Object.hasOwn(body, 'output')
}

function isRecoverableUpstreamTermination(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  if (error.message === 'terminated' || String(error).includes('terminated')) {
    return true
  }

  const cause = error.cause
  if (!cause || typeof cause !== 'object') {
    return false
  }

  const code = 'code' in cause ? cause.code : undefined
  const message = 'message' in cause ? cause.message : undefined

  return code === 'UND_ERR_SOCKET' || message === 'other side closed'
}

function assertAnthropicMessageCanComplete(response: ChatCompletionResponse): void {
  if (response.choices.length === 0) {
    throwAnthropicApiError(
      'Upstream Copilot returned HTTP 200 but no chat completion choices, so the response cannot be translated into a completed Anthropic assistant turn.',
    )
  }

  if (hasVisibleAssistantOutput(response)) {
    return
  }

  if (hasThinkingAssistantOutput(response)) {
    throwAnthropicApiError(
      'Upstream Copilot returned reasoning output without any assistant text or tool call, so Claude Code would otherwise wait indefinitely for a completed turn.',
    )
  }

  throwAnthropicApiError(
    'Upstream Copilot returned an empty assistant completion without any text or tool call.',
  )
}

function throwAnthropicApiError(message: string): never {
  throw new JSONResponseError(message, 502, {
    type: 'error',
    error: {
      type: 'api_error',
      message,
    },
  })
}
