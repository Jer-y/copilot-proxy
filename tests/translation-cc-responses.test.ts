import type { ChatCompletionResponse, ChatCompletionsPayload } from '../src/services/copilot/create-chat-completions'
import type { ResponsesResponse } from '../src/services/copilot/create-responses'

import { describe, expect, test } from 'bun:test'

import { translateCCRequestToResponses, translateResponsesResponseToCC } from '../src/lib/translation/cc-to-responses'
import { translateCCResponseToResponses, translateResponsesRequestToCC } from '../src/lib/translation/responses-to-cc'

// ─── T1: CC Request → Responses Request ─────────────────────────

describe('translateCCRequestToResponses', () => {
  test('basic text message', () => {
    const payload: ChatCompletionsPayload = {
      model: 'gpt-5.4',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    }

    const result = translateCCRequestToResponses(payload)
    expect(result.model).toBe('gpt-5.4')
    expect(result.input).toEqual([
      { role: 'user', content: 'Hello' },
    ])
    expect(result.instructions).toBeUndefined()
  })

  test('system messages merge into instructions', () => {
    const payload: ChatCompletionsPayload = {
      model: 'gpt-5.4',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
    }

    const result = translateCCRequestToResponses(payload)
    expect(result.instructions).toBe('You are helpful.\n\nBe concise.')
    expect(result.input).toEqual([
      { role: 'user', content: 'Hi' },
    ])
  })

  test('developer messages preserved as input items', () => {
    const payload: ChatCompletionsPayload = {
      model: 'gpt-5.4',
      messages: [
        { role: 'developer', content: 'Dev instruction' },
        { role: 'user', content: 'Hi' },
      ],
    }

    const result = translateCCRequestToResponses(payload)
    expect(result.instructions).toBeUndefined()
    expect(result.input).toEqual([
      { role: 'developer', content: 'Dev instruction' },
      { role: 'user', content: 'Hi' },
    ])
  })

  test('assistant with tool_calls → function_call items', () => {
    const payload: ChatCompletionsPayload = {
      model: 'gpt-5.4',
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_123',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_123',
          content: '{"temp": 72}',
        },
      ],
    }

    const result = translateCCRequestToResponses(payload)
    expect(result.input).toEqual([
      { role: 'user', content: 'What is the weather?' },
      {
        type: 'function_call',
        id: 'fc_call_123',
        call_id: 'call_123',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'call_123',
        output: '{"temp": 72}',
      },
    ])
  })

  test('max_tokens clamped to minimum 16', () => {
    const payload: ChatCompletionsPayload = {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 5,
    }

    const result = translateCCRequestToResponses(payload)
    expect(result.max_output_tokens).toBe(16)
  })

  test('max_tokens null → undefined', () => {
    const payload: ChatCompletionsPayload = {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: null,
    }

    const result = translateCCRequestToResponses(payload)
    expect(result.max_output_tokens).toBeUndefined()
  })

  test('tools translated correctly', () => {
    const payload: ChatCompletionsPayload = {
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather info',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
    }

    const result = translateCCRequestToResponses(payload)
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather info',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ])
  })

  test('tool_choice mapped correctly', () => {
    expect(translateCCRequestToResponses({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: 'auto',
    }).tool_choice).toBe('auto')

    expect(translateCCRequestToResponses({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: 'required',
    }).tool_choice).toBe('required')

    expect(translateCCRequestToResponses({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: 'none',
    }).tool_choice).toBe('none')
  })

  test('reasoning_effort mapped to reasoning.effort', () => {
    const result = translateCCRequestToResponses({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'high',
    })
    expect(result.reasoning).toEqual({ effort: 'high' })
  })

  test('reasoning_effort max is adapted to reasoning.effort xhigh', () => {
    const result = translateCCRequestToResponses({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      reasoning_effort: 'max',
    })
    expect(result.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('response_format json_schema maps to Responses text.format json_schema', () => {
    const result = translateCCRequestToResponses({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Return JSON.' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'math_answer',
          strict: true,
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
    })

    expect(result.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'math_answer',
        strict: true,
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
      },
    })
  })

  test('unsupported fields (stop, n, logit_bias) are ignored', () => {
    const result = translateCCRequestToResponses({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'Hi' }],
      stop: ['\n'],
      n: 3,
      logit_bias: { 123: 1 },
    })
    // These fields should not appear in the result
    expect('stop' in result).toBe(false)
    expect('n' in result).toBe(false)
    expect('logit_bias' in result).toBe(false)
  })
})

// ─── T2: Responses Response → CC Response ───────────────────────

describe('translateResponsesResponseToCC', () => {
  test('basic text response', () => {
    const response: ResponsesResponse = {
      id: 'resp_123',
      object: 'response',
      model: 'gpt-5.4-2026-03-05',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hello!' }],
        },
      ],
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }

    const result = translateResponsesResponseToCC(response)
    expect(result.id).toBe('resp_123')
    expect(result.model).toBe('gpt-5.4-2026-03-05')
    expect(result.choices[0].message.content).toBe('Hello!')
    expect(result.choices[0].finish_reason).toBe('stop')
    expect(result.usage?.prompt_tokens).toBe(10)
    expect(result.usage?.completion_tokens).toBe(5)
  })

  test('function_call output → tool_calls', () => {
    const response: ResponsesResponse = {
      id: 'resp_456',
      object: 'response',
      model: 'gpt-5.4',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '{"city":"NYC"}',
        },
      ],
      status: 'completed',
    }

    const result = translateResponsesResponseToCC(response)
    expect(result.choices[0].message.content).toBeNull()
    expect(result.choices[0].message.tool_calls).toEqual([
      {
        id: 'call_abc',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
      },
    ])
    expect(result.choices[0].finish_reason).toBe('tool_calls')
  })

  test('incomplete status → length finish_reason', () => {
    const response: ResponsesResponse = {
      id: 'resp_789',
      object: 'response',
      model: 'gpt-5.4',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Truncated...' }],
        },
      ],
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    }

    const result = translateResponsesResponseToCC(response)
    expect(result.choices[0].finish_reason).toBe('length')
  })

  test('mixed text and function_call output', () => {
    const response: ResponsesResponse = {
      id: 'resp_mix',
      object: 'response',
      model: 'gpt-5.4',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Let me check...' }],
        },
        {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_def',
          name: 'search',
          arguments: '{"q":"weather"}',
        },
      ],
      status: 'completed',
    }

    const result = translateResponsesResponseToCC(response)
    expect(result.choices[0].message.content).toBe('Let me check...')
    expect(result.choices[0].message.tool_calls?.length).toBe(1)
    expect(result.choices[0].finish_reason).toBe('tool_calls')
  })
})

// ─── T4: Responses Request → CC Request ─────────────────────────

describe('translateResponsesRequestToCC', () => {
  test('basic string input', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: 'Hello',
    })

    expect(result.model).toBe('claude-opus-4.6')
    expect(result.messages).toEqual([
      { role: 'user', content: 'Hello' },
    ])
  })

  test('instructions → system message', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      instructions: 'Be helpful',
      input: [{ role: 'user', content: 'Hi' }],
    })

    expect(result.messages[0]).toEqual({ role: 'system', content: 'Be helpful' })
    expect(result.messages[1]).toEqual({ role: 'user', content: 'Hi' })
  })

  test('function_call + function_call_output items', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: [
        { role: 'user', content: 'What is the weather?' },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '{"city":"NYC"}',
          status: 'completed',
        },
        {
          type: 'function_call_output',
          call_id: 'call_abc',
          output: '{"temp": 72}',
        },
      ],
    })

    expect(result.messages).toEqual([
      { role: 'user', content: 'What is the weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_abc',
        content: '{"temp": 72}',
      },
    ])
  })

  test('adjacent function_call items merge into one assistant message', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: [
        { role: 'user', content: 'Search two things' },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_a',
          name: 'search',
          arguments: '{"q":"foo"}',
        },
        {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_b',
          name: 'search',
          arguments: '{"q":"bar"}',
        },
        {
          type: 'function_call_output',
          call_id: 'call_a',
          output: 'result_foo',
        },
        {
          type: 'function_call_output',
          call_id: 'call_b',
          output: 'result_bar',
        },
      ],
    })

    // Two function_call items should merge into one assistant message
    expect(result.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_a', type: 'function', function: { name: 'search', arguments: '{"q":"foo"}' } },
        { id: 'call_b', type: 'function', function: { name: 'search', arguments: '{"q":"bar"}' } },
      ],
    })
  })

  test('tools translated correctly', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: 'Hi',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object' },
        },
      ],
    })

    expect(result.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object' },
        },
      },
    ])
  })

  test('reasoning.effort mapped to reasoning_effort', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: 'Hi',
      reasoning: { effort: 'high' },
    })
    expect(result.reasoning_effort).toBe('high')
  })

  test('reasoning.effort xhigh clamped to high', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: 'Hi',
      reasoning: { effort: 'xhigh' },
    })
    expect(result.reasoning_effort).toBe('high')
  })

  test('reasoning.effort none is omitted for chat-completions translation', () => {
    const result = translateResponsesRequestToCC({
      model: 'gpt-4o',
      input: 'Hi',
      reasoning: { effort: 'none' },
    })
    expect(result.reasoning_effort).toBeUndefined()
  })

  test('reasoning.effort minimal is downgraded to low for chat-completions translation', () => {
    const result = translateResponsesRequestToCC({
      model: 'gpt-4o',
      input: 'Hi',
      reasoning: { effort: 'minimal' },
    })
    expect(result.reasoning_effort).toBe('low')
  })
})

// ─── T5: CC Response → Responses Response ───────────────────────

describe('translateCCResponseToResponses', () => {
  test('basic text response', () => {
    const ccResponse: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: 1700000000,
      model: 'claude-opus-4.6',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello!' },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }

    const result = translateCCResponseToResponses(ccResponse)
    expect(result.id).toBe('chatcmpl-123')
    expect(result.model).toBe('claude-opus-4.6')
    expect(result.status).toBe('completed')
    expect(result.output[0].type).toBe('message')
    expect(result.output[0].content?.[0].text).toBe('Hello!')
    expect(result.usage?.input_tokens).toBe(10)
    expect(result.usage?.output_tokens).toBe(5)
  })

  test('tool_calls → function_call output items', () => {
    const ccResponse: ChatCompletionResponse = {
      id: 'chatcmpl-456',
      object: 'chat.completion',
      created: 1700000000,
      model: 'claude-opus-4.6',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
              },
            ],
          },
          logprobs: null,
          finish_reason: 'tool_calls',
        },
      ],
    }

    const result = translateCCResponseToResponses(ccResponse)
    expect(result.status).toBe('completed')
    expect(result.output[0].type).toBe('function_call')
    expect(result.output[0].call_id).toBe('call_abc')
    expect(result.output[0].name).toBe('get_weather')
  })

  test('length finish_reason → incomplete status', () => {
    const ccResponse: ChatCompletionResponse = {
      id: 'chatcmpl-789',
      object: 'chat.completion',
      created: 1700000000,
      model: 'claude-opus-4.6',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Truncated...' },
          logprobs: null,
          finish_reason: 'length',
        },
      ],
    }

    const result = translateCCResponseToResponses(ccResponse)
    expect(result.status).toBe('incomplete')
    expect(result.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })
})

describe('content part compatibility', () => {
  test('multimodal content parts map to Responses content items', () => {
    const result = translateCCRequestToResponses({
      model: 'gpt-5.4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'high' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I can help with that.' }],
        },
      ],
    })

    expect(result.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this image' },
          { type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'high' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I can help with that.' }],
      },
    ])
  })

  test('Responses assistant content and following function_call stay in one CC assistant turn', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: [
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Let me call a tool.' }],
        },
        {
          type: 'function_call',
          id: 'fc_call_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"q":"weather"}',
          status: 'completed',
        },
      ],
    })

    expect(result.messages).toEqual([
      {
        role: 'assistant',
        content: 'Let me call a tool.',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"weather"}' },
          },
        ],
      },
    ])
  })

  test('Responses input_text and input_image map back to CC content parts', () => {
    const result = translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Look at this' },
            { type: 'input_image', image_url: 'https://example.com/dog.png', detail: 'low' },
          ],
        },
      ],
    })

    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this' },
          { type: 'image_url', image_url: { url: 'https://example.com/dog.png', detail: 'low' } },
        ],
      },
    ])
  })

  test('unsupported Responses input items fail with a clear translation error', () => {
    expect(() => translateResponsesRequestToCC({
      model: 'claude-opus-4.6',
      input: [
        {
          type: 'reasoning',
          encrypted_content: 'opaque-reasoning-state',
        },
      ],
    })).toThrow('Unsupported Responses input item type "reasoning" for chat-completions translation')
  })

  test('failed Responses response throws instead of looking successful', () => {
    expect(() => translateResponsesResponseToCC({
      id: 'resp_failed',
      object: 'response',
      model: 'gpt-5.4',
      output: [],
      status: 'failed',
      error: { message: 'backend exploded', type: 'server_error', code: 'boom' },
    })).toThrow('backend exploded')
  })
})
