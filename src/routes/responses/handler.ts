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

  // Resolve which backend API to use
  const backend = resolveBackend(payload.model, 'responses')

  if (backend === 'chat-completions') {
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

  // Try responses first; if unsupported, fall back to chat-completions
  try {
    return await handleViaResponses(c, payload)
  }
  catch (error) {
    if (error instanceof HTTPError && await isUnsupportedApiError(error.response)) {
      consola.info(`Model ${payload.model} does not support /responses, falling back to /chat/completions`)
      recordProbeResult(payload.model, 'responses')
      return handleViaChatCompletions(c, payload)
    }
    throw error
  }
}

/** Direct path: model supports responses API */
async function handleViaResponses(c: Context, payload: ResponsesPayload) {
  const response = await createResponses(payload)

  if (isResponsesNonStreaming(response)) {
    consola.debug('Non-streaming responses:', JSON.stringify(response))
    return c.json(response)
  }

  consola.debug('Streaming responses')
  return streamSSE(c, async (stream) => {
    for await (const chunk of response) {
      consola.debug('Responses streaming chunk:', JSON.stringify(chunk))
      await stream.writeSSE(chunk as SSEMessage)
    }
  })
}

/** Translation path: model only supports chat-completions, translate Responses ↔ CC */
async function handleViaChatCompletions(c: Context, payload: ResponsesPayload) {
  const ccPayload = translateResponsesRequestToCC(payload)
  consola.debug('Translated Responses→CC payload:', JSON.stringify(ccPayload).slice(-400))

  const response = await createChatCompletions(ccPayload)

  if (isCCNonStreaming(response)) {
    consola.debug('Non-streaming CC response (translated):', JSON.stringify(response))
    const responsesResponse = translateCCResponseToResponses(response)
    return c.json(responsesResponse)
  }

  // Streaming translation (CC chunks → Responses stream events)
  consola.debug('Streaming CC response (translated to Responses events)')
  return streamSSE(c, async (stream) => {
    const streamState = createCCToResponsesStreamState()

    for await (const rawEvent of response) {
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
  })
}

function isResponsesNonStreaming(response: Awaited<ReturnType<typeof createResponses>>): response is ResponsesResponse {
  return Object.hasOwn(response, 'output')
}

function isCCNonStreaming(response: Awaited<ReturnType<typeof createChatCompletions>>): response is ChatCompletionResponse {
  return Object.hasOwn(response, 'choices')
}
