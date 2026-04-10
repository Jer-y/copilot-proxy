import type { AnthropicResponse, AnthropicStreamEventData } from '../src/lib/translation/types'

import { describe, expect, test } from 'bun:test'

import {
  createAnthropicToResponsesStreamState,
  translateAnthropicResponseToResponses,
  translateAnthropicStreamEventToResponses,
} from '../src/lib/translation/anthropic-to-responses'

describe('Anthropic -> Responses message IDs', () => {
  test('assigns unique message item IDs when assistant text is split by tool use', () => {
    const response: AnthropicResponse = {
      id: 'msg_split',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.6',
      content: [
        { type: 'text', text: 'Before tool' },
        { type: 'tool_use', id: 'tool_123', name: 'lookup', input: { q: 'weather' } },
        { type: 'text', text: 'After tool' },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 5,
        output_tokens: 7,
      },
    }

    const translated = translateAnthropicResponseToResponses(response)
    const messageIds = translated.output
      .filter(item => item.type === 'message')
      .map(item => item.id)

    expect(messageIds).toHaveLength(2)
    expect(new Set(messageIds).size).toBe(2)
    expect(translated.text).toEqual({ format: { type: 'text' } })
    expect(translated.reasoning).toEqual({ effort: null, summary: null })
    expect(translated.instructions).toBeNull()
    expect(translated.max_output_tokens).toBeNull()
    expect(translated.previous_response_id).toBeNull()
    expect(translated.metadata).toEqual({})
  })

  test('streaming path assigns unique message item IDs when text resumes after tool use', () => {
    const state = createAnthropicToResponsesStreamState()
    const events: AnthropicStreamEventData[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_stream_split',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-opus-4.6',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 5,
            output_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Before tool' },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'tool_stream_123',
          name: 'lookup',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"q":"weather"}' },
      },
      {
        type: 'content_block_stop',
        index: 1,
      },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: 'After tool' },
      },
      {
        type: 'content_block_stop',
        index: 2,
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 7 },
      },
      {
        type: 'message_stop',
      },
    ]

    const translatedEvents = events.flatMap(event =>
      translateAnthropicStreamEventToResponses(event, state),
    )
    const completed = translatedEvents.findLast(
      event => event.type === 'response.completed',
    )

    expect(completed?.type).toBe('response.completed')
    if (completed?.type !== 'response.completed')
      return

    const messageIds = completed.response.output
      .filter(item => item.type === 'message')
      .map(item => item.id)

    expect(messageIds).toHaveLength(2)
    expect(new Set(messageIds).size).toBe(2)
    expect(completed.response.text).toEqual({ format: { type: 'text' } })
    expect(completed.response.reasoning).toEqual({ effort: null, summary: null })
    expect(completed.response.instructions).toBeNull()
    expect(completed.response.max_output_tokens).toBeNull()
    expect(completed.response.previous_response_id).toBeNull()
    expect(completed.response.metadata).toEqual({})

    const firstContentAdded = translatedEvents.find(
      event => event.type === 'response.content_part.added',
    )
    expect(firstContentAdded?.type).toBe('response.content_part.added')
    if (firstContentAdded?.type === 'response.content_part.added') {
      expect(firstContentAdded.item_id).toBe('msg_msg_stream_split_0')
    }

    const outputTextDeltas = translatedEvents.filter(
      event => event.type === 'response.output_text.delta',
    )
    expect(outputTextDeltas.length).toBe(2)
    for (const event of outputTextDeltas) {
      expect(event.item_id).toBeDefined()
    }

    const outputTextDone = translatedEvents.filter(
      event => event.type === 'response.output_text.done',
    )
    expect(outputTextDone.length).toBe(2)
    expect(outputTextDone[0]?.item_id).toBe('msg_msg_stream_split_0')
    expect(outputTextDone[1]?.item_id).toBe('msg_msg_stream_split_2')

    const functionArgsDone = translatedEvents.find(
      event => event.type === 'response.function_call_arguments.done',
    )
    expect(functionArgsDone?.type).toBe('response.function_call_arguments.done')
    if (functionArgsDone?.type === 'response.function_call_arguments.done') {
      expect(functionArgsDone.item_id).toBe('fc_tool_stream_123')
      expect(functionArgsDone.arguments).toBe('{"q":"weather"}')
    }
  })

  test('pause_turn maps to incomplete without inventing a token-limit reason', () => {
    const response: AnthropicResponse = {
      id: 'msg_pause_turn',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.6',
      content: [
        { type: 'text', text: 'Need to resume this turn.' },
      ],
      stop_reason: 'pause_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 9,
        output_tokens: 4,
      },
    }

    const translated = translateAnthropicResponseToResponses(response)
    expect(translated.status).toBe('incomplete')
    expect(translated.incomplete_details).toBeNull()
    expect(translated.completed_at).toBeNull()
  })

  test('streaming pause_turn emits response.incomplete with null incomplete_details', () => {
    const state = createAnthropicToResponsesStreamState()
    const events: AnthropicStreamEventData[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_pause_stream',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-opus-4.6',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 6,
            output_tokens: 0,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Need another turn.' },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'pause_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
      {
        type: 'message_stop',
      },
    ]

    const translatedEvents = events.flatMap(event =>
      translateAnthropicStreamEventToResponses(event, state),
    )
    const incomplete = translatedEvents.findLast(
      event => event.type === 'response.incomplete',
    )

    expect(incomplete?.type).toBe('response.incomplete')
    if (incomplete?.type !== 'response.incomplete')
      return

    expect(incomplete.response.status).toBe('incomplete')
    expect(incomplete.response.incomplete_details).toBeNull()
    expect(incomplete.response.completed_at).toBeNull()
    expect(incomplete.response.output).toEqual([
      {
        type: 'message',
        id: 'msg_msg_pause_stream_0',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Need another turn.' }],
      },
    ])
  })
})
