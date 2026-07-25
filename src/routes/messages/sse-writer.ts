import type { SSEStreamingApi } from 'hono/streaming'
import type { AnthropicStreamEventData } from '~/lib/translation/types'

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
  let writeChain = Promise.resolve()
  let keepAliveTimer: ReturnType<typeof setTimeout> | undefined

  const shouldStop = () => stopped || stream.closed || stream.aborted

  const clearKeepAliveTimer = () => {
    if (keepAliveTimer) {
      clearTimeout(keepAliveTimer)
      keepAliveTimer = undefined
    }
  }

  const scheduleKeepAlive = () => {
    clearKeepAliveTimer()
    if (shouldStop()) {
      return
    }

    // Keep downstream idle timers alive during long gaps between real upstream events.
    keepAliveTimer = setTimeout(() => {
      keepAliveTimer = undefined
      void enqueue({ type: 'ping' })
    }, keepAliveIntervalMs)
    keepAliveTimer.unref?.()
  }

  const writeRawEvent = async (event: AnthropicStreamEventData) => {
    if (shouldStop()) {
      return
    }

    await stream.writeSSE({
      event: event.type,
      data: JSON.stringify(event),
    })
    scheduleKeepAlive()
  }

  function enqueue(event: AnthropicStreamEventData) {
    writeChain = writeChain.then(() => writeRawEvent(event))
    return writeChain
  }

  scheduleKeepAlive()

  return {
    writeEvent(event: AnthropicStreamEventData) {
      return enqueue(event)
    },
    async close() {
      stopped = true
      clearKeepAliveTimer()
      await writeChain
    },
  }
}
