import type { AnthropicStreamState } from '~/routes/messages/anthropic-types'
import type { ChatCompletionChunk } from '~/services/copilot/create-chat-completions'

import { describe, expect, test } from 'bun:test'

import {
  canRecoverUpstreamTerminationAsMessage,
  finalizeAnthropicStreamFromState,
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from '~/routes/messages/stream-translation'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    messageStopSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    currentBlockType: null,
    thinkingSignature: null,
    pendingLeadingText: '',
    hasThinkingContent: false,
    hasNonThinkingContent: false,
    toolCalls: {},
  }
}

function makeChunk(
  overrides: Partial<ChatCompletionChunk> & { choices?: ChatCompletionChunk['choices'] } = {},
): ChatCompletionChunk {
  return {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: null,
        logprobs: null,
      },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stream translation edge cases', () => {
  test('empty choices array produces no events', () => {
    const state = freshState()
    const stateBefore = { ...state }
    const events = translateChunkToAnthropicEvents(
      makeChunk({ choices: [] }),
      state,
    )

    expect(events).toEqual([])
    expect(state.messageStartSent).toBe(stateBefore.messageStartSent)
    expect(state.contentBlockIndex).toBe(stateBefore.contentBlockIndex)
    expect(state.contentBlockOpen).toBe(stateBefore.contentBlockOpen)
    expect(state.toolCalls).toEqual(stateBefore.toolCalls)
  })

  test('first chunk always produces message_start', () => {
    const state = freshState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { role: 'assistant' }, finish_reason: null, logprobs: null },
        ],
      }),
      state,
    )

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0].type).toBe('message_start')
    expect(state.messageStartSent).toBe(true)
  })

  test('message_start only sent once across multiple chunks', () => {
    const state = freshState()

    // First chunk — should include message_start
    const first = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { content: 'Hello' }, finish_reason: null, logprobs: null },
        ],
      }),
      state,
    )
    expect(first.some(e => e.type === 'message_start')).toBe(true)

    // Second chunk — must NOT include message_start
    const second = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { content: ' world' }, finish_reason: null, logprobs: null },
        ],
      }),
      state,
    )
    expect(second.some(e => e.type === 'message_start')).toBe(false)
  })

  test('finish_reason closes open block and emits message_delta + message_stop', () => {
    const state = freshState()

    // Open a text block first
    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { content: 'Hi' }, finish_reason: null, logprobs: null },
        ],
      }),
      state,
    )
    expect(state.contentBlockOpen).toBe(true)

    // Send finish chunk
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: {}, finish_reason: 'stop', logprobs: null },
        ],
      }),
      state,
    )

    const types = events.map(e => e.type)
    expect(types).toContain('content_block_stop')
    expect(types).toContain('message_delta')
    expect(types).toContain('message_stop')
    // message_stop should be the last event
    expect(types[types.length - 1]).toBe('message_stop')
    expect(state.contentBlockOpen).toBe(false)
  })

  test('tool call followed by text closes tool block first', () => {
    const state = freshState()

    // Start a tool call
    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'my_tool', arguments: '{}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )
    expect(state.contentBlockOpen).toBe(true)

    // Now send a text delta
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { content: 'Some text' }, finish_reason: null, logprobs: null },
        ],
      }),
      state,
    )

    const types = events.map(e => e.type)
    // Should close the tool block, then open a text block, then send text delta
    expect(types[0]).toBe('content_block_stop')
    expect(types[1]).toBe('content_block_start')
    expect(types[2]).toBe('content_block_delta')

    // Verify the content_block_start is a text block
    const startEvent = events[1]
    if (startEvent.type === 'content_block_start') {
      expect(startEvent.content_block.type).toBe('text')
    }
    else {
      throw new Error('Expected content_block_start event')
    }
  })

  test('reasoning text opens a thinking block', () => {
    const state = freshState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'Planning the answer.' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
    ])

    const thinkingStart = events[1]
    const thinkingDelta = events[2]

    if (thinkingStart?.type === 'content_block_start') {
      expect(thinkingStart.content_block.type).toBe('thinking')
      if (thinkingStart.content_block.type === 'thinking') {
        expect(thinkingStart.content_block.signature).toBeUndefined()
      }
    }
    else {
      throw new Error('Expected content_block_start event')
    }

    if (thinkingDelta?.type === 'content_block_delta') {
      expect(thinkingDelta.delta.type).toBe('thinking_delta')
    }
    else {
      throw new Error('Expected content_block_delta event')
    }

    expect(state.contentBlockOpen).toBe(true)
    expect(state.currentBlockType).toBe('thinking')
  })

  test('reasoning_opaque is replayed as the Anthropic thinking signature', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              reasoning_text: 'Thinking before speaking.',
              reasoning_opaque: 'sig_reasoning_opaque_123',
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { content: 'Visible answer' }, finish_reason: null, logprobs: null },
        ],
      }),
      state,
    )

    expect(events.map(event => event.type)).toEqual([
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
    ])

    const signatureDelta = events[0]
    if (signatureDelta?.type === 'content_block_delta') {
      expect(signatureDelta.delta.type).toBe('signature_delta')
      if (signatureDelta.delta.type === 'signature_delta') {
        expect(signatureDelta.delta.signature).toBe('sig_reasoning_opaque_123')
      }
    }
    else {
      throw new Error('Expected signature delta event')
    }
  })

  test('leading whitespace is suppressed when thinking starts next', () => {
    const state = freshState()

    const firstEvents = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { content: '\n\n' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(firstEvents.map(event => event.type)).toEqual([
      'message_start',
    ])
    expect(state.pendingLeadingText).toBe('\n\n')

    const secondEvents = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'Thinking starts here.' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(secondEvents.map(event => event.type)).toEqual([
      'content_block_start',
      'content_block_delta',
    ])

    const startEvent = secondEvents[0]
    if (startEvent?.type === 'content_block_start') {
      expect(startEvent.index).toBe(0)
      expect(startEvent.content_block.type).toBe('thinking')
      if (startEvent.content_block.type === 'thinking') {
        expect(startEvent.content_block.signature).toBeUndefined()
      }
    }
    else {
      throw new Error('Expected content_block_start event')
    }

    expect(state.pendingLeadingText).toBe('')
  })

  test('leading whitespace is preserved when real text follows', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { content: '\n\n' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { content: 'Hello' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(events.map(event => event.type)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
    ])

    const firstDelta = events[1]
    const secondDelta = events[2]

    if (firstDelta?.type === 'content_block_delta' && secondDelta?.type === 'content_block_delta') {
      expect(firstDelta.delta.type).toBe('text_delta')
      expect(secondDelta.delta.type).toBe('text_delta')
      if (firstDelta.delta.type === 'text_delta' && secondDelta.delta.type === 'text_delta') {
        expect(firstDelta.delta.text).toBe('\n\n')
        expect(secondDelta.delta.text).toBe('Hello')
      }
    }
    else {
      throw new Error('Expected text delta events')
    }
  })

  test('text followed by reasoning closes the text block first', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { content: 'Hi' }, finish_reason: null, logprobs: null },
        ],
      }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'Now think more deeply.' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(events.map(event => event.type)).toEqual([
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
    ])

    const thinkingStart = events[1]
    if (thinkingStart?.type === 'content_block_start') {
      expect(thinkingStart.content_block.type).toBe('thinking')
      if (thinkingStart.content_block.type === 'thinking') {
        expect(thinkingStart.content_block.signature).toBeUndefined()
      }
    }
    else {
      throw new Error('Expected content_block_start event')
    }

    expect(state.currentBlockType).toBe('thinking')
    expect(state.contentBlockIndex).toBe(1)
  })

  test('reasoning followed by text closes the thinking block first', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'Thinking before speaking.' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { content: 'Final answer' }, finish_reason: null, logprobs: null },
        ],
      }),
      state,
    )

    expect(events.map(event => event.type)).toEqual([
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
    ])

    const textStart = events[1]
    if (textStart?.type === 'content_block_start') {
      expect(textStart.content_block.type).toBe('text')
    }
    else {
      throw new Error('Expected content_block_start event')
    }

    expect(state.currentBlockType).toBe('text')
  })

  test('reasoning followed by tool use closes the thinking block first', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'Need to call a tool.' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_2', type: 'function', function: { name: 'lookup', arguments: '{}' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(events.map(event => event.type)).toEqual([
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
    ])

    const toolStart = events[1]
    if (toolStart?.type === 'content_block_start') {
      expect(toolStart.content_block.type).toBe('tool_use')
    }
    else {
      throw new Error('Expected content_block_start event')
    }

    expect(state.currentBlockType).toBe('tool_use')
  })

  test('finish_reason closes an open thinking block', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'One last thought.' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: {}, finish_reason: 'stop', logprobs: null },
        ],
      }),
      state,
    )

    expect(events.map(event => event.type)).toEqual([
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])

    expect(state.contentBlockOpen).toBe(false)
    expect(state.currentBlockType).toBeNull()
  })

  test('finish_reason uses the latest reasoning_opaque as the thinking signature', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'One last thought.', reasoning_opaque: 'sig_finish_opaque_456' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: {}, finish_reason: 'stop', logprobs: null },
        ],
      }),
      state,
    )

    const signatureDelta = events[0]
    if (signatureDelta?.type === 'content_block_delta') {
      expect(signatureDelta.delta.type).toBe('signature_delta')
      if (signatureDelta.delta.type === 'signature_delta') {
        expect(signatureDelta.delta.signature).toBe('sig_finish_opaque_456')
      }
    }
    else {
      throw new Error('Expected signature delta event')
    }
  })

  test('finalizeAnthropicStreamFromState closes open thinking blocks and emits message_stop', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'Still thinking...' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = finalizeAnthropicStreamFromState(state)
    expect(events.map(event => event.type)).toEqual([
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])

    expect(state.messageStopSent).toBe(true)
    expect(state.contentBlockOpen).toBe(false)
  })

  test('finalizeAnthropicStreamFromState preserves pending leading text before message_stop', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { content: '\n\n' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = finalizeAnthropicStreamFromState(state)
    expect(events.map(event => event.type)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])

    const firstDelta = events[1]
    if (firstDelta?.type === 'content_block_delta') {
      expect(firstDelta.delta.type).toBe('text_delta')
      if (firstDelta.delta.type === 'text_delta') {
        expect(firstDelta.delta.text).toBe('\n\n')
      }
    }
    else {
      throw new Error('Expected text delta event')
    }
  })

  test('finalizeAnthropicStreamFromState refuses to synthesize tool_use completion', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_3', type: 'function', function: { name: 'lookup', arguments: '{"q":' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    const events = finalizeAnthropicStreamFromState(state)
    expect(events).toEqual([])
    expect(state.messageStopSent).toBe(false)
    expect(state.contentBlockOpen).toBe(true)
  })

  test('canRecoverUpstreamTerminationAsMessage is false for thinking-only streams', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'Still reasoning...' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(canRecoverUpstreamTerminationAsMessage(state)).toBe(false)
  })

  test('canRecoverUpstreamTerminationAsMessage is true after visible text output', () => {
    const state = freshState()

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { reasoning_text: 'Think first.' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: { content: 'Answer now.' },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(canRecoverUpstreamTerminationAsMessage(state)).toBe(true)
  })

  test('translateErrorToAnthropicErrorEvent returns error event with api_error type', () => {
    const event = translateErrorToAnthropicErrorEvent()

    expect(event.type).toBe('error')
    if (event.type === 'error') {
      expect(event.error.type).toBe('api_error')
      expect(typeof event.error.message).toBe('string')
    }
    else {
      throw new Error('Expected error event')
    }
  })

  test('usage fields from chunk propagate to message_start', () => {
    const state = freshState()
    const events = translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          { index: 0, delta: { role: 'assistant' }, finish_reason: null, logprobs: null },
        ],
        usage: {
          prompt_tokens: 42,
          completion_tokens: 0,
          total_tokens: 42,
          prompt_tokens_details: { cached_tokens: 10 },
        },
      }),
      state,
    )

    const messageStart = events.find(e => e.type === 'message_start')
    expect(messageStart).toBeDefined()

    if (messageStart?.type === 'message_start') {
      // input_tokens should be prompt_tokens - cached_tokens = 42 - 10 = 32
      expect(messageStart.message.usage.input_tokens).toBe(32)
      expect((messageStart.message.usage as any).cache_read_input_tokens).toBe(10)
    }
    else {
      throw new Error('Expected message_start event')
    }
  })

  test('multiple tool calls track independent block indices', () => {
    const state = freshState()

    // First tool call at OpenAI index 0
    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'tool_a', arguments: '' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    // Second tool call at OpenAI index 1
    translateChunkToAnthropicEvents(
      makeChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 1, id: 'call_b', type: 'function', function: { name: 'tool_b', arguments: '' } },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      }),
      state,
    )

    expect(state.toolCalls[0]).toBeDefined()
    expect(state.toolCalls[1]).toBeDefined()
    expect(state.toolCalls[0].anthropicBlockIndex).not.toBe(state.toolCalls[1].anthropicBlockIndex)
  })
})
