import type { Context } from 'hono'

import type { AnthropicMessagesPayload, AnthropicResponse, AnthropicStreamEventData, AnthropicStreamState } from './anthropic-types'
import type { ChatCompletionChunk, ChatCompletionResponse } from '~/services/copilot/create-chat-completions'
import type { ResponsesResponse } from '~/services/copilot/create-responses'
import type { Model } from '~/services/copilot/get-models'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'
import { awaitApproval } from '~/lib/approval'
import { runBackendPlan } from '~/lib/backend-plan'
import { HTTPError, JSONResponseError } from '~/lib/error'
import { checkRateLimit } from '~/lib/rate-limit'
import { planMessagesBackends } from '~/lib/routing-policy'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'

import { state } from '~/lib/state'
import { createAnthropicFromResponsesStreamState, translateAnthropicRequestToResponses, translateResponsesResponseToAnthropic, translateResponsesStreamEventToAnthropic } from '~/lib/translation'
import { assertCopilotCompatibleAnthropicRequest, logLossyAnthropicCompatibility, throwAnthropicInvalidRequestError } from '~/lib/translation/anthropic-compat'
import { expandDocumentBlocks, normalizeLegacyDocumentTextSources } from '~/lib/translation/anthropic-documents'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { isNullish } from '~/lib/utils'
import { validateBody } from '~/lib/validate'
import { createAnthropicMessages } from '~/services/copilot/create-anthropic-messages'
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
  sanitizeAnthropicBetaHeader,
  translateToAnthropic,
  translateToOpenAI,
} from './non-stream-translation'
import { createAnthropicSSEWriter } from './sse-writer'
import { canRecoverUpstreamTerminationAsMessage, finalizeAnthropicStreamFromState, translateChunkToAnthropicEvents, translateErrorToAnthropicErrorEvent } from './stream-translation'

const INVALID_THINKING_SIGNATURE_PATTERN = /invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i

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

  normalizeAnthropicThinkingForCopilot(anthropicPayload)

  const ensureTranslatedPayloadPrepared = onceAsync(async () => {
    await prepareAnthropicPayloadForTranslatedBackends(anthropicPayload)
  })
  const routingPolicy = planMessagesBackends(effectiveModel, anthropicPayload)

  if (routingPolicy.localError) {
    throwAnthropicInvalidRequestError(routingPolicy.localError)
  }

  if (
    routingPolicy.resolvedBackend === 'anthropic-messages'
    && routingPolicy.steps[0]?.api !== 'anthropic-messages'
    && routingPolicy.steps[0]?.context
  ) {
    consola.debug(`Skipping native Anthropic passthrough for ${effectiveModel} because ${routingPolicy.steps[0].context}`)
  }

  const steps = routingPolicy.steps.map(step => ({
    ...step,
    run: async () => {
      switch (step.api) {
        case 'anthropic-messages': {
          assertCopilotCompatibleAnthropicRequest(anthropicPayload, { allowDocuments: true })
          return await handleViaNativeAnthropic(
            c,
            anthropicPayload,
            anthropicBeta,
            effectiveModel,
            requestedModel,
          )
        }
        case 'chat-completions': {
          await ensureTranslatedPayloadPrepared()
          return await handleViaChatCompletions(
            c,
            anthropicPayload,
            anthropicBeta,
            requestedModel,
          )
        }
        case 'responses': {
          await ensureTranslatedPayloadPrepared()
          return await handleViaResponses(
            c,
            anthropicPayload,
            effectiveModel,
            requestedModel,
          )
        }
      }
    },
  }))

  try {
    return await runBackendPlan({
      model: effectiveModel,
      steps,
    })
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return c.body(null)
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
  requestedModel: string,
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

  const result = await createChatCompletions(upstreamPayload)

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

        await writeAnthropicEvents(anthropicWriter, events, { debugTranslatedEvents: true })
      }

      const finalEvents = finalizeAnthropicStreamFromState(streamState)
      await writeAnthropicEvents(anthropicWriter, finalEvents, { debugTranslatedEvents: true })
    }
    catch (error) {
      await handleAnthropicStreamFailure({
        completionTerm: 'finish chunk',
        error,
        errorLabel: 'Chat Completions stream translation',
        streamLabel: 'Chat Completions stream',
        state: streamState,
        unexpectedErrorMessage: 'An unexpected error occurred while translating the Copilot stream.',
        writer: anthropicWriter,
        finalizeRecoveredEvents: () => finalizeAnthropicStreamFromState(streamState),
        canRecoverTermination: () => canRecoverUpstreamTerminationAsMessage(streamState),
        debugTranslatedEvents: true,
      })
      return
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

function isCCNonStreaming(body: Awaited<ReturnType<typeof createChatCompletions>>['body']): body is ChatCompletionResponse {
  return Object.hasOwn(body, 'choices')
}

function isResponsesNonStreaming(body: Awaited<ReturnType<typeof createResponses>>['body']): body is ResponsesResponse {
  return Object.hasOwn(body, 'output')
}

type AnthropicEventWriter = ReturnType<typeof createAnthropicSSEWriter>

interface RecoverableAnthropicOutputState {
  hasNonThinkingContent: boolean
  hasThinkingContent: boolean
}

interface AnthropicStreamFailureOptions {
  completionTerm: string
  error: unknown
  errorLabel: string
  streamLabel: string
  state: RecoverableAnthropicOutputState
  unexpectedErrorMessage: string
  writer: AnthropicEventWriter
  finalizeRecoveredEvents: () => Array<AnthropicStreamEventData>
  canRecoverTermination?: () => boolean
  shouldEmitTerminationError?: () => boolean
  debugTranslatedEvents?: boolean
}

async function writeAnthropicEvents(
  writer: AnthropicEventWriter,
  events: Array<AnthropicStreamEventData>,
  options?: {
    debugTranslatedEvents?: boolean
  },
): Promise<void> {
  for (const event of events) {
    if (options?.debugTranslatedEvents && consola.level >= 4) {
      consola.debug('Translated Anthropic event:', JSON.stringify(event))
    }
    await writer.writeEvent(event)
  }
}

async function handleAnthropicStreamFailure(
  options: AnthropicStreamFailureOptions,
): Promise<void> {
  if (options.error instanceof Error && options.error.name === 'AbortError') {
    return
  }

  const upstreamTerminated = isRecoverableUpstreamTermination(options.error)
  const recoveredEvents = upstreamTerminated && (options.canRecoverTermination?.() ?? true)
    ? options.finalizeRecoveredEvents()
    : []

  if (recoveredEvents.length > 0) {
    consola.warn(`${options.streamLabel} terminated without a ${options.completionTerm}; synthesizing Anthropic message_stop.`)
    await writeAnthropicEvents(options.writer, recoveredEvents, {
      debugTranslatedEvents: options.debugTranslatedEvents,
    })
    return
  }

  if (upstreamTerminated && (options.shouldEmitTerminationError?.() ?? true)) {
    consola.warn(`${options.streamLabel} terminated without recoverable assistant output; returning Anthropic error event.`)
    await options.writer.writeEvent(
      translateErrorToAnthropicErrorEvent(
        getUpstreamTerminationErrorMessage(options.state),
      ),
    )
    return
  }

  const message = options.error instanceof Error
    ? options.error.message
    : options.unexpectedErrorMessage
  consola.error(`${options.errorLabel} failed:`, options.error)
  await options.writer.writeEvent(translateErrorToAnthropicErrorEvent(message))
}

function getUpstreamTerminationErrorMessage(
  state: RecoverableAnthropicOutputState,
): string {
  return state.hasThinkingContent && !state.hasNonThinkingContent
    ? 'Upstream Copilot connection terminated after reasoning output, before any assistant text or tool call was produced.'
    : 'Upstream Copilot connection terminated before the response completed.'
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
  // Unlike the CC translation path this is surgical — everything else passes through.
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
        const message = passthroughState.hasThinkingContent && !passthroughState.hasNonThinkingContent
          ? 'Upstream Copilot connection terminated after reasoning output, before any assistant text or tool call was produced.'
          : 'Upstream Copilot connection terminated before the response completed.'
        consola.warn('Native Anthropic stream terminated without recoverable assistant output; returning Anthropic error event.')
        await anthropicWriter.writeEvent(translateErrorToAnthropicErrorEvent(message))
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

async function createAnthropicMessagesWithThinkingSignatureRetry(
  payload: AnthropicMessagesPayload,
  options?: { signal?: AbortSignal, anthropicBeta?: string },
): ReturnType<typeof createAnthropicMessages> {
  try {
    return await createAnthropicMessages(payload, options)
  }
  catch (error) {
    if (!await isInvalidThinkingSignatureError(error)) {
      throw error
    }

    const stripped = stripAssistantThinkingBlocks(payload)
    if (!stripped.stripped) {
      throw error
    }

    logLossyAnthropicCompatibility(
      'assistant thinking replay',
      'Native /v1/messages rejected a replayed assistant thinking signature, so the proxy retried once after stripping assistant thinking/redacted_thinking history.',
    )

    const requestId = error instanceof HTTPError
      ? error.response.headers.get('x-request-id')
      : null
    const requestIdSuffix = requestId ? ` (request id: ${requestId})` : ''
    const droppedSuffix = stripped.droppedAssistantMessages > 0
      ? ` and dropping ${stripped.droppedAssistantMessages} thinking-only assistant turn(s)`
      : ''

    consola.warn(
      `Native Anthropic passthrough retrying once after removing ${stripped.strippedBlocks} assistant thinking/redacted_thinking block(s)${droppedSuffix}${requestIdSuffix}.`,
    )

    if (consola.level >= 4) {
      consola.debug('Native Anthropic self-heal payload:', JSON.stringify(stripped.payload))
    }

    return await createAnthropicMessages(stripped.payload, options)
  }
}

/**
 * Minimal sanitization for the native Anthropic passthrough path.
 *
 * The Copilot backend rejects a small number of fields that Claude Code
 * sends. Rather than translating the entire payload (as the CC path does),
 * we surgically strip only the known-bad fields and leave everything else
 * intact.
 *
 * Mutates the payload in place.
 */
function sanitizeForCopilotBackend(payload: AnthropicMessagesPayload): void {
  const payloadWithContextManagement = payload as AnthropicMessagesPayload & {
    context_management?: unknown
  }

  // 1. context_management — Copilot does not support this field (with or without beta flag)
  if ('context_management' in payloadWithContextManagement) {
    consola.debug('Stripping context_management (unsupported by Copilot backend)')
    delete payloadWithContextManagement.context_management
  }

  if (payload.cache_control) {
    logLossyAnthropicCompatibility(
      'cache_control',
      'Copilot native /v1/messages rejects top-level cache_control, so the proxy drops it before passthrough.',
    )
    delete payload.cache_control
  }

  normalizeLegacyDocumentTextSources(payload)

  const format = payload.output_config?.format
  if (!format || typeof format !== 'object' || format.type !== 'json_schema') {
    return
  }

  const formatRecord = format as Record<string, unknown>
  const nestedJsonSchema = isRecord(formatRecord.json_schema)
    ? formatRecord.json_schema
    : undefined
  const hasFlatSchema = isRecord(formatRecord.schema)
  const hasNestedSchema = isRecord(nestedJsonSchema?.schema)

  if (hasFlatSchema && hasNestedSchema) {
    throwAnthropicInvalidRequestError(
      'Anthropic output_config.format for json_schema must use either flat "schema" or legacy "json_schema.schema", not both.',
    )
  }

  if (!hasFlatSchema && hasNestedSchema) {
    formatRecord.schema = nestedJsonSchema!.schema
  }

  if (!isRecord(formatRecord.schema)) {
    throwAnthropicInvalidRequestError(
      'Anthropic output_config.format.type="json_schema" requires an object "schema".',
    )
  }

  if ('json_schema' in formatRecord) {
    consola.debug('Flattening legacy output_config.format.json_schema to output_config.format.schema')
    delete formatRecord.json_schema
  }

  if ('name' in formatRecord) {
    consola.debug('Stripping output_config.format.name (unsupported by Copilot /v1/messages backend)')
    delete formatRecord.name
  }

  if ('strict' in formatRecord) {
    consola.debug('Stripping output_config.format.strict (unsupported by Copilot /v1/messages backend)')
    delete formatRecord.strict
  }
}

async function isInvalidThinkingSignatureError(error: unknown): Promise<boolean> {
  if (!(error instanceof HTTPError) || error.response.status !== 400) {
    return false
  }

  const upstreamMessage = await readUpstreamErrorMessage(error.response)
  return typeof upstreamMessage === 'string'
    && INVALID_THINKING_SIGNATURE_PATTERN.test(upstreamMessage)
}

async function readUpstreamErrorMessage(response: Response): Promise<string | undefined> {
  let errorText: string
  try {
    errorText = await response.clone().text()
  }
  catch {
    return undefined
  }

  if (!errorText) {
    return undefined
  }

  try {
    return extractUpstreamErrorMessage(JSON.parse(errorText)) ?? errorText
  }
  catch {
    return errorText
  }
}

function extractUpstreamErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  if (typeof payload.message === 'string') {
    return payload.message
  }

  const error = payload.error
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message
  }

  return undefined
}

function stripAssistantThinkingBlocks(
  payload: AnthropicMessagesPayload,
): {
  payload: AnthropicMessagesPayload
  stripped: boolean
  strippedBlocks: number
  droppedAssistantMessages: number
} {
  let strippedBlocks = 0
  let droppedAssistantMessages = 0

  const messages = payload.messages.flatMap((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return [message]
    }

    const content = message.content.filter((block) => {
      const shouldStrip = block.type === 'thinking' || block.type === 'redacted_thinking'
      if (shouldStrip) {
        strippedBlocks += 1
      }
      return !shouldStrip
    })

    if (content.length === message.content.length) {
      return [message]
    }

    if (content.length === 0) {
      droppedAssistantMessages += 1
      return []
    }

    return [{ ...message, content }]
  })

  if (strippedBlocks === 0) {
    return {
      payload,
      stripped: false,
      strippedBlocks: 0,
      droppedAssistantMessages: 0,
    }
  }

  return {
    payload: {
      ...payload,
      messages,
    },
    stripped: true,
    strippedBlocks,
    droppedAssistantMessages,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeAnthropicThinkingForCopilot(
  payload: AnthropicMessagesPayload,
): void {
  if (!payload.thinking || typeof payload.thinking !== 'object' || !('type' in payload.thinking)) {
    return
  }

  if (payload.thinking.type !== 'adaptive') {
    return
  }

  const thinking = payload.thinking as Record<string, unknown>
  if ('budget_tokens' in thinking) {
    throwAnthropicInvalidRequestError(
      'thinking.adaptive.budget_tokens: Extra inputs are not permitted',
    )
  }

  if ('budget_tokens_max' in thinking) {
    consola.debug('Stripping budget_tokens_max from adaptive thinking (unsupported by Copilot)')
    delete thinking.budget_tokens_max
  }
}

async function prepareAnthropicPayloadForTranslatedBackends(
  payload: AnthropicMessagesPayload,
): Promise<void> {
  normalizeLegacyDocumentTextSources(payload)
  await expandDocumentBlocks(payload)
  assertCopilotCompatibleAnthropicRequest(payload)
}

function onceAsync(factory: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined
  return async () => {
    pending ??= factory()
    await pending
  }
}

interface NativeAnthropicPassthroughState {
  currentBlockIndex: number | null
  currentBlockType: 'text' | 'thinking' | 'tool_use' | null
  errorSeen: boolean
  hasNonThinkingContent: boolean
  hasThinkingContent: boolean
  messageDeltaSeen: boolean
  messageStartSeen: boolean
  messageStopSeen: boolean
  outputTokens: number
}

function createNativeAnthropicPassthroughState(): NativeAnthropicPassthroughState {
  return {
    currentBlockIndex: null,
    currentBlockType: null,
    errorSeen: false,
    hasNonThinkingContent: false,
    hasThinkingContent: false,
    messageDeltaSeen: false,
    messageStartSeen: false,
    messageStopSeen: false,
    outputTokens: 0,
  }
}

function updateNativeAnthropicPassthroughState(
  state: NativeAnthropicPassthroughState,
  event: AnthropicStreamEventData,
): void {
  switch (event.type) {
    case 'message_start': {
      state.messageStartSeen = true
      state.outputTokens = event.message.usage.output_tokens
      return
    }

    case 'content_block_start': {
      state.currentBlockIndex = event.index
      state.currentBlockType = event.content_block.type

      if (event.content_block.type === 'thinking') {
        state.hasThinkingContent = true
      }
      else {
        state.hasNonThinkingContent = true
      }
      return
    }

    case 'content_block_delta': {
      if (event.delta.type === 'thinking_delta' || event.delta.type === 'signature_delta') {
        state.hasThinkingContent = true
      }
      else {
        state.hasNonThinkingContent = true
      }
      return
    }

    case 'content_block_stop': {
      if (state.currentBlockIndex === event.index) {
        state.currentBlockIndex = null
        state.currentBlockType = null
      }
      return
    }

    case 'message_delta': {
      state.messageDeltaSeen = true
      state.outputTokens = event.usage?.output_tokens ?? state.outputTokens
      return
    }

    case 'message_stop': {
      state.messageStopSeen = true
      return
    }

    case 'error': {
      state.errorSeen = true
      break
    }

    case 'ping': {
      break
    }
  }
}

function finalizeNativeAnthropicPassthroughState(
  state: NativeAnthropicPassthroughState,
): Array<AnthropicStreamEventData> {
  if (!state.messageStartSeen || state.messageStopSeen || state.errorSeen || !state.hasNonThinkingContent) {
    return []
  }

  if (state.currentBlockType === 'tool_use') {
    return []
  }

  const events: Array<AnthropicStreamEventData> = []

  if (state.currentBlockIndex !== null) {
    events.push({
      type: 'content_block_stop',
      index: state.currentBlockIndex,
    })
    state.currentBlockIndex = null
    state.currentBlockType = null
  }

  if (!state.messageDeltaSeen) {
    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      usage: {
        output_tokens: state.outputTokens,
      },
    })
  }

  events.push({ type: 'message_stop' })
  state.messageStopSeen = true
  return events
}

function shouldEmitNativeAnthropicTerminationError(
  state: NativeAnthropicPassthroughState,
): boolean {
  return state.messageStartSeen && !state.messageStopSeen && !state.errorSeen
}

function overrideAnthropicResponseModel(
  response: AnthropicResponse,
  requestedModel: string,
): AnthropicResponse {
  return {
    ...response,
    model: requestedModel,
  }
}

function overrideAnthropicStreamEventModel(
  event: AnthropicStreamEventData,
  requestedModel: string,
): AnthropicStreamEventData {
  if (event.type !== 'message_start') {
    return event
  }

  return {
    ...event,
    message: {
      ...event.message,
      model: requestedModel,
    },
  }
}
