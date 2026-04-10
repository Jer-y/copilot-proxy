import type { AnthropicMessagesPayload } from '../src/lib/translation/types'
import type { ResponsesPayload, ResponsesResponse } from '../src/services/copilot/create-responses'

import { describe, expect, test } from 'bun:test'

import { translateAnthropicRequestToResponses } from '../src/lib/translation/anthropic-to-responses'
import { translateResponsesRequestToAnthropic, translateResponsesResponseToAnthropic } from '../src/lib/translation/responses-to-anthropic'

// ─── T7: Anthropic Request → Responses Request ──────────────────

describe('translateAnthropicRequestToResponses', () => {
  test('basic text message', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.model).toBe('gpt-5.4')
    expect(result.max_output_tokens).toBe(1024)
    expect(result.input).toEqual([
      { role: 'user', content: 'Hello' },
    ])
  })

  test('system string → instructions', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'Hi' },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.instructions).toBe('You are helpful.')
  })

  test('system text blocks → merged instructions', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      system: [
        { type: 'text', text: 'First instruction.' },
        { type: 'text', text: 'Second instruction.' },
      ],
      messages: [
        { role: 'user', content: 'Hi' },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.instructions).toBe('First instruction.\n\nSecond instruction.')
  })

  test('max_tokens clamped to minimum 16', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.max_output_tokens).toBe(16)
  })

  test('tool_use → function_call items', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'get_weather',
              input: { city: 'NYC' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_123',
              content: '{"temp": 72}',
            },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      { role: 'user', content: 'What is the weather?' },
      {
        type: 'function_call',
        id: 'fc_toolu_123',
        call_id: 'toolu_123',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'toolu_123',
        output: '{"temp": 72}',
      },
    ])
  })

  test('assistant text + tool_use → separate items', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check...' },
            {
              type: 'tool_use',
              id: 'toolu_456',
              name: 'search',
              input: { q: 'weather' },
            },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    // Text becomes assistant message, tool_use becomes function_call
    expect(result.input).toHaveLength(3)
    expect((result.input as Array<Record<string, unknown>>)[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Let me check...' }],
    })
    expect((result.input as Array<Record<string, unknown>>)[2]).toMatchObject({
      type: 'function_call',
      call_id: 'toolu_456',
      name: 'search',
    })
  })

  test('assistant thinking blocks are not merged into visible assistant text', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Internal reasoning that should stay hidden.' },
            { type: 'text', text: 'Visible answer.' },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      { role: 'user', content: 'Hi' },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Visible answer.' }],
      },
    ])
  })

  test('tools translated (input_schema → parameters)', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather info',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather info',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ])
  })

  test('Anthropic tool strict is preserved on Responses tools', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'strict_weather',
          description: 'Get weather info',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          strict: true,
        },
        {
          name: 'loose_weather',
          description: 'Get forecast info',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          strict: false,
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'strict_weather',
        description: 'Get weather info',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
        strict: true,
      },
      {
        type: 'function',
        name: 'loose_weather',
        description: 'Get forecast info',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
        strict: false,
      },
    ])
  })

  test('Claude tool cache_control is forwarded to Responses tools when supported', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-opus-4.6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather info',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          cache_control: { type: 'ephemeral' },
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get weather info',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
        copilot_cache_control: { type: 'ephemeral' },
      },
    ])
  })

  test('should ignore top-level cache_control on Responses path', () => {
    const result = translateAnthropicRequestToResponses({
      model: 'claude-sonnet-4',
      max_tokens: 100,
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: 'Hi' }],
    })
    // top-level cache_control should not appear in the Responses output
    expect((result as any).cache_control).toBeUndefined()
  })

  test('thinking.display is not representable in Responses format', () => {
    const result = translateAnthropicRequestToResponses({
      model: 'claude-sonnet-4.6',
      max_tokens: 8192,
      thinking: { type: 'adaptive', display: 'omitted' },
      messages: [{ role: 'user', content: 'Hi' }],
    })
    // Responses API has no display concept — reasoning should still be mapped
    expect(result.reasoning).toBeDefined()
    // display should not leak into the Responses output
    expect((result.reasoning as any)?.display).toBeUndefined()
  })

  test('tool_choice mappings', () => {
    const base: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    expect(translateAnthropicRequestToResponses({ ...base, tool_choice: { type: 'auto' } }).tool_choice).toBe('auto')
    expect(translateAnthropicRequestToResponses({ ...base, tool_choice: { type: 'any' } }).tool_choice).toBe('required')
    expect(translateAnthropicRequestToResponses({ ...base, tool_choice: { type: 'none' } }).tool_choice).toBe('none')
    expect(translateAnthropicRequestToResponses({ ...base, tool_choice: { type: 'tool', name: 'foo' } }).tool_choice).toEqual({ type: 'function', name: 'foo' })
  })

  test('disable_parallel_tool_use → parallel_tool_calls false', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: {
        type: 'auto',
        disable_parallel_tool_use: true,
      },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.parallel_tool_calls).toBe(false)
  })

  test('adaptive thinking uses the model default reasoning effort', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'adaptive' },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.reasoning).toEqual({ effort: 'high' })
  })

  test('Anthropic max effort is adapted to Responses xhigh', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'max' },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.reasoning).toEqual({ effort: 'xhigh' })
  })

  test('disabled thinking omits reasoning hints', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'disabled' },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.reasoning).toBeUndefined()
  })

  test('user message with mixed text and tool_result', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result1' },
            { type: 'text', text: 'And also...' },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    // tool_result comes first as function_call_output, then text as user message
    expect(result.input).toEqual([
      { type: 'function_call_output', call_id: 'toolu_1', output: 'result1' },
      { role: 'user', content: [{ type: 'input_text', text: 'And also...' }] },
    ])
  })

  test('URL-based images are translated to input_image.image_url', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'url',
                url: 'https://example.com/cat.png',
              },
            },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'input_image',
            image_url: 'https://example.com/cat.png',
          },
        ],
      },
    ])
  })

  test('structured text-only tool_result content is flattened for function_call_output', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [
                { type: 'text', text: 'Part one' },
                { type: 'text', text: 'Part two' },
              ],
            },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'toolu_1',
        output: 'Part one\n\nPart two',
      },
    ])
  })

  test('mixed tool_result content falls back to JSON for function_call_output', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_2',
              content: [
                { type: 'text', text: 'Screenshot attached' },
                {
                  type: 'image',
                  source: {
                    type: 'url',
                    url: 'https://example.com/result.png',
                  },
                },
              ],
            },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'toolu_2',
        output: JSON.stringify([
          { type: 'text', text: 'Screenshot attached' },
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://example.com/result.png',
            },
          },
        ]),
      },
    ])
  })

  test('output_config.format json_object is mapped to Responses text.format', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: {
        effort: 'high',
        format: {
          type: 'json_object',
        },
      },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.reasoning).toEqual({ effort: 'high' })
    expect(result.text).toEqual({ format: { type: 'json_object' } })
  })

  test('should map json_schema output_config.format to flat Responses text.format', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: {
        effort: 'high',
        format: {
          type: 'json_schema',
          name: 'sample',
          schema: {
            type: 'object',
            properties: {
              answer: { type: 'string' },
            },
            required: ['answer'],
          },
        },
      },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.reasoning).toEqual({ effort: 'high' })
    expect(result.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'sample',
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
    })
  })

  test('legacy nested json_schema input is normalized to flat Responses text.format', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: {
        format: {
          type: 'json_schema',
          json_schema: {
            name: 'legacy',
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
              },
              required: ['ok'],
            },
          },
        },
      },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'legacy',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      },
    })
  })
})

describe('translateResponsesRequestToAnthropic', () => {
  test('json_schema structured output is forwarded to native Anthropic output_config in flat shape', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      input: 'Return JSON.',
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
          },
        },
      },
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.output_config).toEqual({
      format: {
        type: 'json_schema',
        name: 'answer',
        schema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
        },
      },
    })
  })

  test('nested json_schema input is normalized to Anthropic flat schema shape', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      input: 'Return JSON.',
      text: {
        format: {
          type: 'json_schema',
          json_schema: {
            name: 'answer',
            schema: {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
              required: ['value'],
            },
          },
        },
      },
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.output_config).toEqual({
      format: {
        type: 'json_schema',
        name: 'answer',
        schema: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
        },
      },
    })
  })

  test('json_schema without schema is rejected instead of being passed through', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      input: 'Return JSON.',
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
        },
      },
    }

    expect(() => translateResponsesRequestToAnthropic(payload)).toThrow(
      'Responses text.format.type="json_schema" requires an object "schema"',
    )
  })

  test('conflicting strict locations are rejected instead of guessed', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      input: 'Return JSON.',
      text: {
        format: {
          type: 'json_schema',
          strict: true,
          json_schema: {
            strict: false,
            schema: {
              type: 'object',
              properties: {
                value: { type: 'string' },
              },
              required: ['value'],
            },
          },
        },
      },
    }

    expect(() => translateResponsesRequestToAnthropic(payload)).toThrow(
      'Responses text.format for json_schema must use either "strict" or "json_schema.strict", not both',
    )
  })

  test('json_object structured output is not emitted on native Anthropic requests', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      input: 'Return JSON.',
      text: {
        format: {
          type: 'json_object',
        },
      },
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.output_config).toBeUndefined()
  })

  test('tool strict is forwarded to native Anthropic tools', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      input: 'Call tools as needed.',
      tools: [
        {
          type: 'function',
          name: 'strict_true_tool',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          strict: true,
        },
        {
          type: 'function',
          name: 'strict_false_tool',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          strict: false,
        },
        {
          type: 'function',
          name: 'no_strict_tool',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.tools).toEqual([
      {
        name: 'strict_true_tool',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
        strict: true,
      },
      {
        name: 'strict_false_tool',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        strict: false,
      },
      {
        name: 'no_strict_tool',
        input_schema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    ])
  })
})

// ─── T8: Responses Response → Anthropic Response ────────────────

describe('translateResponsesResponseToAnthropic', () => {
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

    const result = translateResponsesResponseToAnthropic(response)
    expect(result.id).toBe('resp_123')
    expect(result.type).toBe('message')
    expect(result.role).toBe('assistant')
    expect(result.model).toBe('gpt-5.4-2026-03-05')
    expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }])
    expect(result.stop_reason).toBe('end_turn')
    expect(result.usage.input_tokens).toBe(10)
    expect(result.usage.output_tokens).toBe(5)
  })

  test('function_call → tool_use content', () => {
    const response: ResponsesResponse = {
      id: 'resp_456',
      object: 'response',
      model: 'gpt-5.4',
      output: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'toolu_abc',
          name: 'get_weather',
          arguments: '{"city":"NYC"}',
        },
      ],
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    }

    const result = translateResponsesResponseToAnthropic(response)
    expect(result.content).toEqual([
      {
        type: 'tool_use',
        id: 'toolu_abc',
        name: 'get_weather',
        input: { city: 'NYC' },
      },
    ])
    expect(result.stop_reason).toBe('tool_use')
  })

  test('incomplete status → max_tokens stop_reason', () => {
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

    const result = translateResponsesResponseToAnthropic(response)
    expect(result.stop_reason).toBe('max_tokens')
  })

  test('content_filter incomplete status maps to refusal stop_reason', () => {
    const response: ResponsesResponse = {
      id: 'resp_refusal',
      object: 'response',
      model: 'gpt-5.4',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Filtered...' }],
        },
      ],
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
    }

    const result = translateResponsesResponseToAnthropic(response)
    expect(result.stop_reason).toBe('refusal')
  })

  test('incomplete without reason maps to pause_turn stop_reason', () => {
    const response: ResponsesResponse = {
      id: 'resp_pause_turn',
      object: 'response',
      model: 'gpt-5.4',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Continue this turn later.' }],
        },
      ],
      status: 'incomplete',
      incomplete_details: null,
    }

    const result = translateResponsesResponseToAnthropic(response)
    expect(result.stop_reason).toBe('pause_turn')
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
          call_id: 'toolu_def',
          name: 'search',
          arguments: '{"q":"weather"}',
        },
      ],
      status: 'completed',
    }

    const result = translateResponsesResponseToAnthropic(response)
    expect(result.content).toHaveLength(2)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Let me check...' })
    expect(result.content[1]).toMatchObject({ type: 'tool_use', name: 'search' })
    expect(result.stop_reason).toBe('tool_use')
  })

  test('reasoning summaries are omitted instead of replaying unsigned Anthropic thinking blocks', () => {
    const response: ResponsesResponse = {
      id: 'resp_reason',
      object: 'response',
      model: 'gpt-5.4',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Thinking about it...' }],
        },
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'The answer is 42.' }],
        },
      ],
      status: 'completed',
    }

    const result = translateResponsesResponseToAnthropic(response)
    expect(result.content).toEqual([
      { type: 'text', text: 'The answer is 42.' },
    ])
  })

  test('cached tokens mapped to cache_read_input_tokens', () => {
    const response: ResponsesResponse = {
      id: 'resp_cache',
      object: 'response',
      model: 'gpt-5.4',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Hi' }] },
      ],
      status: 'completed',
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        input_tokens_details: { cached_tokens: 80 },
      },
    }

    const result = translateResponsesResponseToAnthropic(response)
    expect(result.usage.cache_read_input_tokens).toBe(80)
  })
})

describe('additional Anthropic ↔ Responses coverage', () => {
  test('model override is respected for routing-aligned payloads', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    const result = translateAnthropicRequestToResponses(payload, { model: 'gpt-5.4-fast' })
    expect(result.model).toBe('gpt-5.4-fast')
  })

  test('failed Responses response throws instead of returning a fake Anthropic success', () => {
    expect(() => translateResponsesResponseToAnthropic({
      id: 'resp_failed',
      object: 'response',
      model: 'gpt-5.4',
      output: [],
      status: 'failed',
      error: { message: 'backend exploded', type: 'server_error' },
    })).toThrow('backend exploded')
  })
})
