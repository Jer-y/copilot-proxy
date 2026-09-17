import type { Context } from 'hono'

import type { AccountContext } from '~/lib/account/types'
import type { AnthropicMessagesPayload, AnthropicResponse, AnthropicStreamEventData } from '~/lib/anthropic/types'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'
import { getAccountRegistry } from '~/lib/account/registry'
import { selectAccount } from '~/lib/account/router'
import { throwAnthropicInvalidRequestError } from '~/lib/anthropic/compat'
import { isAbortError } from '~/lib/error'
import { findModelMaxOutputTokens } from '~/lib/model-utils'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { resolveRoute } from '~/lib/routing-policy'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'

import { getSetupProbeSignal } from '~/lib/setup-probe-context'
import { state } from '~/lib/state'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { isNullish } from '~/lib/utils'
import { validateBody } from '~/lib/validate'
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
} from './request-adaptation'
import { createAnthropicSSEWriter } from './sse-writer'
import {
  createAnthropicErrorEvent,
  createNativeAnthropicPassthroughState,
  finalizeNativeAnthropicPassthroughState,
  getUpstreamTerminationErrorMessage,
  handleAnthropicStreamFailure,
  shouldEmitNativeAnthropicTerminationError,
  updateNativeAnthropicPassthroughState,
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
  const selection = selectAccount({
    registry: getAccountRegistry(),
    requestedModel,
    headers: c.req.raw.headers,
    normalizeModel: normalizeAnthropicModelName,
  })
  // Normalize historical Anthropic model aliases while preserving the client's
  // requested model name in responses.
  const effectiveModel = selection.effectiveModel
  anthropicPayload = effectiveModel === anthropicPayload.model
    ? anthropicPayload
    : { ...anthropicPayload, model: effectiveModel }
  const modelMaxOutputTokens = findModelMaxOutputTokens(effectiveModel, selection.ctx.models)

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

  resolveRoute('anthropic-messages', effectiveModel, throwAnthropicInvalidRequestError, {
    models: selection.ctx.models?.data,
  })

  return await handleViaNativeAnthropic(
    c,
    anthropicPayload,
    anthropicBeta,
    effectiveModel,
    requestedModel,
    selection.ctx,
  )
}

/**
 * Native Anthropic passthrough: Anthropic → /v1/messages → Anthropic
 *
 * The Copilot backend natively supports the Anthropic Messages API format.
 * Request preparation stays narrow: normalize known Copilot incompatibilities
 * and enforce the generation-specific Claude Code document boundary.
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
  ctx: AccountContext,
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
      ctx,
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
            createAnthropicErrorEvent('Failed to parse a streaming event from the Copilot Anthropic upstream response.'),
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
          createAnthropicErrorEvent(
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
