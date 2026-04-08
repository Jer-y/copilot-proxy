import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { ChatCompletionResponse, ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import type { ResponsesResponse, ResponsesStreamEvent } from '~/services/copilot/create-responses'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { isUnsupportedApiError, recordProbeResult } from '~/lib/api-probe'
import { awaitApproval } from '~/lib/approval'
import { HTTPError, JSONResponseError } from '~/lib/error'
import { resolveBackend } from '~/lib/model-config'
import { checkRateLimit } from '~/lib/rate-limit'
import { ChatCompletionsPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { createResponsesToCCStreamState, translateCCRequestToResponses, translateResponsesResponseToCC, translateResponsesStreamEventToCC } from '~/lib/translation'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { isNullish } from '~/lib/utils'
import { validateBody } from '~/lib/validate'
import {
  createChatCompletions,
} from '~/services/copilot/create-chat-completions'
import { createResponses } from '~/services/copilot/create-responses'

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await validateBody<ChatCompletionsPayload>(c, ChatCompletionsPayloadSchema)
  if (consola.level >= 4) {
    consola.debug('Request payload:', JSON.stringify(payload).slice(-400))
  }

  // Find the selected model
  const selectedModel = state.models?.data.find(
    model => model.id === payload.model,
  )

  // Calculate and display token count
  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info('Current token count:', tokenCount)
    }
    else {
      consola.warn('No model selected, skipping token count calculation')
    }
  }
  catch (error) {
    consola.warn('Failed to calculate token count:', error)
  }

  if (state.manualApprove)
    await awaitApproval()

  if (isNullish(payload.max_tokens)) {
    payload = {
      ...payload,
      max_tokens: selectedModel?.capabilities.limits.max_output_tokens,
    }
    if (consola.level >= 4) {
      consola.debug('Set max_tokens to:', JSON.stringify(payload.max_tokens))
    }
  }

  const signal = c.req.raw.signal

  // Resolve which backend API to use
  const backend = resolveBackend(payload.model, 'chat-completions')

  if (backend === 'responses') {
    try {
      return await handleViaResponses(c, payload, signal)
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return c.body(null)
      throw error
    }
  }

  // Try chat-completions first; if unsupported, fall back to responses
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

/** Direct path: model supports chat-completions */
async function handleViaChatCompletions(c: Context, payload: ChatCompletionsPayload, signal: AbortSignal) {
  const result = await createChatCompletions(payload, { signal })

  if (isCCNonStreaming(result.body)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming response:', JSON.stringify(result.body))
    }
    forwardUpstreamHeaders(c, result.headers)
    return c.json(result.body)
  }

  consola.debug('Streaming response')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    try {
      for await (const chunk of streamBody) {
        if (stream.aborted)
          break
        if (consola.level >= 4) {
          consola.debug('Streaming chunk:', JSON.stringify(chunk))
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

/** Translation path: model only supports responses API, translate CC ↔ Responses */
async function handleViaResponses(c: Context, payload: ChatCompletionsPayload, signal: AbortSignal) {
  const responsesPayload = translateCCRequestToResponses(payload)
  if (consola.level >= 4) {
    consola.debug('Translated CC→Responses payload:', JSON.stringify(responsesPayload).slice(-400))
  }

  const result = await createResponses(responsesPayload, { signal })

  if (isResponsesNonStreaming(result.body)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming responses (translated):', JSON.stringify(result.body))
    }
    const ccResponse = translateResponsesResponseToCC(result.body)
    forwardUpstreamHeaders(c, result.headers)
    return c.json(ccResponse)
  }

  // TODO: Phase 3 — streaming translation (Responses stream → CC chunks)
  consola.debug('Streaming responses (translated to CC chunks)')
  forwardUpstreamHeaders(c, result.headers)
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    const streamState = createResponsesToCCStreamState()

    try {
      for await (const rawEvent of streamBody) {
        if (stream.aborted)
          break
        if (rawEvent.data === '[DONE]')
          break
        if (!rawEvent.data)
          continue

        let event: ResponsesStreamEvent
        try {
          event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
        }
        catch {
          consola.error('Failed to parse Responses stream event:', rawEvent.data)
          await stream.writeSSE({
            data: JSON.stringify({
              error: {
                message: 'Failed to parse Responses stream event.',
                type: 'api_error',
              },
            }),
          })
          return
        }

        let ccChunks
        try {
          ccChunks = translateResponsesStreamEventToCC(event, streamState)
        }
        catch (error) {
          if (error instanceof JSONResponseError) {
            await stream.writeSSE({
              data: JSON.stringify(error.payload),
            })
            return
          }
          throw error
        }

        for (const chunk of ccChunks) {
          await stream.writeSSE({
            data: JSON.stringify(chunk),
          })
        }
      }

      await stream.writeSSE({ data: '[DONE]' })
    }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError')
        return
      throw error
    }
  })
}

function isCCNonStreaming(body: Awaited<ReturnType<typeof createChatCompletions>>['body']): body is ChatCompletionResponse {
  return Object.hasOwn(body, 'choices')
}

function isResponsesNonStreaming(body: Awaited<ReturnType<typeof createResponses>>['body']): body is ResponsesResponse {
  return Object.hasOwn(body, 'output')
}
