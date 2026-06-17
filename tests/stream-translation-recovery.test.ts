import type { AnthropicStreamState } from '~/lib/translation/types'
import type { NativeAnthropicPassthroughState } from '~/routes/messages/stream-finalizer'

import { describe, expect, test } from 'bun:test'

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
  shouldEmitNativeAnthropicTerminationError,
  updateNativeAnthropicPassthroughState,
} from '~/routes/messages/stream-finalizer'

function makeState(overrides: Partial<AnthropicStreamState> = {}): AnthropicStreamState {
  return {
    messageStartSent: true,
    messageStopSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    currentBlockType: null,
    thinkingSignature: null,
    pendingLeadingText: '',
    hasThinkingContent: false,
    hasNonThinkingContent: false,
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
})

describe('finalizeAnthropicToResponsesStreamState', () => {
  test('synthesizes response.completed when Anthropic stream ends after visible text', () => {
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

    expect(events.map(event => event.type)).toEqual([
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ])
    expect(events[3]).toMatchObject({
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          {
            type: 'message',
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
      response: {
        status: 'failed',
        error: {
          code: 'upstream_stream_terminated',
        },
      },
    })
  })
})
