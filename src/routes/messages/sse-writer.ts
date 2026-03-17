import type { SSEStreamingApi } from 'hono/streaming'
import type { AnthropicStreamEventData } from './anthropic-types'

export const DEFAULT_ANTHROPIC_KEEPALIVE_INTERVAL_MS = 5000

type AnthropicSSEStream = Pick<SSEStreamingApi, 'writeSSE' | 'closed' | 'aborted'>

export function createAnthropicSSEWriter(
  stream: AnthropicSSEStream,
  options?: {
    keepAliveIntervalMs?: number
  },
) {
  const keepAliveIntervalMs = options?.keepAliveIntervalMs ?? DEFAULT_ANTHROPIC_KEEPALIVE_INTERVAL_MS
  let stopped = false
  let firstNonPingEventSent = false
  let writeChain = Promise.resolve()
  let keepAliveTimer: ReturnType<typeof setTimeout> | undefined

  const shouldStop = () => stopped || firstNonPingEventSent || stream.closed || stream.aborted

  const writeRawEvent = async (event: AnthropicStreamEventData) => {
    if (shouldStop() && event.type === 'ping') {
      return
    }

    if (stream.closed || stream.aborted) {
      return
    }

    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    })

    if (event.type !== 'ping') {
      firstNonPingEventSent = true
      if (keepAliveTimer) {
        clearTimeout(keepAliveTimer)
        keepAliveTimer = undefined
      }
    }
  }

  const enqueue = (event: AnthropicStreamEventData) => {
    writeChain = writeChain.then(() => writeRawEvent(event))
    return writeChain
  }

  const scheduleKeepAlive = () => {
    if (shouldStop() || keepAliveTimer) {
      return
    }

    keepAliveTimer = setTimeout(() => {
      keepAliveTimer = undefined
      void enqueue({ type: 'ping' }).finally(() => {
        scheduleKeepAlive()
      })
    }, keepAliveIntervalMs)
    keepAliveTimer.unref?.()
  }

  scheduleKeepAlive()

  return {
    writeEvent(event: AnthropicStreamEventData) {
      return enqueue(event)
    },
    async close() {
      stopped = true
      if (keepAliveTimer) {
        clearTimeout(keepAliveTimer)
        keepAliveTimer = undefined
      }
      await writeChain
    },
  }
}
