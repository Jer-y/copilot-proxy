import type { Context } from 'hono'

import type { AnthropicMessagesPayload, AnthropicStreamEventData } from '~/lib/translation/types'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'
import { awaitApproval } from '~/lib/approval'
import { findModelWithFallback } from '~/lib/model-utils'
import { checkRateLimit } from '~/lib/rate-limit'
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
  applyModelVariant,
  sanitizeAnthropicBetaHeader,
} from './model-variants'
import {
  createAnthropicMessagesWithThinkingSignatureRetry,
  normalizeAdaptiveThinkingForCopilot,
  overrideAnthropicResponseModel,
  overrideAnthropicStreamEventModel,
  prepareAnthropicPayloadForTranslatedBackends,
  sanitizeForCopilotBackend,
} from './request-adaptation'
import { createAnthropicSSEWriter } from './sse-writer'
import {
  canRecoverUpstreamTerminationAsMessage,
  createNativeAnthropicPassthroughState,
  finalizeAnthropicStreamFromState,
  finalizeNativeAnthropicPassthroughState,
  getUpstreamTerminationErrorMessage,
  handleAnthropicStreamFailure,
  shouldEmitNativeAnthropicTerminationError,
  translateErrorToAnthropicErrorEvent,
  updateNativeAnthropicPassthroughState,
  writeAnthropicEvents,
} from './stream-finalizer'

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

  normalizeAdaptiveThinkingForCopilot(anthropicPayload)

  const route = resolveRoute('anthropic-messages', effectiveModel, throwAnthropicInvalidRequestError)

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
      await writeAnthropicEvents(anthropicWriter, finalEvents)
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
        finalizeRecoveredEvents: () => finalizeAnthropicStreamFromState(streamState),
        canRecoverTermination: () => canRecoverUpstreamTerminationAsMessage(streamState),
      })
      return
    }
    finally {
      await anthropicWriter.close()
    }
  })
}

function isResponsesNonStreaming(body: Awaited<ReturnType<typeof createResponses>>['body']): body is import('~/services/copilot/create-responses').ResponsesResponse {
  return Object.hasOwn(body, 'output')
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
  // Override model to effective (variant-resolved) model
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
    }
  })
}
