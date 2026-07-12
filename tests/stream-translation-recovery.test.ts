import type { AnthropicStreamState } from '~/lib/translation/types'
import type { NativeAnthropicPassthroughState } from '~/routes/messages/stream-finalizer'

import { describe, expect, mock, test } from 'bun:test'
import consola from 'consola'

import {
  createAnthropicToResponsesStreamState,
  finalizeAnthropicToResponsesStreamState,
  translateAnthropicStreamEventToResponses,
} from '~/lib/translation'
import {
  canRecoverUpstreamTerminationAsMessage,
  createNativeAnthropicPassthroughState,
  finalizeAnthropicStreamFromState,
  finalizeNativeAnthropicPassthroughState,
  finalizeTruncatedAnthropicStreamFromState,
  shouldEmitNativeAnthropicTerminationError,
  updateNativeAnthropicPassthroughState,
  writeAnthropicEvents,
} from '~/routes/messages/stream-finalizer'

function makeState(overrides: Partial<AnthropicStreamState> = {}): AnthropicStreamState {
  return {
    responseId: 'resp_partial',
    responseModel: 'gpt-5.4',
    messageStartSent: true,
    messageStopSent: false,
    upstreamTerminalEventSeen: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    currentBlockType: null,
    thinkingSignature: null,
    pendingLeadingText: '',
    hasThinkingContent: false,
    hasNonThinkingContent: false,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: {},
    ...overrides,
  }
}

function recordNativeMessageStart(
  state: NativeAnthropicPassthroughState,
  outputTokens = 0,
): void {
  updateNativeAnthropicPassthroughState(state, {
    type: 'message_start',
    message: {
      id: 'msg_partial',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'fake-model',
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: outputTokens,
      },
    },
  })
}

function recordNativeTextDelta(
  state: NativeAnthropicPassthroughState,
): void {
  updateNativeAnthropicPassthroughState(state, {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  })
  updateNativeAnthropicPassthroughState(state, {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'partial' },
  })
}

describe('canRecoverUpstreamTerminationAsMessage', () => {
  test('verbose translated-event logs contain summaries, not streamed content', async () => {
    const sentinel = 'STREAM_SECRET_SENTINEL'
    const originalDebug = consola.debug
    const originalLevel = consola.level
    const logs: string[] = []
    consola.level = 4
    consola.debug = mock((...args: unknown[]) => {
      logs.push(args.map(value => String(value)).join(' '))
    }) as unknown as typeof consola.debug

    try {
      await writeAnthropicEvents({
        writeEvent: async () => {},
      }, [{
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: sentinel },
      }], { debugTranslatedEvents: true })
    }
    finally {
      consola.debug = originalDebug
      consola.level = originalLevel
    }

    expect(logs.join('\n')).not.toContain(sentinel)
    expect(logs.join('\n')).toContain('Translated Anthropic event summary')
  })

  test('refuses recovery when only thinking content was streamed', () => {
    const state = makeState({
      hasThinkingContent: true,
      hasNonThinkingContent: false,
    })

    expect(canRecoverUpstreamTerminationAsMessage(state)).toBe(false)
  })

  test('allows recovery once visible (non-thinking) content has been streamed', () => {
    const state = makeState({
      hasThinkingContent: true,
      hasNonThinkingContent: true,
    })

    expect(canRecoverUpstreamTerminationAsMessage(state)).toBe(true)
  })
})

describe('finalizeNativeAnthropicPassthroughState', () => {
  test('does not recover an empty text block as a successful message', () => {
    const state = createNativeAnthropicPassthroughState()
    recordNativeMessageStart(state)
    updateNativeAnthropicPassthroughState(state, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })

    expect(finalizeNativeAnthropicPassthroughState(state)).toEqual([])
    expect(shouldEmitNativeAnthropicTerminationError(state)).toBe(true)
  })

  test('synthesizes a complete Anthropic ending after visible text', () => {
    const state = createNativeAnthropicPassthroughState()
    recordNativeMessageStart(state, 2)
    recordNativeTextDelta(state)

    const events = finalizeNativeAnthropicPassthroughState(state)

    expect(events).toEqual([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ])
    expect(state.messageStopSeen).toBe(true)
    expect(state.currentBlockIndex).toBeNull()
  })

  test('does not duplicate an upstream message_delta', () => {
    const state = createNativeAnthropicPassthroughState()
    recordNativeMessageStart(state)
    recordNativeTextDelta(state)
    updateNativeAnthropicPassthroughState(state, {
      type: 'content_block_stop',
      index: 0,
    })
    updateNativeAnthropicPassthroughState(state, {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 4 },
    })

    expect(finalizeNativeAnthropicPassthroughState(state)).toEqual([
      { type: 'message_stop' },
    ])
  })

  test('refuses to recover thinking-only output as a successful message', () => {
    const state = createNativeAnthropicPassthroughState()
    recordNativeMessageStart(state)
    updateNativeAnthropicPassthroughState(state, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    })
    updateNativeAnthropicPassthroughState(state, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'reasoning' },
    })

    expect(finalizeNativeAnthropicPassthroughState(state)).toEqual([])
    expect(shouldEmitNativeAnthropicTerminationError(state)).toBe(true)
  })

  test('refuses to recover redacted-thinking-only output as a successful message', () => {
    const state = createNativeAnthropicPassthroughState()
    recordNativeMessageStart(state)
    updateNativeAnthropicPassthroughState(state, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'redacted_thinking', data: 'opaque-reasoning' },
    })

    expect(state.hasThinkingContent).toBe(true)
    expect(state.hasNonThinkingContent).toBe(false)
    expect(finalizeNativeAnthropicPassthroughState(state)).toEqual([])
    expect(shouldEmitNativeAnthropicTerminationError(state)).toBe(true)
  })

  test('refuses to complete an open tool_use block', () => {
    const state = createNativeAnthropicPassthroughState()
    recordNativeMessageStart(state)
    updateNativeAnthropicPassthroughState(state, {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'lookup',
        input: {},
      },
    })

    expect(finalizeNativeAnthropicPassthroughState(state)).toEqual([])
    expect(state.messageStopSeen).toBe(false)
  })

  test('tracks server_tool_use without assuming a text field', () => {
    const state = createNativeAnthropicPassthroughState()
    recordNativeMessageStart(state)

    expect(() => updateNativeAnthropicPassthroughState(state, {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'code_execution',
        input: {},
      },
    })).not.toThrow()

    expect(state.hasNonThinkingContent).toBe(true)
    expect(finalizeNativeAnthropicPassthroughState(state)).toEqual([])
    expect(state.messageStopSeen).toBe(false)
  })

  test('tracks hosted tool result blocks without assuming a text field', () => {
    const state = createNativeAnthropicPassthroughState()
    recordNativeMessageStart(state, 4)

    expect(() => updateNativeAnthropicPassthroughState(state, {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'code_execution_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: { stdout: 'ok', stderr: '' },
      },
    })).not.toThrow()

    expect(finalizeNativeAnthropicPassthroughState(state)).toEqual([
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 4 },
      },
      { type: 'message_stop' },
    ])
  })
})

describe('finalizeAnthropicStreamFromState', () => {
  test('synthesizes message_stop when a text block is open and visible content was emitted', () => {
    const state = makeState({
      contentBlockIndex: 0,
      contentBlockOpen: true,
      currentBlockType: 'text',
      hasNonThinkingContent: true,
    })

    const events = finalizeAnthropicStreamFromState(state, { outputTokens: 7 })

    expect(events).toEqual([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      { type: 'message_stop' },
    ])
    expect(state.messageStopSent).toBe(true)
    expect(state.contentBlockOpen).toBe(false)
  })

  test('returns no events when a tool_use block is still open (does not fabricate completion mid-tool-call)', () => {
    const state = makeState({
      contentBlockIndex: 0,
      contentBlockOpen: true,
      currentBlockType: 'tool_use',
      hasNonThinkingContent: true,
    })

    const events = finalizeAnthropicStreamFromState(state)

    expect(events).toEqual([])
    expect(state.messageStopSent).toBe(false)
    expect(state.contentBlockOpen).toBe(true)
  })

  test('flushes pending leading text into a text block before closing', () => {
    const state = makeState({
      pendingLeadingText: '  ',
    })

    const events = finalizeAnthropicStreamFromState(state, { stopReason: 'max_tokens', outputTokens: 3 })

    expect(events[0]).toEqual({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })
    expect(events[1]).toEqual({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '  ' },
    })
    expect(events[2]).toEqual({ type: 'content_block_stop', index: 0 })
    expect(events[3]).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens', stop_sequence: null },
      usage: { output_tokens: 3 },
    })
    expect(events[4]).toEqual({ type: 'message_stop' })
  })

  test('returns no events if message_start was never sent or message_stop was already sent', () => {
    const noStart = makeState({ messageStartSent: false, hasNonThinkingContent: true })
    expect(finalizeAnthropicStreamFromState(noStart)).toEqual([])

    const alreadyStopped = makeState({ messageStopSent: true, hasNonThinkingContent: true })
    expect(finalizeAnthropicStreamFromState(alreadyStopped)).toEqual([])
  })

  test('truncated streams emit an error instead of synthetic end_turn', () => {
    const state = makeState({
      contentBlockIndex: 0,
      contentBlockOpen: true,
      currentBlockType: 'text',
      hasNonThinkingContent: true,
    })

    const events = finalizeTruncatedAnthropicStreamFromState(state)

    expect(events).toEqual([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Upstream Copilot connection terminated before the response completed.',
        },
      },
    ])
  })
})

describe('finalizeAnthropicToResponsesStreamState', () => {
  test('Anthropic error is terminal and cannot be followed by response.completed', () => {
    const state = createAnthropicToResponsesStreamState()
    translateAnthropicStreamEventToResponses({
      type: 'message_start',
      message: {
        id: 'msg_failed',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4.6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }, state)

    const failureEvents = translateAnthropicStreamEventToResponses({
      type: 'error',
      error: { type: 'api_error', message: 'upstream failed' },
    }, state)
    const lateCompletionEvents = translateAnthropicStreamEventToResponses({ type: 'message_stop' }, state)
    const finalEvents = finalizeAnthropicToResponsesStreamState(state)

    expect(failureEvents.map(event => event.type)).toEqual(['response.failed'])
    expect(failureEvents[0]?.sequence_number).toBe(2)
    expect(lateCompletionEvents).toEqual([])
    expect(finalEvents).toEqual([])
  })

  test('empty text block followed by EOF emits only a failed terminal event', () => {
    const state = createAnthropicToResponsesStreamState()
    translateAnthropicStreamEventToResponses({
      type: 'message_start',
      message: {
        id: 'msg_empty',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4.6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }, state)
    translateAnthropicStreamEventToResponses({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }, state)

    const events = finalizeAnthropicToResponsesStreamState(state)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'response.failed',
      sequence_number: 4,
      response: {
        status: 'failed',
        error: { code: 'upstream_stream_terminated' },
      },
    })
  })

  test('emits response.failed when Anthropic stream ends after visible text without message_stop', () => {
    const state = createAnthropicToResponsesStreamState()
    translateAnthropicStreamEventToResponses({
      type: 'message_start',
      message: {
        id: 'msg_partial',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4.6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }, state)
    translateAnthropicStreamEventToResponses({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }, state)
    translateAnthropicStreamEventToResponses({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'partial' },
    }, state)

    const events = finalizeAnthropicToResponsesStreamState(state)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'response.failed',
      sequence_number: 5,
      response: {
        status: 'failed',
        error: {
          code: 'upstream_stream_terminated',
          message: expect.stringContaining('message_stop'),
        },
        output: [
          {
            type: 'message',
            status: 'in_progress',
            content: [{ type: 'output_text', text: 'partial' }],
          },
        ],
      },
    })
  })

  test('emits response.failed instead of fabricating a partial tool_use completion', () => {
    const state = createAnthropicToResponsesStreamState()
    translateAnthropicStreamEventToResponses({
      type: 'message_start',
      message: {
        id: 'msg_partial_tool',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4.6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }, state)
    translateAnthropicStreamEventToResponses({
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'lookup',
        input: {},
      },
    }, state)

    const events = finalizeAnthropicToResponsesStreamState(state)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'response.failed',
      sequence_number: 3,
      response: {
        status: 'failed',
        error: {
          code: 'upstream_stream_terminated',
        },
      },
    })
  })
})
