import type { NativeAnthropicPassthroughState } from '~/routes/messages/stream-finalizer'

import { describe, expect, mock, test } from 'bun:test'

import {
  canRecoverUpstreamTerminationAsMessage,
  createNativeAnthropicPassthroughState,
  finalizeNativeAnthropicPassthroughState,
  handleAnthropicStreamFailure,
  shouldEmitNativeAnthropicTerminationError,
  updateNativeAnthropicPassthroughState,
} from '~/routes/messages/stream-finalizer'

function createNativeAnthropicPassthroughStateWithOutput(overrides: { hasThinkingContent?: boolean, hasNonThinkingContent?: boolean }) {
  return { ...createNativeAnthropicPassthroughState(), ...overrides }
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
    const state = createNativeAnthropicPassthroughStateWithOutput({
      hasThinkingContent: true,
      hasNonThinkingContent: false,
    })

    expect(canRecoverUpstreamTerminationAsMessage(state)).toBe(false)
  })

  test('allows recovery once visible (non-thinking) content has been streamed', () => {
    const state = createNativeAnthropicPassthroughStateWithOutput({
      hasThinkingContent: true,
      hasNonThinkingContent: true,
    })

    expect(canRecoverUpstreamTerminationAsMessage(state)).toBe(true)
  })
})

describe('handleAnthropicStreamFailure', () => {
  test('surfaces an upstream AbortError as an Anthropic SSE error event', async () => {
    const events: unknown[] = []
    const error = new Error('Copilot upstream request aborted.')
    error.name = 'AbortError'

    await handleAnthropicStreamFailure({
      completionTerm: 'completion event',
      error,
      errorLabel: 'test stream',
      streamLabel: 'test stream',
      state: { hasNonThinkingContent: false, hasThinkingContent: false },
      unexpectedErrorMessage: 'unexpected',
      writer: {
        writeEvent: async (event) => {
          events.push(event)
        },
      },
      finalizeRecoveredEvents: () => [],
      clientAborted: () => false,
    })

    expect(events).toEqual([{
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Copilot upstream request aborted.',
      },
    }])
  })

  test('stays silent only when the client stream actually aborted', async () => {
    const writeEvent = mock(async () => {})
    const error = new Error('write failed after disconnect')

    await handleAnthropicStreamFailure({
      completionTerm: 'completion event',
      error,
      errorLabel: 'test stream',
      streamLabel: 'test stream',
      state: { hasNonThinkingContent: false, hasThinkingContent: false },
      unexpectedErrorMessage: 'unexpected',
      writer: { writeEvent },
      finalizeRecoveredEvents: () => [],
      clientAborted: () => true,
    })

    expect(writeEvent).not.toHaveBeenCalled()
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
