import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AnthropicStreamEventData } from '~/lib/translation/types'
import type { ChatCompletionResponse } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload, ResponsesResponse } from '~/services/copilot/create-responses'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { awaitApproval } from '~/lib/approval'
import { runBackendPlan } from '~/lib/backend-plan'
import { JSONResponseError } from '~/lib/error'
import { findModelMaxOutputTokens } from '~/lib/model-utils'
import {
  OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE,
  responsesHasExternalImageUrls,
  throwOpenAIInvalidRequestError,
} from '~/lib/openai-compat'
import { checkRateLimit } from '~/lib/rate-limit'
import { planResponsesBackends } from '~/lib/routing-policy'
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
import { createResponses, forwardResponsesEndpoint, summarizeResponsesPayload } from '~/services/copilot/create-responses'

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await validateBody<ResponsesPayload>(c, ResponsesPayloadSchema)
  consola.debug('Responses API request summary:', {
    ...summarizeResponsesPayload(payload),
    contentLength: c.req.header('content-length') ?? undefined,
  })

  if (responsesHasExternalImageUrls(payload)) {
    throwOpenAIInvalidRequestError(OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE)
  }

  if (state.manualApprove) {
    await awaitApproval()
  }

  const routingPolicy = planResponsesBackends(payload.model, payload)

  if (routingPolicy.localError) {
    throwInvalidResponsesRequest(routingPolicy.localError)
  }

  if (
    routingPolicy.resolvedBackend === 'anthropic-messages'
    && routingPolicy.steps[0]?.api !== 'anthropic-messages'
    && routingPolicy.steps[0]?.context
  ) {
    consola.debug(`Skipping Anthropic path for ${payload.model} due to ${routingPolicy.steps[0].context}`)
  }

  const steps = routingPolicy.steps.map(step => ({
    ...step,
    run: async () => {
      switch (step.api) {
        case 'anthropic-messages':
          return await handleViaAnthropic(c, payload)
        case 'chat-completions':
          return await handleViaChatCompletions(c, payload)
        case 'responses':
          return await handleViaResponses(c, payload)
      }
    },
  }))

  try {
    return await runBackendPlan({
      model: payload.model,
      steps,
      onAllUnsupported: routingPolicy.exhaustedError
        ? () => {
            throwInvalidResponsesRequest(routingPolicy.exhaustedError!)
          }
        : undefined,
    })
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
  await checkRateLimit(state)

  if (state.manualApprove) {
    await awaitApproval()
  }

  const url = new URL(c.req.url)
  const body = method === 'GET' ? undefined : await c.req.text()
  const requestHeaders: Record<string, string> = {}
  const contentType = c.req.header('content-type')
  if (contentType && body !== undefined) {
    requestHeaders['Content-Type'] = contentType
  }

  const response = await forwardResponsesEndpoint(`${path}${url.search}`, {
    method,
    body,
    headers: requestHeaders,
    signal: c.req.raw.signal,
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

  return c.body(response.body, response.status as ContentfulStatusCode, responseHeaders)
}

/** Direct path: model supports responses API */
async function handleViaResponses(c: Context, payload: ResponsesPayload) {
  const result = await createResponses(payload)

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
async function handleViaChatCompletions(c: Context, payload: ResponsesPayload) {
  const ccPayload = translateResponsesRequestToCC(payload)
  if (consola.level >= 4) {
    consola.debug('Translated Responses→CC payload:', JSON.stringify(ccPayload).slice(-400))
  }

  const result = await createChatCompletions(ccPayload)

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

function throwInvalidResponsesRequest(message: string): never {
  throw new JSONResponseError(message, 400, {
    error: {
      message,
      type: 'invalid_request_error',
    },
  })
}

function isResponsesNonStreaming(body: Awaited<ReturnType<typeof createResponses>>['body']): body is ResponsesResponse {
  return Object.hasOwn(body, 'output')
}

function isCCNonStreaming(body: Awaited<ReturnType<typeof createChatCompletions>>['body']): body is ChatCompletionResponse {
  return Object.hasOwn(body, 'choices')
}

/** Translation path: model supports Anthropic Messages API, translate Responses ↔ Anthropic */
async function handleViaAnthropic(c: Context, payload: ResponsesPayload) {
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

  const result = await createAnthropicMessages(anthropicPayload)

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
