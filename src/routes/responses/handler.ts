import type { Context } from 'hono'

import type { SSEMessage } from 'hono/streaming'
import type { ResponsesPayload, ResponsesResponse } from '~/services/copilot/create-responses'
import consola from 'consola'

import { streamSSE } from 'hono/streaming'
import { awaitApproval } from '~/lib/approval'
import { checkRateLimit } from '~/lib/rate-limit'
import { state } from '~/lib/state'
import { createResponses } from '~/services/copilot/create-responses'

export async function handleResponses(c: Context) {
  await checkRateLimit(state)

  const payload = await c.req.json<ResponsesPayload>()
  consola.debug('Responses API request payload:', JSON.stringify(payload).slice(-400))

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createResponses(payload)

  if (isNonStreaming(response)) {
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

function isNonStreaming(response: Awaited<ReturnType<typeof createResponses>>): response is ResponsesResponse {
  return Object.hasOwn(response, 'output')
}
