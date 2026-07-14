import consola from 'consola'

interface StreamTimingOptions {
  endpoint: string
  onIteratorExit?: (reason?: unknown) => Promise<void> | void
  requestStartedAt: number
}

interface CopilotStreamEvent {
  data?: string | null
  event?: string
}

export function logUpstreamHeadersReceived(
  options: StreamTimingOptions & {
    status: number
    stream: boolean
  },
): void {
  consola.debug(`Upstream ${options.endpoint} headers received:`, {
    status: options.status,
    stream: options.stream,
    durationMs: Date.now() - options.requestStartedAt,
  })
}

export function logUpstreamRequestCompleted(options: StreamTimingOptions): void {
  consola.debug(`Upstream ${options.endpoint} request completed:`, {
    durationMs: Date.now() - options.requestStartedAt,
  })
}

export async function* instrumentCopilotEventStream<T extends CopilotStreamEvent>(
  source: AsyncIterable<T>,
  options: StreamTimingOptions,
): AsyncIterable<T> {
  let firstEventReceived = false
  let failed = false

  try {
    for await (const event of source) {
      if (!firstEventReceived) {
        firstEventReceived = true
        consola.debug(`Upstream ${options.endpoint} first SSE event:`, {
          durationMs: Date.now() - options.requestStartedAt,
          event: event.event ?? 'message',
          hasData: typeof event.data === 'string' ? event.data.length > 0 : event.data != null,
        })
      }

      yield event
    }
  }
  catch (error) {
    failed = true
    consola.debug(`Upstream ${options.endpoint} stream failed:`, {
      durationMs: Date.now() - options.requestStartedAt,
      firstEventReceived,
      error,
    })
    throw error
  }
  finally {
    try {
      await options.onIteratorExit?.('Copilot SSE iterator exited')
    }
    catch (error) {
      consola.debug(`Upstream ${options.endpoint} stream cleanup failed:`, {
        durationMs: Date.now() - options.requestStartedAt,
        error,
      })
    }
    if (!failed) {
      consola.debug(`Upstream ${options.endpoint} stream completed:`, {
        durationMs: Date.now() - options.requestStartedAt,
        firstEventReceived,
      })
    }
  }
}
