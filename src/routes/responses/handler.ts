import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { AnthropicStreamEventData } from '~/lib/translation/types'
import type { ChatCompletionResponse } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload, ResponsesResponse } from '~/services/copilot/create-responses'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { isApiProbedUnsupported, isUnsupportedApiError, recordProbeResult } from '~/lib/api-probe'
import { awaitApproval } from '~/lib/approval'
import { HTTPError, JSONResponseError } from '~/lib/error'
import { resolveBackend } from '~/lib/model-config'
import { findModelMaxOutputTokens } from '~/lib/model-utils'
import { checkRateLimit } from '~/lib/rate-limit'
import { ResponsesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import {
  createAnthropicToResponsesStreamState,
  createCCToResponsesStreamState,
  translateAnthropicResponseToResponses,
  translateAnthropicStreamEventToResponses,
  translateCCResponseToResponses,
  translateCCStreamChunkToResponses,
  translateResponsesRequestToCC,
} from '~/lib/translation'
import { translateResponsesRequestToAnthropic } from '~/lib/translation/responses-to-anthropic'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { validateBody } from '~/lib/validate'
import { createAnthropicMessages } from '~/services/copilot/create-anthropic-messages'
import { createChatCompletions } from '~/services/copilot/create-chat-completions'
import { createResponses, summarizeResponsesPayload } from '~/services/copilot/create-responses'

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await validateBody<ResponsesPayload>(c, ResponsesPayloadSchema)
  consola.debug('Responses API request summary:', {
    ...summarizeResponsesPayload(payload),
    contentLength: c.req.header('content-length') ?? undefined,
  })

  if (state.manualApprove) {
    await awaitApproval()
  }

  const signal = c.req.raw.signal

  // Resolve which backend API to use
  const backend = resolveBackend(payload.model, 'responses')

  if (backend === 'chat-completions') {
    try {
      return await handleViaChatCompletions(c, payload, signal)
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return c.body(null)
      if (error instanceof HTTPError && await isUnsupportedApiError(error.response)) {
        consola.info(`Model ${payload.model} does not support /chat/completions, falling back to /responses`)
        recordProbeResult(payload.model, 'chat-completions')
        try {
          return await handleViaResponses(c, payload, signal)
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

  if (backend === 'anthropic-messages') {
    const localRejectionReason = getAnthropicTranslationRejectionReason(payload)
    if (localRejectionReason) {
      throwInvalidResponsesRequest(localRejectionReason)
    }

    const responsesBypassReason = getAnthropicResponsesBypassReason(payload)
    if (responsesBypassReason) {
      return await handleViaResponsesWithChatFallback(
        c,
        payload,
        signal,
        responsesBypassReason,
      )
    }

    const ccBypassReason = getAnthropicChatCompletionsBypassReason(payload)
    if (ccBypassReason) {
      return await handleViaOpenAICompatibleBackends(
        c,
        payload,
        signal,
        ccBypassReason,
      )
    }

    try {
      return await handleViaAnthropic(c, payload, signal)
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return c.body(null)
      if (error instanceof HTTPError && await isUnsupportedApiError(error.response)) {
        consola.info(`Model ${payload.model} does not support /v1/messages, falling back to /chat/completions`)
        recordProbeResult(payload.model, 'anthropic-messages')
        try {
          return await handleViaChatCompletions(c, payload, signal)
        }
        catch (fallbackError) {
          if (fallbackError instanceof Error && fallbackError.name === 'AbortError')
            return c.body(null)
          // CC also unsupported — try native /responses as last resort
          if (fallbackError instanceof HTTPError && await isUnsupportedApiError(fallbackError.response)) {
            consola.info(`Model ${payload.model} does not support /chat/completions either, falling back to /responses`)
            recordProbeResult(payload.model, 'chat-completions')
            try {
              return await handleViaResponses(c, payload, signal)
            }
            catch (lastResortError) {
              if (lastResortError instanceof Error && lastResortError.name === 'AbortError')
                return c.body(null)
              throw lastResortError
            }
          }
          throw fallbackError
        }
      }
      throw error
    }
  }

  // Try responses first; if unsupported, fall back to chat-completions
  return await handleViaResponsesWithChatFallback(c, payload, signal)
}

async function handleViaResponsesWithChatFallback(
  c: Context,
  payload: ResponsesPayload,
  signal: AbortSignal,
  reason?: string,
) {
  if (isApiProbedUnsupported(payload.model, 'responses')) {
    consola.debug(`Skipping /responses for ${payload.model} due to cached unsupported probe${reason ? ` (${reason})` : ''}`)
    return await handleViaChatCompletions(c, payload, signal)
  }

  if (reason) {
    consola.debug(`Skipping Anthropic path for ${payload.model} due to ${reason}, using /responses instead`)
  }

  try {
    return await handleViaResponses(c, payload, signal)
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return c.body(null)
    if (error instanceof HTTPError && await isUnsupportedApiError(error.response)) {
      consola.info(`Model ${payload.model} does not support /responses, falling back to /chat/completions`)
      recordProbeResult(payload.model, 'responses')
      try {
        return await handleViaChatCompletions(c, payload, signal)
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

/** Direct path: model supports responses API */
async function handleViaResponses(c: Context, payload: ResponsesPayload, signal: AbortSignal) {
  const result = await createResponses(payload, { signal })

  if (isResponsesNonStreaming(result.body)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming responses:', JSON.stringify(result.body))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(result.body)
  }

  consola.debug('Streaming responses')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of streamBody) {
        if (stream.aborted)
          break
        if (consola.level >= 4) {
          consola.debug('Responses streaming chunk:', JSON.stringify(chunk))
        }
        await stream.writeSSE(chunk as SSEMessage)
      }
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return
      throw error
    }
  })
}

/** Translation path: model only supports chat-completions, translate Responses ↔ CC */
async function handleViaChatCompletions(c: Context, payload: ResponsesPayload, signal: AbortSignal) {
  const ccPayload = translateResponsesRequestToCC(payload)
  if (consola.level >= 4) {
    consola.debug('Translated Responses→CC payload:', JSON.stringify(ccPayload).slice(-400))
  }

  const result = await createChatCompletions(ccPayload, { signal })

  if (isCCNonStreaming(result.body)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming CC response (translated):', JSON.stringify(result.body))
    }
    const responsesResponse = translateCCResponseToResponses(result.body)
    forwardUpstreamHeaders(c, result.headers)
    return c.json(responsesResponse)
  }

  // Streaming translation (CC chunks → Responses stream events)
  consola.debug('Streaming CC response (translated to Responses events)')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    const streamState = createCCToResponsesStreamState()

    try {
      for await (const rawEvent of streamBody) {
        if (stream.aborted)
          break
        if (rawEvent.data === '[DONE]')
          break
        if (!rawEvent.data)
          continue

        let chunk
        try {
          chunk = JSON.parse(rawEvent.data)
        }
        catch {
          consola.error('Failed to parse CC stream chunk:', rawEvent.data)
          continue
        }

        const responsesEvents = translateCCStreamChunkToResponses(chunk, streamState)
        for (const evt of responsesEvents) {
          await stream.writeSSE({
            event: evt.type,
            data: JSON.stringify(evt),
          })
        }
      }
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return
      throw error
    }
  })
}

/** Check if a Responses payload contains external (non-data:) image URLs */
function payloadHasExternalImageUrls(payload: ResponsesPayload): boolean {
  if (typeof payload.input === 'string' || !Array.isArray(payload.input))
    return false

  for (const item of payload.input) {
    if (!('content' in item) || !Array.isArray(item.content))
      continue
    for (const part of item.content) {
      if (part.type === 'input_image' || part.type === 'image_url') {
        const url = typeof part.image_url === 'string'
          ? part.image_url
          : (part.image_url as Record<string, unknown>)?.url as string | undefined
        if (url && !url.startsWith('data:'))
          return true
      }
    }
  }
  return false
}

function getAnthropicResponsesBypassReason(_payload: ResponsesPayload): string | undefined {
  return undefined
}

function getAnthropicChatCompletionsBypassReason(payload: ResponsesPayload): string | undefined {
  if (payload.text?.format?.type === 'json_object') {
    return 'json_object structured output'
  }

  if (payloadHasExternalImageUrls(payload)) {
    return 'external image URLs'
  }

  return undefined
}

function payloadHasInputFileParts(payload: ResponsesPayload): boolean {
  if (typeof payload.input === 'string' || !Array.isArray(payload.input))
    return false

  for (const item of payload.input) {
    if ('type' in item && item.type === 'input_file') {
      return true
    }

    if (!('content' in item) || !Array.isArray(item.content))
      continue

    for (const part of item.content) {
      if (part.type === 'input_file') {
        return true
      }
    }
  }

  return false
}

function getAnthropicTranslationRejectionReason(payload: ResponsesPayload): string | undefined {
  if (payloadHasInputFileParts(payload)) {
    return 'input_file is not supported when routing this model through native Anthropic translation. Use a model that supports /responses directly, or provide content that can be represented as translated text/image blocks.'
  }

  return undefined
}

function throwInvalidResponsesRequest(message: string): never {
  throw new JSONResponseError(message, 400, {
    error: {
      message,
      type: 'invalid_request_error',
    },
  })
}

async function handleViaOpenAICompatibleBackends(
  c: Context,
  payload: ResponsesPayload,
  signal: AbortSignal,
  reason: string,
) {
  const ccUnsupported = isApiProbedUnsupported(payload.model, 'chat-completions')
  const responsesUnsupported = isApiProbedUnsupported(payload.model, 'responses')
  if (ccUnsupported && responsesUnsupported) {
    throwInvalidResponsesRequest(
      `Model ${payload.model} does not support /chat/completions or /responses for ${reason}.`,
    )
  }

  if (ccUnsupported) {
    consola.debug(`Skipping /chat/completions for ${payload.model} due to cached unsupported probe; using /responses for ${reason}`)
    try {
      return await handleViaResponses(c, payload, signal)
    }
    catch (fallbackError) {
      if (fallbackError instanceof Error && fallbackError.name === 'AbortError')
        return c.body(null)
      if (fallbackError instanceof HTTPError && await isUnsupportedApiError(fallbackError.response)) {
        recordProbeResult(payload.model, 'responses')
        throwInvalidResponsesRequest(
          `Model ${payload.model} does not support /chat/completions or /responses for ${reason}.`,
        )
      }
      throw fallbackError
    }
  }

  consola.debug(`Skipping Anthropic path for ${payload.model} due to ${reason}, using CC instead`)

  try {
    return await handleViaChatCompletions(c, payload, signal)
  }
  catch (fallbackError) {
    if (fallbackError instanceof Error && fallbackError.name === 'AbortError')
      return c.body(null)
    if (fallbackError instanceof HTTPError && await isUnsupportedApiError(fallbackError.response)) {
      consola.info(`Model ${payload.model} does not support /chat/completions for ${reason}, falling back to /responses`)
      recordProbeResult(payload.model, 'chat-completions')
      if (isApiProbedUnsupported(payload.model, 'responses')) {
        throwInvalidResponsesRequest(
          `Model ${payload.model} does not support /chat/completions or /responses for ${reason}.`,
        )
      }
      try {
        return await handleViaResponses(c, payload, signal)
      }
      catch (lastResortError) {
        if (lastResortError instanceof Error && lastResortError.name === 'AbortError')
          return c.body(null)
        if (lastResortError instanceof HTTPError && await isUnsupportedApiError(lastResortError.response)) {
          recordProbeResult(payload.model, 'responses')
          throwInvalidResponsesRequest(
            `Model ${payload.model} does not support /chat/completions or /responses for ${reason}.`,
          )
        }
        throw lastResortError
      }
    }
    throw fallbackError
  }
}

function isResponsesNonStreaming(body: Awaited<ReturnType<typeof createResponses>>['body']): body is ResponsesResponse {
  return Object.hasOwn(body, 'output')
}

function isCCNonStreaming(body: Awaited<ReturnType<typeof createChatCompletions>>['body']): body is ChatCompletionResponse {
  return Object.hasOwn(body, 'choices')
}

/** Translation path: model supports Anthropic Messages API, translate Responses ↔ Anthropic */
async function handleViaAnthropic(c: Context, payload: ResponsesPayload, signal: AbortSignal) {
  // Backfill/clamp max_output_tokens (Anthropic API requires max_tokens)
  if (payload.max_output_tokens == null) {
    payload.max_output_tokens = findModelMaxOutputTokens(payload.model, state.models) ?? 16384
  }
  else {
    const modelMax = findModelMaxOutputTokens(payload.model, state.models)
    if (modelMax && payload.max_output_tokens > modelMax) {
      consola.debug(`Clamping max_output_tokens from ${payload.max_output_tokens} to ${modelMax} for ${payload.model}`)
      payload.max_output_tokens = modelMax
    }
  }

  const anthropicPayload = translateResponsesRequestToAnthropic(payload)
  if (consola.level >= 4) {
    consola.debug('Translated Responses→Anthropic payload:', JSON.stringify(anthropicPayload).slice(-400))
  }

  const result = await createAnthropicMessages(anthropicPayload, { signal })

  // Non-streaming
  if (!result.streaming) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming Anthropic response (translated):', JSON.stringify(result.body))
    }
    const responsesResponse = translateAnthropicResponseToResponses(result.body)
    forwardUpstreamHeaders(c, result.headers)
    return c.json(responsesResponse)
  }

  // Streaming: Anthropic SSE → Responses SSE
  consola.debug('Streaming Anthropic response (translated to Responses events)')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    const streamState = createAnthropicToResponsesStreamState()

    try {
      for await (const rawEvent of streamBody) {
        if (stream.aborted)
          break
        if (!rawEvent.data)
          continue

        let parsed: AnthropicStreamEventData
        try {
          parsed = JSON.parse(rawEvent.data)
        }
        catch {
          consola.error('Failed to parse Anthropic stream event:', rawEvent.data)
          continue
        }

        const responsesEvents = translateAnthropicStreamEventToResponses(parsed, streamState)
        for (const evt of responsesEvents) {
          await stream.writeSSE({
            event: evt.type,
            data: JSON.stringify(evt),
          })
        }
      }
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return
      throw error
    }
  })
}
