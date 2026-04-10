import type { ResponsesStreamEvent } from '../src/services/copilot/create-responses'

import { describe, expect, test } from 'bun:test'

import { JSONResponseError } from '../src/lib/error'
import {
  createAnthropicFromResponsesStreamState,
  createCCToResponsesStreamState,
  createResponsesToCCStreamState,
  translateCCStreamChunkToResponses,
  translateResponsesStreamEventToAnthropic,
  translateResponsesStreamEventToCC,
} from '../src/lib/translation'

describe('translateCCStreamChunkToResponses', () => {
  test('keeps stable item_id across tool argument deltas and emits full done payload', () => {
    const state = createCCToResponsesStreamState()

    const firstEvents = translateCCStreamChunkToResponses({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'claude-opus-4.6',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '' },
          }],
        },
        finish_reason: null,
        logprobs: null,
      }],
    }, state)

    expect(firstEvents.some(evt => evt.type === 'response.output_item.added')).toBe(true)

    const secondEvents = translateCCStreamChunkToResponses({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 2,
      model: 'claude-opus-4.6',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: '{"q":"wea' },
          }],
        },
        finish_reason: null,
        logprobs: null,
      }],
    }, state)

    expect(secondEvents).toContainEqual({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc_call_1',
      delta: '{"q":"wea',
    })

    const thirdEvents = translateCCStreamChunkToResponses({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 3,
      model: 'claude-opus-4.6',
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: 'ther"}' },
          }],
        },
        finish_reason: 'tool_calls',
        logprobs: null,
      }],
    }, state)

    expect(thirdEvents).toContainEqual({
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc_call_1',
      delta: 'ther"}',
    })
    expect(thirdEvents).toContainEqual({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_call_1',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"q":"weather"}',
        status: 'completed',
      },
    })

    const completedEvent = thirdEvents.find(evt => evt.type === 'response.completed')
    expect(completedEvent).toBeDefined()
    if (completedEvent?.type === 'response.completed') {
      expect(completedEvent.response.output).toEqual([
        {
          type: 'function_call',
          id: 'fc_call_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":"weather"}',
          status: 'completed',
        },
      ])
    }
  })
})

describe('Responses stream failure handling', () => {
  test('translateResponsesStreamEventToCC throws on response.failed', () => {
    const state = createResponsesToCCStreamState()

    translateResponsesStreamEventToCC({
      type: 'response.created',
      response: {
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status: 'in_progress',
      },
    }, state)

    try {
      translateResponsesStreamEventToCC({
        type: 'response.failed',
        response: {
          id: 'resp_1',
          object: 'response',
          model: 'gpt-5.4',
          output: [],
          status: 'failed',
          error: { message: 'stream failed', type: 'server_error', code: 'boom' },
        },
      }, state)
      throw new Error('expected translateResponsesStreamEventToCC to throw')
    }
    catch (error) {
      expect(error).toBeInstanceOf(JSONResponseError)
      expect((error as JSONResponseError).payload).toEqual({
        error: {
          message: 'stream failed',
          type: 'server_error',
          code: 'boom',
        },
      })
    }
  })

  test('translateResponsesStreamEventToAnthropic emits error event on response.failed', () => {
    const state = createAnthropicFromResponsesStreamState()

    const events = translateResponsesStreamEventToAnthropic({
      type: 'response.failed',
      response: {
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status: 'failed',
        error: { message: 'stream failed', type: 'server_error' },
      },
    } as ResponsesStreamEvent, state)

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          type: 'api_error',
          message: 'stream failed',
        },
      },
    ])
  })

  test('translateResponsesStreamEventToCC finalizes response.incomplete like a terminal event', () => {
    const state = createResponsesToCCStreamState()

    translateResponsesStreamEventToCC({
      type: 'response.created',
      response: {
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status: 'in_progress',
      },
    }, state)

    const chunks = translateResponsesStreamEventToCC({
      type: 'response.incomplete',
      response: {
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
      },
    }, state)

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.choices[0]?.finish_reason).toBe('length')
  })

  test('translateResponsesStreamEventToAnthropic finalizes response.incomplete with mapped stop_reason', () => {
    const state = createAnthropicFromResponsesStreamState()

    const events = translateResponsesStreamEventToAnthropic({
      type: 'response.incomplete',
      response: {
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    }, state)

    expect(events).toEqual([
      {
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      {
        type: 'message_stop',
      },
    ])
  })

  test('translateResponsesStreamEventToAnthropic maps reasonless response.incomplete to pause_turn', () => {
    const state = createAnthropicFromResponsesStreamState()

    const events = translateResponsesStreamEventToAnthropic({
      type: 'response.incomplete',
      response: {
        id: 'resp_pause',
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status: 'incomplete',
        incomplete_details: null,
        usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
      },
    }, state)

    expect(events).toEqual([
      {
        type: 'message_delta',
        delta: { stop_reason: 'pause_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      {
        type: 'message_stop',
      },
    ])
  })

  test('translators ignore output_text.done and function_call_arguments.done helper events', () => {
    const ccState = createResponsesToCCStreamState()
    const anthropicState = createAnthropicFromResponsesStreamState()

    translateResponsesStreamEventToCC({
      type: 'response.created',
      response: {
        id: 'resp_1',
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status: 'in_progress',
      },
    }, ccState)

    const outputTextDoneEvent: ResponsesStreamEvent = {
      type: 'response.output_text.done',
      output_index: 0,
      content_index: 0,
      item_id: 'msg_1',
      text: 'done',
    }
    const functionCallDoneEvent: ResponsesStreamEvent = {
      type: 'response.function_call_arguments.done',
      output_index: 1,
      item_id: 'fc_1',
      arguments: '{"ok":true}',
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"ok":true}',
        status: 'completed',
      },
    }

    expect(translateResponsesStreamEventToCC(outputTextDoneEvent, ccState)).toEqual([])
    expect(translateResponsesStreamEventToCC(functionCallDoneEvent, ccState)).toEqual([])
    expect(translateResponsesStreamEventToAnthropic(outputTextDoneEvent, anthropicState)).toEqual([])
    expect(translateResponsesStreamEventToAnthropic(functionCallDoneEvent, anthropicState)).toEqual([])
  })
})
