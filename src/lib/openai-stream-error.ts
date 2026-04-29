import type { SSEStreamingApi } from 'hono/streaming'

import consola from 'consola'

type OpenAISSEStream = Pick<SSEStreamingApi, 'aborted' | 'closed' | 'writeSSE'>

interface OpenAIStreamError {
  type: 'error'
  error: {
    message: string
    type: 'server_error'
    code: 'stream_error'
  }
}

export async function writeOpenAIStreamError(
  stream: OpenAISSEStream,
  error: unknown,
  options: {
    fallbackMessage: string
    label: string
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
    data: JSON.stringify(createOpenAIStreamError(error, options.fallbackMessage)),
  })
}

function createOpenAIStreamError(error: unknown, fallbackMessage: string): OpenAIStreamError {
  return {
    type: 'error',
    error: {
      message: error instanceof Error ? error.message : fallbackMessage,
      type: 'server_error',
      code: 'stream_error',
    },
  }
}
