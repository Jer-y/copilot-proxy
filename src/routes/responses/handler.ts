import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AccountContext } from '~/lib/account/types'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { getAccountRegistry } from '~/lib/account/registry'
import { selectAccount, selectUnmodeledAccount } from '~/lib/account/router'
import { isAbortError, JSONResponseError } from '~/lib/error'
import {
  OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE,
  responsesHasExternalImageUrls,
  throwOpenAIInvalidRequestError,
} from '~/lib/openai-compat'
import { writeOpenAIStreamError } from '~/lib/openai-stream-error'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { resolveRoute } from '~/lib/routing-policy'
import { ResponsesPayloadSchema } from '~/lib/schemas'
import { getSetupProbeSignal } from '~/lib/setup-probe-context'
import { state } from '~/lib/state'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { readJsonBodyText, validateBody } from '~/lib/validate'
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

  if (payload.conversation != null) {
    throwInvalidResponsesRequest(
      'Responses conversation state is not supported by the current Copilot upstream. Send the complete conversation as input instead.',
      { code: 'unsupported_value', param: 'conversation' },
    )
  }

  const selection = selectAccount({
    registry: getAccountRegistry(),
    requestedModel: payload.model,
    headers: c.req.raw.headers,
    normalizeModel: normalizeAnthropicModelName,
  })
  const effectiveModel = selection.effectiveModel
  const selectedPayload = effectiveModel === payload.model
    ? payload
    : { ...payload, model: effectiveModel }
  resolveRoute('responses', effectiveModel, throwInvalidResponsesRequest, {
    models: selection.ctx.models?.data,
  })

  return await handleViaResponses(c, selectedPayload, selection.ctx)
}

export async function handleResponsesPassthrough(
  c: Context,
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  options: { modelInBody?: boolean } = {},
) {
  await enforceRateLimit(state)

  await enforceManualApproval(state)

  const url = new URL(c.req.url)
  let body = method === 'GET' ? undefined : await readJsonBodyText(c)
  const requestHeaders: Record<string, string> = {}
  const contentType = c.req.header('content-type')
  if (contentType && body !== undefined) {
    requestHeaders['Content-Type'] = contentType
  }

  let response: Response | undefined
  try {
    const forwarding = options.modelInBody && body !== undefined
      ? prepareModelRoutedPassthroughBody(body, c.req.raw.headers)
      : {
          body,
          ctx: selectUnmodeledAccount({
            registry: getAccountRegistry(),
            headers: c.req.raw.headers,
          }).ctx,
          model: undefined,
        }
    body = forwarding.body
    response = await forwardResponsesEndpoint(`${path}${url.search}`, {
      method,
      body,
      ctx: forwarding.ctx,
      headers: requestHeaders,
      model: forwarding.model,
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

function prepareModelRoutedPassthroughBody(
  body: string,
  headers: Headers,
): { body: string, ctx: AccountContext, model?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  }
  catch {
    throwInvalidResponsesRequest('Invalid JSON body')
  }

  if (!isRecord(parsed) || typeof parsed.model !== 'string' || parsed.model.length === 0) {
    return {
      body,
      ctx: selectUnmodeledAccount({
        registry: getAccountRegistry(),
        headers,
      }).ctx,
      model: undefined,
    }
  }

  const selection = selectAccount({
    registry: getAccountRegistry(),
    requestedModel: parsed.model,
    headers,
    normalizeModel: normalizeAnthropicModelName,
  })
  resolveRoute('responses', selection.effectiveModel, throwInvalidResponsesRequest, {
    models: selection.ctx.models?.data,
  })
  return {
    body: selection.effectiveModel === parsed.model
      ? body
      : JSON.stringify({ ...parsed, model: selection.effectiveModel }),
    ctx: selection.ctx,
    model: selection.effectiveModel,
  }
}

/** Direct path: model supports responses API */
async function handleViaResponses(
  c: Context,
  payload: ResponsesPayload,
  ctx: AccountContext,
) {
  const setupSignal = getSetupProbeSignal(c)
  const result = await createResponses(payload, { ctx, ...(setupSignal && { signal: setupSignal }) })

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
      if (terminalSeen && isAbortError(error)) {
        completed = !stream.aborted
        return
      }
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

function throwInvalidResponsesRequest(
  message: string,
  details: { code?: string, param?: string | null } = {},
): never {
  throw new JSONResponseError(message, 400, {
    error: {
      message,
      type: 'invalid_request_error',
      ...(details.code !== undefined && { code: details.code }),
      ...(details.param !== undefined && { param: details.param }),
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isResponsesStreamBody(
  body: Awaited<ReturnType<typeof createResponses>>['body'],
): body is ResponsesStreamBody {
  return typeof (body as { [Symbol.asyncIterator]?: unknown })?.[Symbol.asyncIterator] === 'function'
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
