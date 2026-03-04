import type { Context } from 'hono'

import type { AnthropicMessagesPayload, AnthropicStreamState } from './anthropic-types'
import type { ChatCompletionChunk, ChatCompletionResponse } from '~/services/copilot/create-chat-completions'

import consola from 'consola'
import { streamSSE } from 'hono/streaming'
import { awaitApproval } from '~/lib/approval'
import { checkRateLimit } from '~/lib/rate-limit'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'

import { state } from '~/lib/state'
import { validateBody } from '~/lib/validate'
import {

  createChatCompletions,
} from '~/services/copilot/create-chat-completions'
import {
  translateToAnthropic,
  translateToOpenAI,
} from './non-stream-translation'
import { translateChunkToAnthropicEvents, translateErrorToAnthropicErrorEvent } from './stream-translation'

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const anthropicBeta = c.req.header('anthropic-beta')
  const anthropicPayload = await validateBody<AnthropicMessagesPayload>(c, AnthropicMessagesPayloadSchema)
  consola.debug('Anthropic request payload:', JSON.stringify(anthropicPayload))

  const openAIPayload = translateToOpenAI(anthropicPayload, { anthropicBeta })
  consola.debug(
    'Translated OpenAI request payload:',
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  if (isNonStreaming(response)) {
    consola.debug(
      'Non-streaming response from Copilot:',
      JSON.stringify(response).slice(-400),
    )
    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      'Translated Anthropic response:',
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug('Streaming response from Copilot')
  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug('Copilot raw stream event:', JSON.stringify(rawEvent))
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
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify(translateErrorToAnthropicErrorEvent()),
        })
        return
      }

      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug('Translated Anthropic event:', JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }
  })
}

function isNonStreaming(response: Awaited<ReturnType<typeof createChatCompletions>>): response is ChatCompletionResponse {
  return Object.hasOwn(response, 'choices')
}
