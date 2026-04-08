import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { ChatCompletionResponse } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload, ResponsesResponse } from '~/services/copilot/create-responses'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { isUnsupportedApiError, recordProbeResult } from '~/lib/api-probe'
import { awaitApproval } from '~/lib/approval'
import { HTTPError } from '~/lib/error'
import { resolveBackend } from '~/lib/model-config'
import { checkRateLimit } from '~/lib/rate-limit'
import { ResponsesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { createCCToResponsesStreamState, translateCCResponseToResponses, translateCCStreamChunkToResponses, translateResponsesRequestToCC } from '~/lib/translation'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { validateBody } from '~/lib/validate'
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

  // Try responses first; if unsupported, fall back to chat-completions
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

function isResponsesNonStreaming(body: Awaited<ReturnType<typeof createResponses>>['body']): body is ResponsesResponse {
  return Object.hasOwn(body, 'output')
}

function isCCNonStreaming(body: Awaited<ReturnType<typeof createChatCompletions>>['body']): body is ChatCompletionResponse {
  return Object.hasOwn(body, 'choices')
}
