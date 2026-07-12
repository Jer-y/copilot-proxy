import type { SSEStreamingApi } from 'hono/streaming'

import consola from 'consola'

type OpenAISSEStream = Pick<SSEStreamingApi, 'aborted' | 'closed' | 'writeSSE'>

interface ChatCompatibleStreamError {
  type: 'error'
  error: {
    message: string
    type: 'server_error'
    code: 'stream_error'
  }
}

interface ResponsesStreamError {
  type: 'error'
  code: 'stream_error'
  message: string
  param: null
  sequence_number: number
}

export async function writeOpenAIStreamError(
  stream: OpenAISSEStream,
  error: unknown,
  options: {
    fallbackMessage: string
    label: string
    responsesSequenceNumber?: number
  },
): Promise<void> {
  if (error instanceof Error && error.name === 'AbortError') {
    return
  }

  consola.error(`${options.label} failed:`, error)

  if (stream.aborted || stream.closed) {
    return
  }

  await stream.writeSSE({
    event: 'error',
    data: JSON.stringify(createOpenAIStreamError(
      error,
      options.fallbackMessage,
      options.responsesSequenceNumber,
    )),
  })

  // Chat Completions uses the legacy [DONE] sentinel. Responses streams are
  // terminated by their typed `error` event and must not add a non-schema
  // sentinel after the official terminal event.
  if (options.responsesSequenceNumber === undefined && !stream.aborted && !stream.closed) {
    await stream.writeSSE({
      data: '[DONE]',
    })
  }
}

function createOpenAIStreamError(
  error: unknown,
  fallbackMessage: string,
  responsesSequenceNumber?: number,
): ChatCompatibleStreamError | ResponsesStreamError {
  const message = error instanceof Error ? error.message : fallbackMessage
  if (responsesSequenceNumber !== undefined) {
    return {
      type: 'error',
      code: 'stream_error',
      message,
      param: null,
      sequence_number: responsesSequenceNumber,
    }
  }

  return {
    type: 'error',
    error: {
      message,
      type: 'server_error',
      code: 'stream_error',
    },
  }
}
