import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AnthropicStreamEventData } from '~/lib/translation/types'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { JSONResponseError } from '~/lib/error'
import { findModelMaxOutputTokens } from '~/lib/model-utils'
import {
  OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE,
  responsesHasExternalImageUrls,
  throwOpenAIInvalidRequestError,
} from '~/lib/openai-compat'
import { writeOpenAIStreamError } from '~/lib/openai-stream-error'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { assertResponsesPayloadTranslatable, resolveRoute } from '~/lib/routing-policy'
import { ResponsesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import {
  createAnthropicToResponsesStreamState,
  finalizeAnthropicToResponsesStreamState,
  translateAnthropicResponseToResponses,
  translateAnthropicStreamEventToResponses,
} from '~/lib/translation'
import { translateResponsesRequestToAnthropic } from '~/lib/translation/responses-to-anthropic'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { readJsonBodyText, validateBody } from '~/lib/validate'
import { createAnthropicMessages } from '~/services/copilot/create-anthropic-messages'
import { createResponses, forwardResponsesEndpoint, summarizeResponsesPayload } from '~/services/copilot/create-responses'
import { normalizeAnthropicModelName } from '../messages/model-normalization'

type ResponsesStreamBody = Extract<
  Awaited<ReturnType<typeof createResponses>>['body'],
  AsyncIterable<unknown>
>

export async function handleResponses(c: Context) {
  await enforceRateLimit(state)

  const payload = await validateBody<ResponsesPayload>(c, ResponsesPayloadSchema)
  consola.debug('Responses API request summary:', {
    ...summarizeResponsesPayload(payload),
    contentLength: c.req.header('content-length') ?? undefined,
  })

  if (responsesHasExternalImageUrls(payload)) {
    throwOpenAIInvalidRequestError(OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE)
  }

  await enforceManualApproval(state)

  const requestedModel = payload.model
  const effectiveModel = normalizeAnthropicModelName(requestedModel)
  const route = resolveRoute('responses', effectiveModel, throwInvalidResponsesRequest, {
    models: state.models?.data,
  })

  try {
    switch (route.backend) {
      case 'responses':
        return await handleViaResponses(c, payload)
      case 'anthropic-messages':
        assertResponsesPayloadTranslatable(payload, throwInvalidResponsesRequest)
        return await handleViaAnthropic(c, payload, effectiveModel, requestedModel)
      case 'chat-completions':
        // Unreachable: resolveRoute() never returns chat-completions for a Responses client.
        throwInvalidResponsesRequest(
          `Model ${payload.model} cannot be served via /responses (would require translating to /chat/completions, which is disallowed).`,
        )
    }
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return c.body(null)
    throw error
  }
}

export async function handleResponsesPassthrough(
  c: Context,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
) {
  await enforceRateLimit(state)

  await enforceManualApproval(state)

  const url = new URL(c.req.url)
  const body = method === 'GET' ? undefined : await readJsonBodyText(c)
  const requestHeaders: Record<string, string> = {}
  const contentType = c.req.header('content-type')
  if (contentType && body !== undefined) {
    requestHeaders['Content-Type'] = contentType
  }

  let response: Response | undefined
  try {
    response = await forwardResponsesEndpoint(`${path}${url.search}`, {
      method,
      body,
      headers: requestHeaders,
    })

    forwardUpstreamHeaders(c, response.headers)
    const responseHeaders: Record<string, string> = {}
    const responseContentType = response.headers.get('content-type')
    if (responseContentType) {
      responseHeaders['content-type'] = responseContentType
    }
    const requestId = response.headers.get('x-request-id')
    if (requestId) {
      responseHeaders['x-request-id'] = requestId
    }

    return c.body(response.body as ReadableStream, response.status as ContentfulStatusCode, responseHeaders)
  }
  catch (error) {
    await response?.body?.cancel(error).catch(() => {})
    throw error
  }
}

/** Direct path: model supports responses API */
async function handleViaResponses(c: Context, payload: ResponsesPayload) {
  const result = await createResponses(payload)

  if (!isResponsesStreamBody(result.body)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming Responses response summary:', summarizeResponsesResponse(result.body))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(result.body as never)
  }

  consola.debug('Streaming responses')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    let completed = false
    let terminalSeen = false
    let nextSequenceNumber = 0
    stream.onAbort(() => result.cancel?.('responses client disconnected before upstream stream completed'))
    try {
      for await (const chunk of streamBody) {
        if (stream.aborted)
          break
        if (consola.level >= 4) {
          consola.debug('Responses streaming chunk summary:', summarizeSSEMessage(chunk as SSEMessage))
        }
        const message = chunk as SSEMessage
        nextSequenceNumber = getNextResponsesSequenceNumber(message, nextSequenceNumber)
        terminalSeen ||= isTerminalResponsesSSEMessage(message)
        await stream.writeSSE(message)
      }
      if (!stream.aborted && !terminalSeen) {
        throw new Error('Copilot Responses stream terminated before a terminal response event.')
      }
      completed = terminalSeen && !stream.aborted
    }
    catch (error) {
      await writeOpenAIStreamError(stream, error, {
        fallbackMessage: 'An unexpected error occurred while streaming the Copilot Responses response.',
        label: 'Responses stream passthrough',
        responsesSequenceNumber: nextSequenceNumber,
      })
    }
    finally {
      if (!completed) {
        await result.cancel?.('responses client disconnected before upstream stream completed')
      }
    }
  })
}

function throwInvalidResponsesRequest(message: string): never {
  throw new JSONResponseError(message, 400, {
    error: {
      message,
      type: 'invalid_request_error',
    },
  })
}

function isResponsesStreamBody(
  body: Awaited<ReturnType<typeof createResponses>>['body'],
): body is ResponsesStreamBody {
  return typeof (body as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === 'function'
}

/** Translation path: model supports Anthropic Messages API, translate Responses ↔ Anthropic */
async function handleViaAnthropic(
  c: Context,
  payload: ResponsesPayload,
  effectiveModel: string,
  requestedModel: string,
) {
  // Backfill/clamp max_output_tokens (Anthropic API requires max_tokens)
  if (payload.max_output_tokens == null) {
    payload.max_output_tokens = findModelMaxOutputTokens(effectiveModel, state.models) ?? 16384
  }
  else {
    const modelMax = findModelMaxOutputTokens(effectiveModel, state.models)
    if (modelMax && payload.max_output_tokens > modelMax) {
      consola.debug(`Clamping max_output_tokens from ${payload.max_output_tokens} to ${modelMax} for ${effectiveModel}`)
      payload.max_output_tokens = modelMax
    }
  }

  const anthropicPayload = translateResponsesRequestToAnthropic(payload, { model: effectiveModel })
  if (consola.level >= 4) {
    consola.debug('Translated Responses→Anthropic payload summary:', summarizeAnthropicPayload(anthropicPayload))
  }

  const result = await createAnthropicMessages(anthropicPayload)

  // Non-streaming
  if (!result.streaming) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming Anthropic response summary:', summarizeAnthropicResponse(result.body))
    }
    const responsesResponse = translateAnthropicResponseToResponses(result.body, { requestedModel })
    forwardUpstreamHeaders(c, result.headers)
    return c.json(responsesResponse)
  }

  // Streaming: Anthropic SSE → Responses SSE
  consola.debug('Streaming Anthropic response (translated to Responses events)')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    const streamState = createAnthropicToResponsesStreamState({ requestedModel })
    let completed = false
    let translationFailed = false
    stream.onAbort(() => result.cancel?.('responses client disconnected before translated Anthropic stream completed'))

    try {
      for await (const rawEvent of streamBody) {
        if (stream.aborted)
          break
        if (rawEvent.data === '[DONE]')
          break
        if (!rawEvent.data)
          continue

        let parsed: AnthropicStreamEventData
        try {
          parsed = JSON.parse(rawEvent.data)
        }
        catch {
          consola.error('Failed to parse Anthropic stream event:', {
            event: rawEvent.event ?? 'message',
            dataChars: rawEvent.data.length,
          })
          const failureEvents = translateAnthropicStreamEventToResponses({
            type: 'error',
            error: {
              type: 'api_error',
              message: 'Failed to parse a streaming event from the Copilot Anthropic upstream response.',
            },
          }, streamState)
          for (const evt of failureEvents) {
            await stream.writeSSE({
              event: evt.type,
              data: JSON.stringify(evt),
            })
          }
          await result.cancel?.('malformed Anthropic upstream stream event').catch(() => {})
          translationFailed = true
          break
        }

        const responsesEvents = translateAnthropicStreamEventToResponses(parsed, streamState)
        for (const evt of responsesEvents) {
          await stream.writeSSE({
            event: evt.type,
            data: JSON.stringify(evt),
          })
        }
        if (parsed.type === 'error') {
          await result.cancel?.('Anthropic upstream stream emitted an error event').catch(() => {})
          translationFailed = true
          break
        }
      }
      if (!stream.aborted && !translationFailed) {
        const finalEvents = finalizeAnthropicToResponsesStreamState(streamState)
        for (const evt of finalEvents) {
          await stream.writeSSE({
            event: evt.type,
            data: JSON.stringify(evt),
          })
        }
      }
      completed = !stream.aborted
    }
    catch (error) {
      await writeOpenAIStreamError(stream, error, {
        fallbackMessage: 'An unexpected error occurred while translating the Copilot Anthropic stream.',
        label: 'Anthropic to Responses stream translation',
        responsesSequenceNumber: streamState.nextSequenceNumber,
      })
    }
    finally {
      if (!completed) {
        await result.cancel?.('responses client disconnected before translated Anthropic stream completed')
      }
    }
  })
}

function summarizeResponsesResponse(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') {
    return { kind: typeof body }
  }

  const response = body as Record<string, unknown>
  return {
    type: typeof response.object === 'string' ? response.object : typeof response.type === 'string' ? response.type : 'unknown',
    status: typeof response.status === 'string' ? response.status : undefined,
    model: typeof response.model === 'string' ? response.model : undefined,
    outputItems: Array.isArray(response.output) ? response.output.length : undefined,
    hasError: response.error != null,
  }
}

function summarizeSSEMessage(message: SSEMessage): Record<string, unknown> {
  return {
    event: message.event ?? 'message',
    dataChars: typeof message.data === 'string' ? message.data.length : 0,
  }
}

function isTerminalResponsesSSEMessage(message: SSEMessage): boolean {
  const terminalTypes = new Set([
    'error',
    'response.completed',
    'response.failed',
    'response.incomplete',
  ])
  if (message.event && terminalTypes.has(message.event))
    return true

  if (typeof message.data !== 'string' || message.data === '[DONE]')
    return message.data === '[DONE]'

  try {
    const payload = JSON.parse(message.data) as { type?: unknown }
    return typeof payload.type === 'string' && terminalTypes.has(payload.type)
  }
  catch {
    return false
  }
}

function getNextResponsesSequenceNumber(message: SSEMessage, current: number): number {
  if (typeof message.data !== 'string' || message.data === '[DONE]') {
    return current
  }

  try {
    const payload = JSON.parse(message.data) as { sequence_number?: unknown }
    return typeof payload.sequence_number === 'number'
      && Number.isSafeInteger(payload.sequence_number)
      && payload.sequence_number >= current
      ? payload.sequence_number + 1
      : current
  }
  catch {
    return current
  }
}

function summarizeAnthropicPayload(
  payload: ReturnType<typeof translateResponsesRequestToAnthropic>,
): Record<string, unknown> {
  return {
    model: payload.model,
    stream: Boolean(payload.stream),
    messages: payload.messages.length,
    systemChars: typeof payload.system === 'string'
      ? payload.system.length
      : Array.isArray(payload.system)
        ? payload.system.reduce((sum, block) => sum + block.text.length, 0)
        : 0,
    tools: payload.tools?.length ?? 0,
    maxTokens: payload.max_tokens,
    thinkingType: payload.thinking?.type,
    outputFormatType: payload.output_config?.format?.type,
  }
}

function summarizeAnthropicResponse(body: { model?: string, content?: Array<unknown>, stop_reason?: string | null }): Record<string, unknown> {
  return {
    model: body.model,
    contentBlocks: body.content?.length ?? 0,
    stopReason: body.stop_reason,
  }
}
