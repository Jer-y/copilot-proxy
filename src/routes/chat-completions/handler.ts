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

  // Resolve which backend API to use
  const backend = resolveBackend(payload.model, 'chat-completions')

  if (backend === 'responses') {
    return handleViaResponses(c, payload)
  }

  // Try chat-completions first; if unsupported, fall back to responses
  try {
    return await handleViaChatCompletions(c, payload)
  }
  catch (error) {
    if (error instanceof HTTPError && await isUnsupportedApiError(error.response)) {
      consola.info(`Model ${payload.model} does not support /chat/completions, falling back to /responses`)
      recordProbeResult(payload.model, 'chat-completions')
      return handleViaResponses(c, payload)
    }
    throw error
  }
}

/** Direct path: model supports chat-completions */
async function handleViaChatCompletions(c: Context, payload: ChatCompletionsPayload) {
  const response = await createChatCompletions(payload)

  if (isCCNonStreaming(response)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming response:', JSON.stringify(response))
    }
    return c.json(response)
  }

  consola.debug('Streaming response')
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      if (consola.level >= 4) {
        consola.debug('Streaming chunk:', JSON.stringify(chunk))
      }
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

/** Translation path: model only supports responses API, translate CC ↔ Responses */
async function handleViaResponses(c: Context, payload: ChatCompletionsPayload) {
  const responsesPayload = translateCCRequestToResponses(payload)
  if (consola.level >= 4) {
    consola.debug('Translated CC→Responses payload:', JSON.stringify(responsesPayload).slice(-400))
  }

  const response = await createResponses(responsesPayload)

  if (isResponsesNonStreaming(response)) {
    if (consola.level >= 4) {
      consola.debug('Non-streaming responses (translated):', JSON.stringify(response))
    }
    const ccResponse = translateResponsesResponseToCC(response)
    return c.json(ccResponse)
  }

  // TODO: Phase 3 — streaming translation (Responses stream → CC chunks)
  consola.debug('Streaming responses (translated to CC chunks)')
  return streamSSE(c, async (stream) => {
    const streamState = createResponsesToCCStreamState()

    for await (const rawEvent of response) {
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
  })
}

function isCCNonStreaming(response: Awaited<ReturnType<typeof createChatCompletions>>): response is ChatCompletionResponse {
  return Object.hasOwn(response, 'choices')
}

function isResponsesNonStreaming(response: Awaited<ReturnType<typeof createResponses>>): response is ResponsesResponse {
  return Object.hasOwn(response, 'output')
}
