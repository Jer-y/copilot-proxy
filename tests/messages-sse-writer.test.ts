import { afterEach, describe, expect, test } from 'bun:test'

import { createAnthropicSSEWriter } from '../src/routes/messages/sse-writer'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

afterEach(() => {
  // Give any pending timers from the previous test a chance to settle.
  return wait(1)
})

describe('createAnthropicSSEWriter', () => {
  test('sends keepalive ping events during idle periods before and after non-ping events', async () => {
    const writes: Array<{ event?: string, data: string }> = []
    const stream = {
      closed: false,
      aborted: false,
      async writeSSE(message: { event?: string, data: string }) {
        writes.push(message)
      },
    }

    const writer = createAnthropicSSEWriter(stream, {
      keepAliveIntervalMs: 5,
    })

    await wait(12)
    expect(writes.some(message => message.event === 'ping')).toBe(true)

    await writer.writeEvent({
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 1,
          output_tokens: 0,
        },
      },
    })

    const messageStartIndex = writes.findIndex(message => message.event === 'message_start')
    expect(messageStartIndex).toBeGreaterThanOrEqual(0)

    await wait(12)

    const laterPing = writes.slice(messageStartIndex + 1).find(message => message.event === 'ping')
    expect(laterPing).toBeDefined()

    await writer.close()
  })

  test('resets the keepalive interval after each event', async () => {
    const writes: Array<{ event?: string, data: string }> = []
    const stream = {
      closed: false,
      aborted: false,
      async writeSSE(message: { event?: string, data: string }) {
        writes.push(message)
      },
    }

    const writer = createAnthropicSSEWriter(stream, {
      keepAliveIntervalMs: 20,
    })

    await wait(12)
    await writer.writeEvent({ type: 'ping' })
    const explicitPingCount = writes.length

    await wait(12)
    expect(writes).toHaveLength(explicitPingCount)

    await wait(12)
    expect(writes.length).toBeGreaterThan(explicitPingCount)
    expect(writes.at(-1)?.event).toBe('ping')

    await writer.close()
  })

  test('close cancels pending keepalive timers', async () => {
    const writes: Array<{ event?: string, data: string }> = []
    const stream = {
      closed: false,
      aborted: false,
      async writeSSE(message: { event?: string, data: string }) {
        writes.push(message)
      },
    }

    const writer = createAnthropicSSEWriter(stream, {
      keepAliveIntervalMs: 50,
    })

    await writer.close()
    await wait(60)

    expect(writes).toHaveLength(0)
  })
})
