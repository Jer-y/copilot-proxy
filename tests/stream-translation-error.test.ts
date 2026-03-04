import type { AnthropicStreamState } from '~/routes/messages/anthropic-types'
import type { ChatCompletionChunk } from '~/services/copilot/create-chat-completions'

import { describe, expect, test } from 'bun:test'

import {
  translateChunkToAnthropicEvents,
  translateErrorToAnthropicErrorEvent,
} from '~/routes/messages/stream-translation'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshState(): AnthropicStreamState {
  return {
    messageStartSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
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
