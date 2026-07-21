import type { Context } from 'hono'

import type { AnthropicMessagesPayload, AnthropicResponse, AnthropicStreamEventData } from '~/lib/translation/types'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'
import { isAbortError } from '~/lib/error'
import { findModelMaxOutputTokens } from '~/lib/model-utils'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { assertMessagesPayloadTranslatable, resolveRoute } from '~/lib/routing-policy'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'
import { getSetupProbeSignal } from '~/lib/setup-probe-context'

import { state } from '~/lib/state'
import { createAnthropicFromResponsesStreamState, translateAnthropicRequestToResponses, translateResponsesResponseToAnthropic, translateResponsesStreamEventToAnthropic } from '~/lib/translation'
import { assertCopilotCompatibleAnthropicRequest, throwAnthropicInvalidRequestError } from '~/lib/translation/anthropic-compat'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { isNullish } from '~/lib/utils'
import { validateBody } from '~/lib/validate'
import { createResponses, summarizeResponsesPayload } from '~/services/copilot/create-responses'
import {
  normalizeAnthropicModelName,
  sanitizeAnthropicBetaHeader,
} from './model-normalization'
import {
  assertNoUnsupportedAdvisorToolsForCopilot,
  createAnthropicMessagesWithThinkingSignatureRetry,
  normalizeAdaptiveThinkingForCopilot,
  overrideAnthropicResponseModel,
  overrideAnthropicStreamEventModel,
  prepareAnthropicPayloadForNativeCopilotBackend,
  prepareAnthropicPayloadForTranslatedBackends,
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
    consola.debug('Anthropic request summary:', summarizeAnthropicPayload(anthropicPayload))
  }

  await enforceManualApproval(state)

  const requestedModel = anthropicPayload.model
  // Normalize historical Anthropic model aliases while preserving the client's
  // requested model name in responses.
  const effectiveModel = normalizeAnthropicModelName(requestedModel)
  const modelMaxOutputTokens = findModelMaxOutputTokens(effectiveModel, state.models)

  if (isNullish(anthropicPayload.max_tokens)) {
    anthropicPayload = {
      ...anthropicPayload,
      max_tokens: modelMaxOutputTokens,
    }
    if (consola.level >= 4) {
      consola.debug('Set Anthropic max_tokens:', anthropicPayload.max_tokens)
    }
  }
  normalizeAdaptiveThinkingForCopilot(anthropicPayload)
  assertNoUnsupportedAdvisorToolsForCopilot(anthropicPayload)

  const route = resolveRoute('anthropic-messages', effectiveModel, throwAnthropicInvalidRequestError, {
    models: state.models?.data,
  })

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

/** Translation path: Anthropic → Responses → Anthropic */
async function handleViaResponses(
  c: Context,
  anthropicPayload: AnthropicMessagesPayload,
  effectiveModel: string,
  requestedModel: string,
) {
  const responsesPayload = translateAnthropicRequestToResponses(anthropicPayload, { model: effectiveModel })
  if (consola.level >= 4) {
    consola.debug('Translated Anthropic→Responses payload summary:', summarizeResponsesPayload(responsesPayload))
  }

  const setupSignal = getSetupProbeSignal(c)
  const result = await createResponses(responsesPayload, setupSignal ? { signal: setupSignal } : undefined)

  if (!isResponsesStreamBody(result.body)) {
    if (!isResponsesResponseBody(result.body)) {
      throwAnthropicInvalidRequestError(
        extractUnexpectedResponsesBodyMessage(result.body),
      )
    }
    if (consola.level >= 4) {
      consola.debug('Responses result summary (Anthropic path):', summarizeResponsesResult(result.body))
    }
    const anthropicResponse = translateResponsesResponseToAnthropic(result.body, { requestedModel })
    if (consola.level >= 4) {
      consola.debug('Translated Responses→Anthropic response summary:', summarizeAnthropicResponse(anthropicResponse))
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
          consola.error('Failed to parse Responses stream event:', {
            event: rawEvent.event ?? 'message',
            dataChars: rawEvent.data.length,
          })
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
      if (streamState.upstreamTerminalEventSeen && isAbortError(error)) {
        completed = !stream.aborted
        return
      }
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
        clientAborted: () => stream.aborted,
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
 * The Copilot backend natively supports the Anthropic Messages API format.
 * Request preparation stays narrow: normalize known Copilot incompatibilities
 * and expand only text-like documents that the native backend rejects.
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

  // Apply only the known native-backend compatibility adaptations.
  await prepareAnthropicPayloadForNativeCopilotBackend(payload)

  if (consola.level >= 4) {
    consola.debug('Native Anthropic passthrough summary:', summarizeAnthropicPayload(payload))
  }

  const setupSignal = getSetupProbeSignal(c)
  const result = await createAnthropicMessagesWithThinkingSignatureRetry(
    payload,
    {
      anthropicBeta: sanitizeAnthropicBetaHeader(anthropicBeta),
      ...(setupSignal && { signal: setupSignal }),
    },
  )

  if (!result.streaming) {
    if (consola.level >= 4) {
      consola.debug('Native Anthropic response summary:', summarizeAnthropicResponse(result.body))
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
          consola.error('Failed to parse native Anthropic stream event:', {
            event: rawEvent.event ?? 'message',
            dataChars: rawEvent.data.length,
          })
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

      if (shouldEmitNativeAnthropicTerminationError(passthroughState)) {
        consola.warn('Native Anthropic stream terminated without message_stop; returning an Anthropic error event.')
        await anthropicWriter.writeEvent(
          translateErrorToAnthropicErrorEvent(
            getUpstreamTerminationErrorMessage(passthroughState),
          ),
        )
      }
      completed = !stream.aborted
    }
    catch (error) {
      if ((passthroughState.messageStopSeen || passthroughState.errorSeen) && isAbortError(error)) {
        completed = !stream.aborted
        return
      }
      await handleAnthropicStreamFailure({
        completionTerm: 'completion event',
        error,
        errorLabel: 'Native Anthropic stream passthrough',
        streamLabel: 'Native Anthropic stream',
        state: passthroughState,
        unexpectedErrorMessage: 'An unexpected error occurred during native Anthropic stream passthrough.',
        writer: anthropicWriter,
        finalizeRecoveredEvents: () => finalizeNativeAnthropicPassthroughState(passthroughState),
        canRecoverTermination: () => false,
        clientAborted: () => stream.aborted,
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

function summarizeAnthropicPayload(payload: AnthropicMessagesPayload): Record<string, unknown> {
  let contentBlocks = 0
  let documentBlocks = 0
  let imageBlocks = 0
  let toolResultBlocks = 0
  let assistantToolUseBlocks = 0

  for (const message of payload.messages) {
    if (!Array.isArray(message.content))
      continue
    contentBlocks += message.content.length
    for (const block of message.content) {
      if (block.type === 'document')
        documentBlocks++
      else if (block.type === 'image')
        imageBlocks++
      else if (block.type === 'tool_result')
        toolResultBlocks++
      else if (block.type === 'tool_use')
        assistantToolUseBlocks++
    }
  }

  return {
    model: payload.model,
    stream: Boolean(payload.stream),
    messages: payload.messages.length,
    contentBlocks,
    documentBlocks,
    imageBlocks,
    toolResultBlocks,
    assistantToolUseBlocks,
    tools: payload.tools?.length ?? 0,
    maxTokens: payload.max_tokens,
    thinkingType: payload.thinking?.type,
    outputFormatType: payload.output_config?.format?.type,
    systemBlocks: Array.isArray(payload.system) ? payload.system.length : payload.system ? 1 : 0,
  }
}

function summarizeResponsesResult(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object')
    return { kind: typeof body }

  const response = body as Record<string, unknown>
  return {
    object: typeof response.object === 'string' ? response.object : undefined,
    status: typeof response.status === 'string' ? response.status : undefined,
    model: typeof response.model === 'string' ? response.model : undefined,
    outputItems: Array.isArray(response.output) ? response.output.length : undefined,
    hasError: response.error != null,
  }
}

function summarizeAnthropicResponse(response: AnthropicResponse): Record<string, unknown> {
  return {
    type: response.type,
    model: response.model,
    contentBlocks: response.content.length,
    contentTypes: response.content.map(block => block.type),
    stopReason: response.stop_reason,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  }
}
