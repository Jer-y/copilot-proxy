import { afterEach, describe, expect, mock, test } from 'bun:test'
import consola from 'consola'

import { instrumentCopilotEventStream } from '../src/services/copilot/stream-metrics'

const originalDebug = consola.debug

function installDebugMock() {
  const debugMock = mock((..._args: Array<unknown>) => {})
  const debugLog = Object.assign(
    (...args: Array<unknown>) => debugMock(...args),
    {
      raw: (...args: Array<unknown>) => debugMock(...args),
    },
  ) as unknown as typeof consola.debug
  consola.debug = debugLog
  return debugMock
}

async function collectEvents<T>(source: AsyncIterable<T>): Promise<Array<T>> {
  const events: Array<T> = []
  for await (const event of source) {
    events.push(event)
  }
  return events
}

afterEach(() => {
  consola.debug = originalDebug
})

describe('instrumentCopilotEventStream', () => {
  test('logs first event and completion for a successful stream', async () => {
    const debugMock = installDebugMock()

    async function* source() {
      yield { event: 'message', data: '{"ok":true}' }
    }

    const events = await collectEvents(instrumentCopilotEventStream(source(), {
      endpoint: '/responses',
      requestStartedAt: Date.now(),
    }))

    expect(events).toEqual([
      { event: 'message', data: '{"ok":true}' },
    ])
    expect(debugMock).toHaveBeenCalledTimes(2)
    expect(debugMock.mock.calls[0]?.[0]).toBe('Upstream /responses first SSE event:')
    expect(debugMock.mock.calls[1]?.[0]).toBe('Upstream /responses stream completed:')
  })

  test('logs failure without also logging completion when the stream throws', async () => {
    const debugMock = installDebugMock()

    async function* source() {
      throw new Error('boom')
    }

    await expect(collectEvents(instrumentCopilotEventStream(source(), {
      endpoint: '/chat/completions',
      requestStartedAt: Date.now(),
    }))).rejects.toThrow('boom')

    expect(debugMock).toHaveBeenCalledTimes(1)
    expect(debugMock.mock.calls[0]?.[0]).toBe('Upstream /chat/completions stream failed:')
  })
})
