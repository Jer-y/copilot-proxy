import type { Message, Peer } from 'crossws'
import type WebSocket from 'ws'
import type { ResponsesWebSocketSessionDeps } from '~/routes/responses/websocket'
import type { Model, ModelsResponse } from '~/services/copilot/get-models'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { configureCopilotFetchTimeouts } from '~/lib/upstream-fetch'
import { ResponsesWebSocketRequestBufferBudget, ResponsesWebSocketSession } from '~/routes/responses/websocket'

interface SentClose {
  code?: number
  reason?: string
}

class FakePeer {
  readonly closeCalls: SentClose[] = []
  readonly context = {
    path: '/v1/responses',
    userAgent: 'responses-websocket-test',
  }

  readonly id = crypto.randomUUID()
  readonly remoteAddress = '127.0.0.1'
  readonly sent: string[] = []
  bufferedAmount = 0
  terminateCalls = 0

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
  }

  send(data: unknown): void {
    this.sent.push(String(data))
  }

  terminate(): void {
    this.terminateCalls++
  }

  async waitForDrain(): Promise<void> {}
}

class FakeUpstreamWebSocket extends EventEmitter {
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly closeCalls: SentClose[] = []
  readonly sent: string[] = []
  pauseCalls = 0
  readyState = this.OPEN
  resumeCalls = 0
  terminateCalls = 0

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = 2
  }

  emitEvent(event: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(event)), false)
  }

  pause(): void {
    this.pauseCalls++
  }

  resume(): void {
    this.resumeCalls++
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data)
    callback?.()
  }

  terminate(): void {
    this.terminateCalls++
    this.readyState = 3
  }
}

interface Harness {
  acquirePermit: ReturnType<typeof mock>
  connect: ReturnType<typeof mock>
  initialTurnRelease: ReturnType<typeof mock>
  peer: FakePeer
  permit: {
    cancel: ReturnType<typeof mock>
    fail: ReturnType<typeof mock>
    succeed: ReturnType<typeof mock>
  }
  session: ResponsesWebSocketSession
  upstream: FakeUpstreamWebSocket
}

let originalModels: ModelsResponse | undefined
let sessions: ResponsesWebSocketSession[] = []

beforeEach(() => {
  originalModels = state.models
  state.models = {
    object: 'list',
    data: [
      makeModel('gpt-ws', ['/responses', 'ws:/responses']),
      makeModel('gpt-http', ['/responses']),
    ],
  }
})

afterEach(async () => {
  for (const session of sessions)
    session.forceClose()
  sessions = []
  await Promise.resolve()
  configureCopilotFetchTimeouts({})
  state.models = originalModels
})

describe('ResponsesWebSocketSession', () => {
  test('forwards an explicitly supported model and strips HTTP-only fields', async () => {
    const harness = createHarness()

    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'hello',
      stream: true,
      background: false,
      service_tier: 'default',
    }))

    await waitFor(() => harness.upstream.sent.length === 1)
    expect(harness.connect).toHaveBeenCalledTimes(1)
    expect(harness.connect.mock.calls[0]?.[0]).toMatchObject({
      hasVision: false,
      initiator: 'user',
      model: 'gpt-ws',
    })
    expect(JSON.parse(harness.upstream.sent[0]!)).toEqual({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'hello',
    })

    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await waitFor(() => harness.initialTurnRelease.mock.calls.length === 1)
    expect(harness.peer.sent.map(parseFrame)).toContainEqual({
      type: 'response.completed',
      sequence_number: 0,
    })
  })

  test('emits the official top-level error shape at the connection duration limit', async () => {
    const harness = createHarness({ maxDurationMs: 5 })

    await waitFor(() => receivedErrorCodes(harness.peer).includes('websocket_connection_limit_reached'))
    const error = harness.peer.sent.map(parseFrame).find((frame): frame is Record<string, unknown> =>
      typeof frame === 'object'
      && frame !== null
      && (frame as { type?: unknown }).type === 'error')

    expect(error).toEqual({
      type: 'error',
      code: 'websocket_connection_limit_reached',
      message: 'Responses WebSocket connection limit reached (60 minutes). Create a new WebSocket connection to continue.',
      param: null,
      sequence_number: 0,
      status: 400,
      error_type: 'invalid_request_error',
    })
    expect(harness.peer.closeCalls).toEqual([{
      code: 1000,
      reason: 'WebSocket connection duration limit reached',
    }])
    expect(harness.connect).not.toHaveBeenCalled()
  })

  test('serializes two turns and preserves an unknown or persisted previous_response_id', async () => {
    const harness = createHarness()

    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'first',
    }))
    harness.session.receive(textMessage({
      type: 'response.create',
      previous_response_id: 'resp_first',
      input: 'second',
    }))

    await waitFor(() => harness.upstream.sent.length === 1)
    await flushAsyncWork()
    expect(harness.upstream.sent).toHaveLength(1)
    expect(harness.acquirePermit).not.toHaveBeenCalled()

    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await waitFor(() => harness.upstream.sent.length === 2)
    expect(harness.connect).toHaveBeenCalledTimes(1)
    expect(harness.acquirePermit).toHaveBeenCalledTimes(1)
    expect(JSON.parse(harness.upstream.sent[1]!)).toMatchObject({
      type: 'response.create',
      model: 'gpt-ws',
      previous_response_id: 'resp_first',
      input: 'second',
    })

    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await waitFor(() => harness.permit.succeed.mock.calls.length === 1)
    expect(harness.initialTurnRelease).toHaveBeenCalledTimes(1)
  })

  test('keeps lifecycle response IDs stable and maps the public ID back to the upstream terminal ID', async () => {
    const harness = createHarness()

    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'first',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.upstream.emitEvent({
      type: 'response.created',
      response: { id: 'resp_created' },
      sequence_number: 0,
    })
    harness.upstream.emitEvent({
      type: 'response.in_progress',
      response: { id: 'resp_in_progress' },
      sequence_number: 1,
    })
    harness.upstream.emitEvent({
      type: 'response.completed',
      response: { id: 'resp_terminal' },
      sequence_number: 2,
    })

    await waitFor(() => harness.initialTurnRelease.mock.calls.length === 1)
    expect(harness.peer.sent.map(parseFrame).map((frame) => {
      const event = frame as { response?: { id?: unknown } }
      return event.response?.id
    })).toEqual([
      'resp_created',
      'resp_created',
      'resp_created',
    ])

    harness.session.receive(textMessage({
      type: 'response.create',
      previous_response_id: 'resp_created',
      input: 'second',
    }))
    await waitFor(() => harness.upstream.sent.length === 2)
    expect(JSON.parse(harness.upstream.sent[1]!)).toMatchObject({
      previous_response_id: 'resp_terminal',
      input: 'second',
    })

    harness.upstream.emitEvent({
      type: 'response.completed',
      response: {
        id: 'resp_second_terminal',
        previous_response_id: 'resp_terminal',
      },
      sequence_number: 0,
    })
    await waitFor(() => harness.permit.succeed.mock.calls.length === 1)
    expect(harness.peer.sent.map(parseFrame).at(-1)).toMatchObject({
      response: {
        id: 'resp_second_terminal',
        previous_response_id: 'resp_created',
      },
    })

    harness.session.receive(textMessage({
      type: 'response.create',
      previous_response_id: 'resp_persisted_elsewhere',
      input: 'third',
    }))
    await waitFor(() => harness.upstream.sent.length === 3)
    expect(JSON.parse(harness.upstream.sent[2]!)).toMatchObject({
      previous_response_id: 'resp_persisted_elsewhere',
      input: 'third',
    })
    harness.upstream.emitEvent({
      type: 'response.completed',
      response: { id: 'resp_third_terminal' },
      sequence_number: 0,
    })
    await waitFor(() => harness.permit.succeed.mock.calls.length === 2)
  })

  test('rejects a model without explicit WebSocket metadata before connecting', async () => {
    const harness = createHarness()

    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-http',
      input: 'hello',
    }))

    await waitFor(() => receivedErrorCodes(harness.peer).includes('unsupported_websocket_model'))
    expect(harness.connect).not.toHaveBeenCalled()
    expect(harness.acquirePermit).not.toHaveBeenCalled()
    expect(harness.upstream.sent).toHaveLength(0)
  })

  test('requires an exact live model entry after Anthropic model normalization', async () => {
    state.models?.data.push(makeModel('claude-opus-4.6', ['ws:/responses']))

    const unsupportedSuffix = createHarness()
    unsupportedSuffix.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws-unlisted',
      input: 'must not use the gpt-ws capability entry',
    }))
    await waitFor(() => receivedErrorCodes(unsupportedSuffix.peer).includes('unsupported_websocket_model'))
    expect(unsupportedSuffix.connect).not.toHaveBeenCalled()

    const normalizedAnthropic = createHarness()
    normalizedAnthropic.session.receive(textMessage({
      type: 'response.create',
      model: 'claude-opus-4-6-20250514',
      input: 'normalized exact match',
    }))
    await waitFor(() => normalizedAnthropic.upstream.sent.length === 1)
    expect(normalizedAnthropic.connect.mock.calls[0]?.[0]).toMatchObject({
      model: 'claude-opus-4.6',
    })
    expect(JSON.parse(normalizedAnthropic.upstream.sent[0]!)).toMatchObject({
      model: 'claude-opus-4.6',
    })
  })

  test('returns protocol errors for malformed and unknown events without connecting', async () => {
    const malformed = createHarness()
    malformed.session.receive(textMessage('{'))
    await waitFor(() => receivedErrorCodes(malformed.peer).includes('invalid_json'))

    const unknown = createHarness()
    unknown.session.receive(textMessage({ type: 'session.update' }))
    await waitFor(() => receivedErrorCodes(unknown.peer).includes('unsupported_websocket_event'))

    expect(malformed.connect).not.toHaveBeenCalled()
    expect(unknown.connect).not.toHaveBeenCalled()
  })

  test('rejects malformed input item and content-part shapes before analysis', async () => {
    const scenarios = [{
      input: [null],
      param: 'input[0]',
    }, {
      input: [{ role: 'user', content: [null] }],
      param: 'input[0].content[0]',
    }, {
      input: [{ type: 'message', role: 'user', content: null }],
      param: 'input[0].content',
    }, {
      input: [{
        type: 'function_call_output',
        call_id: 'call_1',
        output: [null],
      }],
      param: 'input[0].output[0]',
    }, {
      input: [{
        type: 'function_call_output',
        call_id: 'call_1',
        output: null,
      }],
      param: 'input[0].output',
    }]

    for (const scenario of scenarios) {
      const harness = createHarness()
      harness.session.receive(textMessage({
        type: 'response.create',
        model: 'gpt-ws',
        input: scenario.input,
      }))

      await waitFor(() => receivedErrorCodes(harness.peer).includes('invalid_websocket_parameter'))
      const error = harness.peer.sent.map(parseFrame).find((frame): frame is Record<string, unknown> =>
        typeof frame === 'object'
        && frame !== null
        && (frame as { type?: unknown }).type === 'error')
      expect(error).toMatchObject({
        type: 'error',
        code: 'invalid_websocket_parameter',
        error_type: 'invalid_request_error',
        param: scenario.param,
        status: 400,
      })
      expect(String(error?.message)).not.toContain('Cannot ')
      expect(harness.connect).not.toHaveBeenCalled()
      expect(harness.acquirePermit).not.toHaveBeenCalled()
      expect(harness.upstream.sent).toHaveLength(0)
    }
  })

  test('forwards unknown typed input and content parts without narrowing the protocol', async () => {
    const harness = createHarness()
    const event = {
      type: 'response.create' as const,
      model: 'gpt-ws',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'future_content_part', future_field: true }],
      }, {
        type: 'future_input_item',
        future_field: 'preserved',
      }],
    }

    harness.session.receive(textMessage(event))

    await waitFor(() => harness.upstream.sent.length === 1)
    expect(JSON.parse(harness.upstream.sent[0]!)).toEqual(event)
  })

  test('rejects generate:false warmup because Copilot generates or errors instead of warming state', async () => {
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      generate: false,
      input: 'warmup state',
    }))

    await waitFor(() => receivedErrorCodes(harness.peer).includes('unsupported_value'))
    expect(harness.connect).not.toHaveBeenCalled()
    expect(harness.upstream.sent).toHaveLength(0)
  })

  test('rejects unsupported or malformed background values and strips a valid null value', async () => {
    for (const background of [true, 'true', 1, {}, []]) {
      const malformed = createHarness()
      malformed.session.receive(textMessage({
        type: 'response.create',
        model: 'gpt-ws',
        background,
        input: 'must not be converted to foreground',
      }))

      await waitFor(() => receivedErrorCodes(malformed.peer).includes('invalid_websocket_parameter'))
      expect(malformed.peer.sent.map(parseFrame)).toContainEqual(expect.objectContaining({
        code: 'invalid_websocket_parameter',
        param: 'background',
        status: 400,
      }))
      expect(malformed.connect).not.toHaveBeenCalled()
    }

    const nullable = createHarness()
    nullable.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      background: null,
      input: 'valid foreground request',
    }))
    await waitFor(() => nullable.upstream.sent.length === 1)
    expect(JSON.parse(nullable.upstream.sent[0]!)).toEqual({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'valid foreground request',
    })
  })

  test('rejects stream:false and malformed stream values while stripping a valid null value', async () => {
    for (const stream of [false, 'false', 0, {}, []]) {
      const rejected = createHarness()
      rejected.session.receive(textMessage({
        type: 'response.create',
        model: 'gpt-ws',
        stream,
        input: 'must remain a WebSocket stream',
      }))

      const expectedCode = stream === false ? 'unsupported_value' : 'invalid_websocket_parameter'
      await waitFor(() => receivedErrorCodes(rejected.peer).includes(expectedCode))
      expect(rejected.peer.sent.map(parseFrame)).toContainEqual(expect.objectContaining({
        code: expectedCode,
        param: 'stream',
        status: 400,
      }))
      expect(rejected.connect).not.toHaveBeenCalled()
      expect(rejected.upstream.sent).toHaveLength(0)
    }

    const nullable = createHarness()
    nullable.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      stream: null,
      input: 'valid implicit stream',
    }))
    await waitFor(() => nullable.upstream.sent.length === 1)
    expect(JSON.parse(nullable.upstream.sent[0]!)).toEqual({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'valid implicit stream',
    })
  })

  test('rejects binary frames and closes the downstream connection', () => {
    const harness = createHarness()

    harness.session.receive(binaryMessage(new Uint8Array([1, 2, 3])))

    expect(receivedErrorCodes(harness.peer)).toContain('invalid_websocket_frame')
    expect(harness.peer.closeCalls).toEqual([{
      code: 1003,
      reason: 'Binary frames are not supported',
    }])
    expect(harness.connect).not.toHaveBeenCalled()
  })

  test('keeps a local mid-turn error ordered after forwarded upstream events', async () => {
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.upstream.emitEvent({ type: 'response.created', sequence_number: 0 })
    harness.upstream.emitEvent({ type: 'response.in_progress', sequence_number: 1 })
    harness.session.receive(binaryMessage(new Uint8Array([1, 2, 3])))

    expect(harness.peer.sent.map(parseFrame).map((frame) => {
      return (frame as { sequence_number?: unknown }).sequence_number
    })).toEqual([0, 1, 2])
    expect(receivedErrorCodes(harness.peer)).toContain('invalid_websocket_frame')
  })

  test('rejects an overfull queue only after earlier turns complete in FIFO order', async () => {
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)
    harness.upstream.emitEvent({
      type: 'response.created',
      response: { id: 'resp_active' },
      sequence_number: 0,
    })

    for (let index = 0; index < 9; index++) {
      harness.session.receive(textMessage({
        type: 'response.create',
        input: `queued-${index}`,
      }))
    }
    harness.session.receive(textMessage({
      type: 'response.create',
      input: 'ignored-after-overflow',
    }))

    expect(receivedErrorCodes(harness.peer)).not.toContain('websocket_queue_full')
    expect(harness.peer.closeCalls).toHaveLength(0)
    expect(harness.upstream.sent).toHaveLength(1)
    expect(harness.acquirePermit).not.toHaveBeenCalled()

    for (let completedIndex = 0; completedIndex < 9; completedIndex++) {
      harness.upstream.emitEvent({
        type: 'response.completed',
        sequence_number: completedIndex + 1,
      })

      if (completedIndex < 8) {
        await waitFor(() => harness.upstream.sent.length === completedIndex + 2)
        expect(receivedErrorCodes(harness.peer)).not.toContain('websocket_queue_full')
        expect(harness.peer.closeCalls).toHaveLength(0)
      }
    }

    await waitFor(() => receivedErrorCodes(harness.peer).includes('websocket_queue_full'))
    expect(harness.upstream.sent.map(frame => JSON.parse(frame).input)).toEqual([
      'active',
      'queued-0',
      'queued-1',
      'queued-2',
      'queued-3',
      'queued-4',
      'queued-5',
      'queued-6',
      'queued-7',
    ])
    expect(receivedErrorCodes(harness.peer).filter(code => code === 'websocket_queue_full')).toHaveLength(1)
    expect(harness.peer.sent.map(parseFrame).find((frame) => {
      const event = frame as { code?: unknown }
      return event.code === 'websocket_queue_full'
    })).toMatchObject({
      sequence_number: 0,
    })
    expect(harness.peer.sent.map(parseFrame).map((frame) => {
      const event = frame as { code?: unknown, type?: unknown }
      return event.type === 'error' ? event.code : event.type
    })).toEqual([
      'response.created',
      ...Array.from({ length: 9 }).fill('response.completed'),
      'websocket_queue_full',
    ])
    expect(harness.peer.closeCalls).toEqual([{
      code: 1013,
      reason: 'Responses WebSocket request queue is full',
    }])
    expect(harness.upstream.closeCalls).toEqual([{
      code: 1013,
      reason: 'Responses WebSocket request queue is full',
    }])
  })

  test('clears a deferred queue rejection during graceful shutdown', async () => {
    const requestBufferBudget = new ResponsesWebSocketRequestBufferBudget(1024 * 1024)
    const harness = createHarness({ requestBufferBudget })
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    for (let index = 0; index < 9; index++) {
      harness.session.receive(textMessage({
        type: 'response.create',
        input: `queued-${index}`,
      }))
    }
    expect(requestBufferBudget.usedBytes).toBeGreaterThan(0)

    const drain = harness.session.closeGracefully()
    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await drain

    expect(receivedErrorCodes(harness.peer)).not.toContain('websocket_queue_full')
    expect(requestBufferBudget.usedBytes).toBe(0)
    expect(harness.upstream.sent.map(frame => JSON.parse(frame).input)).toEqual(['active'])
    expect(harness.peer.closeCalls).toEqual([{
      code: 1001,
      reason: 'Copilot proxy shutting down',
    }])
  })

  test('applies the queued-byte limit with the same deferred rejection order', async () => {
    const queuedEvent = {
      type: 'response.create' as const,
      input: 'x'.repeat(128),
    }
    const queuedFrameBytes = Buffer.byteLength(JSON.stringify(queuedEvent))
    const harness = createHarness({ maxQueuedBytes: queuedFrameBytes })
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.session.receive(textMessage(queuedEvent))
    harness.session.receive(textMessage({ ...queuedEvent, input: 'y'.repeat(128) }))

    expect(receivedErrorCodes(harness.peer)).not.toContain('websocket_queue_full')
    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await waitFor(() => harness.upstream.sent.length === 2)
    expect(receivedErrorCodes(harness.peer)).not.toContain('websocket_queue_full')

    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 1 })
    await waitFor(() => receivedErrorCodes(harness.peer).includes('websocket_queue_full'))

    expect(harness.upstream.sent.map(frame => JSON.parse(frame).input)).toEqual([
      'active',
      'x'.repeat(128),
    ])
    expect(harness.peer.closeCalls[0]?.code).toBe(1013)
  })

  test('enforces one shared request-buffer budget across connections', async () => {
    const queuedEvent = {
      type: 'response.create' as const,
      input: 'x'.repeat(256),
    }
    const queuedFrameBytes = Buffer.byteLength(JSON.stringify(queuedEvent))
    const requestBufferBudget = new ResponsesWebSocketRequestBufferBudget(queuedFrameBytes)
    const first = createHarness({ requestBufferBudget })
    const second = createHarness({ requestBufferBudget })

    for (const harness of [first, second]) {
      harness.session.receive(textMessage({
        type: 'response.create',
        model: 'gpt-ws',
        input: 'active',
      }))
      await waitFor(() => harness.upstream.sent.length === 1)
    }
    await flushAsyncWork()
    expect(requestBufferBudget.usedBytes).toBe(0)

    first.session.receive(textMessage(queuedEvent))
    expect(requestBufferBudget.usedBytes).toBe(queuedFrameBytes)
    second.session.receive(textMessage(queuedEvent))
    expect(receivedErrorCodes(second.peer)).not.toContain('websocket_global_queue_full')

    second.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await waitFor(() => receivedErrorCodes(second.peer).includes('websocket_global_queue_full'))
    expect(second.peer.closeCalls).toEqual([{
      code: 1013,
      reason: 'Responses WebSocket global request-buffer budget is full',
    }])
    expect(requestBufferBudget.usedBytes).toBe(queuedFrameBytes)

    first.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await waitFor(() => first.upstream.sent.length === 2)
    await flushAsyncWork()
    expect(requestBufferBudget.usedBytes).toBe(0)
    first.upstream.emitEvent({ type: 'response.completed', sequence_number: 1 })
  })

  test('releases each turn permit and closes upstream on downstream close', async () => {
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'first',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)
    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await waitFor(() => harness.initialTurnRelease.mock.calls.length === 1)

    harness.session.receive(textMessage({
      type: 'response.create',
      input: 'second',
    }))
    await waitFor(() => harness.upstream.sent.length === 2)

    harness.session.handleDownstreamClose(1000, 'client done')

    await waitFor(() => harness.permit.cancel.mock.calls.length === 1)
    expect(harness.initialTurnRelease).toHaveBeenCalledTimes(1)
    expect(harness.permit.succeed).not.toHaveBeenCalled()
    expect(harness.permit.fail).not.toHaveBeenCalled()
    expect(harness.upstream.closeCalls).toEqual([{
      code: 1000,
      reason: 'client done',
    }])
  })

  test('maps reserved abnormal close codes before forwarding them', async () => {
    const downstreamClosed = createHarness()
    downstreamClosed.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => downstreamClosed.upstream.sent.length === 1)

    downstreamClosed.session.handleDownstreamClose(1006, 'abnormal close')
    expect(downstreamClosed.upstream.closeCalls).toEqual([{
      code: 1011,
      reason: 'abnormal close',
    }])

    const upstreamClosed = createHarness()
    upstreamClosed.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => upstreamClosed.upstream.sent.length === 1)

    upstreamClosed.upstream.emit('close', 1006, Buffer.from('abnormal close'))
    await waitFor(() => upstreamClosed.peer.closeCalls.length === 1)
    expect(upstreamClosed.peer.closeCalls[0]).toEqual({
      code: 1011,
      reason: 'abnormal close',
    })
  })

  test('finishes synchronously on upstream close so a late client frame cannot reconnect', async () => {
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'first',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.upstream.emit('close', 1006, Buffer.from('abnormal close'))
    await waitFor(() => harness.peer.closeCalls.length === 1)
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'late',
    }))
    await flushAsyncWork()

    expect(harness.connect).toHaveBeenCalledTimes(1)
    expect(harness.acquirePermit).not.toHaveBeenCalled()
    expect(harness.upstream.sent.map(frame => JSON.parse(frame).input)).toEqual(['first'])
  })

  test('does not append a 502 error when upstream closes cleanly after a terminal event', async () => {
    for (const code of [1000, 1001]) {
      const harness = createHarness()
      harness.session.receive(textMessage({
        type: 'response.create',
        model: 'gpt-ws',
        input: 'complete before close',
      }))
      await waitFor(() => harness.upstream.sent.length === 1)
      harness.upstream.emitEvent({
        type: 'response.completed',
        sequence_number: 0,
        response: { id: 'resp_done', status: 'completed' },
      })
      await waitFor(() => harness.initialTurnRelease.mock.calls.length === 1)
      await flushAsyncWork()

      harness.upstream.emit('close', code, Buffer.from('clean close'))
      await waitFor(() => harness.peer.closeCalls.length === 1)

      expect(receivedErrorCodes(harness.peer)).not.toContain('upstream_websocket_closed')
      expect(harness.peer.sent.map(frame => (parseFrame(frame) as { type?: string }).type)).toEqual([
        'response.completed',
      ])
      expect(harness.peer.closeCalls).toEqual([{ code, reason: 'clean close' }])

      harness.session.receive(textMessage({
        type: 'response.create',
        model: 'gpt-ws',
        input: 'late',
      }))
      await flushAsyncWork()
      expect(harness.connect).toHaveBeenCalledTimes(1)
    }
  })

  test('reports a clean upstream close when a queued turn has not been forwarded', async () => {
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'first',
    }))
    harness.session.receive(textMessage({
      type: 'response.create',
      input: 'queued',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.upstream.emitEvent({
      type: 'response.completed',
      sequence_number: 0,
      response: { id: 'resp_done', status: 'completed' },
    })
    harness.upstream.emit('close', 1000, Buffer.from('clean close'))
    await waitFor(() => harness.peer.closeCalls.length === 1)

    expect(receivedErrorCodes(harness.peer)).toContain('upstream_websocket_closed')
    expect(harness.upstream.sent.map(frame => JSON.parse(frame).input)).toEqual(['first'])
  })

  test('does not connect after the downstream closes during local policy waits', async () => {
    let releaseRateLimit!: () => void
    const enforceRateLimit = mock(() => new Promise<void>((resolve) => {
      releaseRateLimit = resolve
    }))
    const harness = createHarness({ enforceRateLimit })

    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => enforceRateLimit.mock.calls.length === 1)

    harness.session.handleDownstreamClose(1000, 'client left')
    releaseRateLimit()
    await flushAsyncWork()

    expect(harness.connect).not.toHaveBeenCalled()
    expect(harness.acquirePermit).not.toHaveBeenCalled()
  })

  test('immediately and idempotently releases setup-stage buffer budget on downstream close', async () => {
    const event = {
      type: 'response.create' as const,
      model: 'gpt-ws',
      input: 'waiting for local rate limit',
    }
    const raw = JSON.stringify(event)
    const requestBufferBudget = new ResponsesWebSocketRequestBufferBudget(Buffer.byteLength(raw))
    let setupSignal: AbortSignal | undefined
    const enforceRateLimit = mock((_state, options?: { signal?: AbortSignal }) => {
      setupSignal = options?.signal
      return new Promise<void>((_resolve, reject) => {
        const rejectAbort = () => {
          const error = new Error('rate limit wait aborted')
          error.name = 'AbortError'
          reject(error)
        }
        options?.signal?.addEventListener('abort', rejectAbort, { once: true })
        if (options?.signal?.aborted)
          rejectAbort()
      })
    })
    const waiting = createHarness({
      enforceRateLimit: enforceRateLimit as ResponsesWebSocketSessionDeps['enforceRateLimit'],
      requestBufferBudget,
    })

    waiting.session.receive(textMessage(raw))
    await waitFor(() => enforceRateLimit.mock.calls.length === 1)
    expect(requestBufferBudget.usedBytes).toBe(Buffer.byteLength(raw))

    waiting.session.handleDownstreamClose(1000, 'client left during setup')
    expect(setupSignal?.aborted).toBe(true)
    expect(requestBufferBudget.usedBytes).toBe(0)
    await flushAsyncWork()
    expect(requestBufferBudget.usedBytes).toBe(0)

    const next = createHarness({ requestBufferBudget })
    next.session.receive(textMessage(raw))
    await waitFor(() => next.upstream.sent.length === 1)
    await flushAsyncWork()
    expect(requestBufferBudget.usedBytes).toBe(0)
  })

  test('does not send a permit-delayed turn after graceful draining starts', async () => {
    let releasePermit!: () => void
    const delayedPermit = {
      cancel: mock(() => {}),
      fail: mock(() => {}),
      succeed: mock(() => {}),
    }
    const acquirePermit = mock(() => new Promise<typeof delayedPermit>((resolve) => {
      releasePermit = () => resolve(delayedPermit)
    }))
    const harness = createHarness({
      acquirePermit: acquirePermit as ResponsesWebSocketSessionDeps['acquirePermit'],
    })

    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'first',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)
    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await waitFor(() => harness.initialTurnRelease.mock.calls.length === 1)

    harness.session.receive(textMessage({
      type: 'response.create',
      input: 'must-not-send-after-drain',
    }))
    await waitFor(() => acquirePermit.mock.calls.length === 1)
    const drain = harness.session.closeGracefully()
    releasePermit()
    await drain

    expect(harness.upstream.sent.map(frame => JSON.parse(frame).input)).toEqual(['first'])
    expect(delayedPermit.cancel).toHaveBeenCalledTimes(1)
    expect(receivedErrorCodes(harness.peer)).toHaveLength(0)
    expect(harness.peer.closeCalls).toEqual([{
      code: 1001,
      reason: 'Copilot proxy shutting down',
    }])
  })

  test('suppresses setup AbortError frames during graceful shutdown', async () => {
    const connect = mock(async (
      options: Parameters<NonNullable<ResponsesWebSocketSessionDeps['connect']>>[0],
    ) => await new Promise<never>((_resolve, reject) => {
      const rejectAbort = () => {
        const error = new Error('Copilot Responses WebSocket handshake was cancelled')
        error.name = 'AbortError'
        reject(error)
      }
      options.signal?.addEventListener('abort', rejectAbort, { once: true })
      if (options.signal?.aborted)
        rejectAbort()
    }))
    const harness = createHarness({
      connect: connect as ResponsesWebSocketSessionDeps['connect'],
    })

    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'pending handshake',
    }))
    await waitFor(() => connect.mock.calls.length === 1)
    await harness.session.closeGracefully()

    expect(receivedErrorCodes(harness.peer)).toHaveLength(0)
    expect(harness.peer.closeCalls).toEqual([{
      code: 1001,
      reason: 'Copilot proxy shutting down',
    }])
  })

  test('times out an inactive turn and releases its lease', async () => {
    configureCopilotFetchTimeouts({ bodyTimeoutMs: 5 })
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    await waitFor(() => receivedErrorCodes(harness.peer).includes('upstream_websocket_timeout'))
    expect(harness.initialTurnRelease).toHaveBeenCalledTimes(1)
    expect(harness.upstream.closeCalls[0]?.code).toBe(1011)
    expect(harness.peer.closeCalls[0]?.code).toBe(1011)
  })

  test('resumes a backpressured upstream before closing it', async () => {
    const harness = createHarness({ canPauseUpstream: true })
    harness.peer.bufferedAmount = 2 * 1024 * 1024
    harness.peer.waitForDrain = () => new Promise<void>(() => {})
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.upstream.emitEvent({ type: 'response.output_text.delta', delta: 'x' })
    await waitFor(() => harness.upstream.pauseCalls === 1)
    harness.session.handleDownstreamClose(1000, 'client left')

    expect(harness.upstream.resumeCalls).toBe(1)
    expect(harness.upstream.closeCalls[0]?.code).toBe(1000)
  })

  test('handles a rejected downstream drain without leaking a rejection', async () => {
    const harness = createHarness({ canPauseUpstream: true })
    harness.peer.bufferedAmount = 2 * 1024 * 1024
    harness.peer.waitForDrain = () => Promise.reject(new Error('drain failed'))
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.upstream.emitEvent({ type: 'response.output_text.delta', delta: 'x' })
    await waitFor(() => harness.upstream.resumeCalls === 1)
    expect(harness.upstream.pauseCalls).toBe(1)
    expect(harness.peer.closeCalls[0]?.code).toBe(1013)
    expect(harness.upstream.closeCalls[0]?.code).toBe(1013)
  })

  test('settles a terminal frame without appending a backpressure error', async () => {
    const harness = createHarness({ canPauseUpstream: false })
    let releaseDrain: (() => void) | undefined
    harness.peer.bufferedAmount = 2 * 1024 * 1024
    harness.peer.waitForDrain = () => new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    harness.session.receive(textMessage({
      type: 'response.create',
      input: 'queued',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.upstream.emitEvent({
      type: 'response.completed',
      response: { id: 'resp_terminal' },
      sequence_number: 0,
    })
    await waitFor(() => harness.initialTurnRelease.mock.calls.length === 1)
    await waitFor(() => releaseDrain !== undefined)

    expect(receivedErrorCodes(harness.peer)).not.toContain('downstream_websocket_backpressure')
    expect(harness.upstream.sent).toHaveLength(1)
    harness.peer.bufferedAmount = 0
    if (!releaseDrain)
      throw new Error('Terminal backpressure did not wait for downstream drain')
    releaseDrain()
    await waitFor(() => harness.upstream.sent.length === 2)
  })

  test('holds a turn received after a terminal frame behind the drain barrier', async () => {
    const harness = createHarness({ canPauseUpstream: false })
    let releaseDrain: (() => void) | undefined
    harness.peer.bufferedAmount = 2 * 1024 * 1024
    harness.peer.waitForDrain = () => new Promise<void>((resolve) => {
      releaseDrain = resolve
    })
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'first',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)
    harness.upstream.emitEvent({
      type: 'response.completed',
      response: { id: 'resp_terminal' },
      sequence_number: 0,
    })
    await waitFor(() => releaseDrain !== undefined)

    harness.session.receive(textMessage({
      type: 'response.create',
      input: 'after-terminal',
    }))
    await flushAsyncWork()
    expect(harness.upstream.sent).toHaveLength(1)

    harness.peer.bufferedAmount = 0
    if (!releaseDrain)
      throw new Error('Terminal backpressure did not wait for downstream drain')
    releaseDrain()
    await waitFor(() => harness.upstream.sent.length === 2)
    expect(JSON.parse(harness.upstream.sent[1]!).input).toBe('after-terminal')
  })

  test('closes instead of forwarding a queued turn when terminal drain fails', async () => {
    const harness = createHarness({ canPauseUpstream: false })
    harness.peer.bufferedAmount = 2 * 1024 * 1024
    harness.peer.waitForDrain = () => Promise.reject(new Error('drain failed'))
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'first',
    }))
    harness.session.receive(textMessage({
      type: 'response.create',
      input: 'queued',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    harness.upstream.emitEvent({
      type: 'response.completed',
      response: { id: 'resp_terminal' },
      sequence_number: 0,
    })
    await waitFor(() => harness.peer.closeCalls.length === 1)

    expect(harness.upstream.sent).toHaveLength(1)
    expect(harness.peer.closeCalls[0]?.code).toBe(1013)
    expect(receivedErrorCodes(harness.peer)).not.toContain('downstream_websocket_backpressure')
  })

  test('drains the active turn before gracefully closing both peers', async () => {
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    let drained = false
    const drain = harness.session.closeGracefully().then(() => {
      drained = true
    })
    await flushAsyncWork()
    expect(drained).toBe(false)
    expect(harness.peer.closeCalls).toHaveLength(0)

    harness.session.receive(textMessage({
      type: 'response.create',
      input: 'must not run',
    }))
    expect(receivedErrorCodes(harness.peer)).not.toContain('websocket_server_shutting_down')
    expect(harness.upstream.sent).toHaveLength(1)

    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await drain

    expect(harness.initialTurnRelease).toHaveBeenCalledTimes(1)
    expect(harness.upstream.closeCalls).toEqual([{
      code: 1001,
      reason: 'Copilot proxy shutting down',
    }])
    expect(harness.peer.closeCalls).toEqual([{
      code: 1001,
      reason: 'Copilot proxy shutting down',
    }])
  })

  test('force-terminates transports that did not finish the graceful close handshake', async () => {
    const harness = createHarness()
    harness.session.receive(textMessage({
      type: 'response.create',
      model: 'gpt-ws',
      input: 'active',
    }))
    await waitFor(() => harness.upstream.sent.length === 1)

    const drain = harness.session.closeGracefully()
    harness.upstream.emitEvent({ type: 'response.completed', sequence_number: 0 })
    await drain
    expect(harness.upstream.closeCalls).toHaveLength(1)

    harness.session.forceClose()
    harness.session.forceClose()
    expect(harness.upstream.terminateCalls).toBe(1)
    expect(harness.peer.terminateCalls).toBe(1)
  })
})

function createHarness(overrides: ResponsesWebSocketSessionDeps = {}): Harness {
  const peer = new FakePeer()
  const upstream = new FakeUpstreamWebSocket()
  const initialTurnRelease = mock(async () => {})
  const permit = {
    cancel: mock(() => {}),
    fail: mock(() => {}),
    succeed: mock(() => {}),
  }
  const connect = mock(async () => ({
    releaseInitialTurn: initialTurnRelease,
    socket: upstream as unknown as WebSocket,
  }))
  const acquirePermit = mock(async () => permit)
  const deps: ResponsesWebSocketSessionDeps = {
    acquirePermit: acquirePermit as ResponsesWebSocketSessionDeps['acquirePermit'],
    connect: connect as ResponsesWebSocketSessionDeps['connect'],
    enforceApproval: async () => {},
    enforceRateLimit: async () => {},
    ...overrides,
  }
  const session = new ResponsesWebSocketSession(peer as unknown as Peer, deps)
  sessions.push(session)
  return {
    acquirePermit,
    connect,
    initialTurnRelease,
    peer,
    permit,
    session,
    upstream,
  }
}

function textMessage(value: Record<string, unknown> | string): Message {
  return {
    rawData: typeof value === 'string' ? value : JSON.stringify(value),
  } as Message
}

function binaryMessage(value: Uint8Array): Message {
  return { rawData: value } as Message
}

function parseFrame(frame: string): unknown {
  return JSON.parse(frame)
}

function receivedErrorCodes(peer: FakePeer): string[] {
  return peer.sent
    .map(parseFrame)
    .filter((frame): frame is { code: string, type: 'error' } =>
      typeof frame === 'object'
      && frame !== null
      && (frame as { type?: unknown }).type === 'error'
      && typeof (frame as { code?: unknown }).code === 'string')
    .map(frame => frame.code)
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for Responses WebSocket test condition')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

function makeModel(id: string, supportedEndpoints?: string[]): Model {
  return {
    id,
    supported_endpoints: supportedEndpoints,
    capabilities: {
      family: 'test',
      limits: {},
      object: 'model_capabilities',
      supports: {},
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'github-copilot',
    version: '1',
  }
}
