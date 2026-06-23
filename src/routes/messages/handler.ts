import type { Context } from 'hono'

import type { AnthropicMessagesPayload, AnthropicStreamEventData } from '~/lib/translation/types'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'
import { findModelWithFallback } from '~/lib/model-utils'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { assertMessagesPayloadTranslatable, resolveRoute } from '~/lib/routing-policy'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'

import { state } from '~/lib/state'
import { createAnthropicFromResponsesStreamState, translateAnthropicRequestToResponses, translateResponsesResponseToAnthropic, translateResponsesStreamEventToAnthropic } from '~/lib/translation'
import { assertCopilotCompatibleAnthropicRequest, throwAnthropicInvalidRequestError } from '~/lib/translation/anthropic-compat'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { isNullish } from '~/lib/utils'
import { validateBody } from '~/lib/validate'
import { createResponses } from '~/services/copilot/create-responses'
import {
  normalizeAnthropicModelName,
  sanitizeAnthropicBetaHeader,
} from './model-normalization'
import {
  convertEnabledThinkingToAdaptiveForCopilot,
  createAnthropicMessagesWithThinkingSignatureRetry,
  normalizeAdaptiveThinkingForCopilot,
  overrideAnthropicResponseModel,
  overrideAnthropicStreamEventModel,
  prepareAnthropicPayloadForTranslatedBackends,
  sanitizeForCopilotBackend,
} from './request-adaptation'
import { createAnthropicSSEWriter } from './sse-writer'
import {
  createNativeAnthropicPassthroughState,
  finalizeAnthropicStreamFromState,
  finalizeNativeAnthropicPassthroughState,
  finalizeTruncatedAnthropicStreamFromState,
  getUpstreamTerminationErrorMessage,
  handleAnthropicStreamFailure,
  shouldEmitNativeAnthropicTerminationError,
  translateErrorToAnthropicErrorEvent,
  updateNativeAnthropicPassthroughState,
  writeAnthropicEvents,
} from './stream-finalizer'

export async function handleCompletion(c: Context) {
  await enforceRateLimit(state)

  const anthropicBeta = c.req.header('anthropic-beta')
  let anthropicPayload = await validateBody<AnthropicMessagesPayload>(c, AnthropicMessagesPayloadSchema)
  if (consola.level >= 4) {
    consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))
  }

  await enforceManualApproval(state)

  const requestedModel = anthropicPayload.model
  // Normalize historical Anthropic model aliases while preserving the client's
  // requested model name in responses.
  const effectiveModel = normalizeAnthropicModelName(requestedModel)
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

  convertEnabledThinkingToAdaptiveForCopilot(anthropicPayload)
  normalizeAdaptiveThinkingForCopilot(anthropicPayload)

  const route = resolveRoute('anthropic-messages', effectiveModel, throwAnthropicInvalidRequestError, {
    models: state.models?.data,
  })

  try {
    switch (route.backend) {
      case 'anthropic-messages':
        assertCopilotCompatibleAnthropicRequest(anthropicPayload, { allowDocuments: true })
        return await handleViaNativeAnthropic(
          c,
          anthropicPayload,
          anthropicBeta,
          effectiveModel,
          requestedModel,
        )
      case 'responses':
        assertMessagesPayloadTranslatable(anthropicPayload, throwAnthropicInvalidRequestError)
        await prepareAnthropicPayloadForTranslatedBackends(anthropicPayload)
        return await handleViaResponses(c, anthropicPayload, effectiveModel, requestedModel)
      case 'chat-completions':
        // Unreachable: resolveRoute() never returns chat-completions for an Anthropic client.
        throwAnthropicInvalidRequestError(
          `Model ${effectiveModel} cannot be served via /v1/messages (would require translating to /chat/completions, which is disallowed).`,
        )
    }
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return c.body(null)
    throw error
  }
}

/** Translation path: Anthropic → Responses → Anthropic */
async function handleViaResponses(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  effectiveModel: string,
  requestedModel: string,
) {
  const responsesPayload = translateAnthropicRequestToResponses(anthropicPayload, { model: effectiveModel })
  if (consola.level >= 4) {
    consola.debug('Translated Anthropic→Responses payload:', JSON.stringify(responsesPayload).slice(-400))
  }

  const result = await createResponses(responsesPayload)

  if (!isResponsesStreamBody(result.body)) {
    if (!isResponsesResponseBody(result.body)) {
      throwAnthropicInvalidRequestError(
        extractUnexpectedResponsesBodyMessage(result.body),
      )
    }
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
    let completed = false
    stream.onAbort(() => result.cancel?.('anthropic client disconnected before translated Responses stream completed'))

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

      if (!stream.aborted) {
        const finalEvents = streamState.upstreamTerminalEventSeen
          ? finalizeAnthropicStreamFromState(streamState)
          : finalizeTruncatedAnthropicStreamFromState(streamState)
        await writeAnthropicEvents(anthropicWriter, finalEvents)
        completed = true
      }
    }
    catch (error) {
      await handleAnthropicStreamFailure({
        completionTerm: 'completion event',
        error,
        errorLabel: 'Responses stream translation',
        streamLabel: 'Responses stream',
        state: streamState,
        unexpectedErrorMessage: 'An unexpected error occurred while translating the Copilot Responses stream.',
        writer: anthropicWriter,
        finalizeRecoveredEvents: () => [],
        canRecoverTermination: () => false,
      })
      return
    }
    finally {
      await anthropicWriter.close()
      if (!completed) {
        await result.cancel?.('anthropic client disconnected before translated Responses stream completed')
      }
    }
  })
}

function isResponsesStreamBody(
  body: Awaited<ReturnType<typeof createResponses>>['body'],
): body is AsyncIterable<{ data?: string }> {
  return typeof (body as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === 'function'
}

function isResponsesResponseBody(
  body: Awaited<ReturnType<typeof createResponses>>['body'],
): body is import('~/services/copilot/create-responses').ResponsesResponse {
  return typeof body === 'object'
    && body !== null
    && Array.isArray((body as { output?: unknown }).output)
    && typeof (body as { status?: unknown }).status === 'string'
}

function extractUnexpectedResponsesBodyMessage(
  body: Awaited<ReturnType<typeof createResponses>>['body'],
): string {
  if (typeof body === 'object' && body !== null) {
    const error = (body as { error?: unknown }).error
    if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
  }

  return 'Copilot Responses upstream returned a non-stream JSON payload that is not a Responses response.'
}

/**
 * Native Anthropic passthrough: Anthropic → /v1/messages → Anthropic
 *
 * No translation needed. The Copilot backend natively supports the
 * Anthropic Messages API format, so we forward the payload as-is
 * (after minimal sanitization and max_tokens clamping).
 *
 * For streaming, upstream SSE events are already in Anthropic format,
 * so we pipe them directly with keep-alive pings.
 */
async function handleViaNativeAnthropic(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
  effectiveModel: string,
  requestedModel: string,
) {
  // Forward the normalized upstream model while preserving the requested model
  // name in client-visible responses.
  const payload: AnthropicMessagesPayload = {
    ...anthropicPayload,
    model: effectiveModel,
  }

  // Minimal sanitization for fields the Copilot backend rejects.
  // Unlike the CC translation path this is surgical; everything else passes through.
  sanitizeForCopilotBackend(payload)

  if (consola.level >= 4) {
    consola.debug('Native Anthropic passthrough payload:', JSON.stringify(payload))
  }

  const result = await createAnthropicMessagesWithThinkingSignatureRetry(payload, {
    anthropicBeta: sanitizeAnthropicBetaHeader(anthropicBeta),
  })

  if (!result.streaming) {
    if (consola.level >= 4) {
      consola.debug('Native Anthropic non-streaming response:', JSON.stringify(result.body))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(overrideAnthropicResponseModel(result.body, requestedModel))
  }

  // Streaming: upstream SSE is already in Anthropic format.
  // Pipe events through the writer for keep-alive ping support.
  consola.debug('Native Anthropic streaming passthrough')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    const anthropicWriter = createAnthropicSSEWriter(stream)
    const passthroughState = createNativeAnthropicPassthroughState()
    let completed = false
    stream.onAbort(() => result.cancel?.('anthropic client disconnected before native Anthropic stream completed'))

    try {
      for await (const rawEvent of streamBody) {
        if (stream.aborted)
          break
        if (rawEvent.data === '[DONE]')
          break
        if (!rawEvent.data)
          continue

        let event: AnthropicStreamEventData
        try {
          event = JSON.parse(rawEvent.data) as AnthropicStreamEventData
        }
        catch {
          consola.error('Failed to parse native Anthropic stream event:', rawEvent.data)
          await anthropicWriter.writeEvent(
            translateErrorToAnthropicErrorEvent('Failed to parse a streaming event from the Copilot Anthropic upstream response.'),
          )
          return
        }

        const eventToWrite = overrideAnthropicStreamEventModel(event, requestedModel)
        updateNativeAnthropicPassthroughState(passthroughState, eventToWrite)

        await anthropicWriter.writeEvent(eventToWrite)

        if (eventToWrite.type === 'error') {
          return
        }
      }

      const finalEvents = finalizeNativeAnthropicPassthroughState(passthroughState)
      if (finalEvents.length > 0) {
        consola.warn('Native Anthropic stream terminated without a completion event; synthesizing Anthropic message_stop.')
        await writeAnthropicEvents(anthropicWriter, finalEvents)
        completed = true
        return
      }

      if (shouldEmitNativeAnthropicTerminationError(passthroughState)) {
        consola.warn('Native Anthropic stream terminated without recoverable assistant output; returning Anthropic error event.')
        await anthropicWriter.writeEvent(
          translateErrorToAnthropicErrorEvent(
            getUpstreamTerminationErrorMessage(passthroughState),
          ),
        )
      }
      completed = !stream.aborted
    }
    catch (error) {
      await handleAnthropicStreamFailure({
        completionTerm: 'completion event',
        error,
        errorLabel: 'Native Anthropic stream passthrough',
        streamLabel: 'Native Anthropic stream',
        state: passthroughState,
        unexpectedErrorMessage: 'An unexpected error occurred during native Anthropic stream passthrough.',
        writer: anthropicWriter,
        finalizeRecoveredEvents: () => finalizeNativeAnthropicPassthroughState(passthroughState),
        shouldEmitTerminationError: () => shouldEmitNativeAnthropicTerminationError(passthroughState),
      })
      return
    }
    finally {
      await anthropicWriter.close()
      if (!completed) {
        await result.cancel?.('anthropic client disconnected before native Anthropic stream completed')
      }
    }
  })
}
