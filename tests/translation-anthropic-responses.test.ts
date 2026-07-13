import type { AnthropicMessagesPayload, AnthropicResponse } from '../src/lib/translation/types'
import type { ResponsesPayload, ResponsesResponse } from '../src/services/copilot/create-responses'

import { describe, expect, test } from 'bun:test'

import {
  createAnthropicToResponsesStreamState,
  translateAnthropicRequestToResponses,
  translateAnthropicResponseToResponses,
  translateAnthropicStreamEventToResponses,
} from '../src/lib/translation/anthropic-to-responses'
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
    expect(result.store).toBe(false)
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

  test('mid-conversation system message → developer input message', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'system', content: 'Use the Skill tool when needed.' },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'developer', content: 'Use the Skill tool when needed.' },
    ])
  })

  test('max_tokens below the Responses minimum is rejected instead of increased', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'Hi' }],
    }

    expect(() => translateAnthropicRequestToResponses(payload)).toThrow(
      'max_tokens must be at least 16',
    )
  })

  test('metadata is preserved on translated Responses requests', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      metadata: { user_id: 'user-123' },
      messages: [{ role: 'user', content: 'Hi' }],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.metadata).toEqual({ user_id: 'user-123' })
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

  test('tool_use and tool_result cache_control are accepted but not emitted on Responses input items', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_cache',
              name: 'lookup',
              input: { id: 1 },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_cache',
              content: 'cached result',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      {
        type: 'function_call',
        id: 'fc_toolu_cache',
        call_id: 'toolu_cache',
        name: 'lookup',
        arguments: '{"id":1}',
        status: 'completed',
      },
      {
        type: 'function_call_output',
        call_id: 'toolu_cache',
        output: 'cached result',
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

  test('assistant history preserves interleaved tool_use and text block order', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Before tool.' },
          { type: 'tool_use', id: 'toolu_first', name: 'first', input: { n: 1 } },
          { type: 'text', text: 'Between tools.' },
          { type: 'tool_use', id: 'toolu_second', name: 'second', input: { n: 2 } },
          { type: 'text', text: 'After tools.' },
        ],
      }],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'Before tool.' }] },
      {
        type: 'function_call',
        id: 'fc_toolu_first',
        call_id: 'toolu_first',
        name: 'first',
        arguments: '{"n":1}',
        status: 'completed',
      },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Between tools.' }] },
      {
        type: 'function_call',
        id: 'fc_toolu_second',
        call_id: 'toolu_second',
        name: 'second',
        arguments: '{"n":2}',
        status: 'completed',
      },
      { role: 'assistant', content: [{ type: 'output_text', text: 'After tools.' }] },
    ])
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

  test('custom tools with type=custom are translated to Responses function tools', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Call tool' }],
      tools: [
        {
          type: 'custom',
          name: 'typed_custom',
          input_schema: { type: 'object', properties: {} },
        } as never,
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.tools).toEqual([
      {
        type: 'function',
        name: 'typed_custom',
        parameters: { type: 'object', properties: {} },
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

  test('Anthropic max effort is preserved for GPT-5.6 Responses', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.6-sol',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: { effort: 'max' },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.reasoning).toEqual({ effort: 'max' })
  })

  test('disabled thinking maps to Responses reasoning effort none', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      thinking: { type: 'disabled' },
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.reasoning).toEqual({ effort: 'none' })
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

  test('user history preserves interleaved text and tool_result block order', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Before result.' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'first result' },
          { type: 'text', text: 'Between results.' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'second result' },
          { type: 'text', text: 'After results.' },
        ],
      }],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Before result.' }] },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'first result' },
      { role: 'user', content: [{ type: 'input_text', text: 'Between results.' }] },
      { type: 'function_call_output', call_id: 'toolu_2', output: 'second result' },
      { role: 'user', content: [{ type: 'input_text', text: 'After results.' }] },
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

  test('omitted tool_result content becomes an empty function_call_output', () => {
    const result = translateAnthropicRequestToResponses({
      model: 'gpt-5.4',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_empty' }],
      }],
    })

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'toolu_empty',
      output: '',
    }])
  })

  test('mixed text and base64 image tool_result content becomes rich function_call_output', () => {
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
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
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
        output: [
          { type: 'input_text', text: 'Screenshot attached' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
          },
        ],
      },
    ])
  })

  test('rich tool_result is_error keeps the Copilot-compatible string envelope', () => {
    const content = [
      { type: 'text' as const, text: 'Screenshot failed' },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png' as const,
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        },
      },
    ]
    const result = translateAnthropicRequestToResponses({
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_rich_error',
          content,
          is_error: true,
        }],
      }],
    })

    expect(result.input).toEqual([{
      type: 'function_call_output',
      call_id: 'toolu_rich_error',
      output: JSON.stringify({
        is_error: true,
        content: JSON.stringify(content),
      }),
      status: 'incomplete',
    }])
  })

  test('tool_result is_error is preserved without an unsupported top-level Responses field', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_error',
              content: 'file not found',
              is_error: true,
            },
          ],
        },
      ],
    }

    const result = translateAnthropicRequestToResponses(payload)
    expect(result.input).toEqual([
      {
        type: 'function_call_output',
        call_id: 'toolu_error',
        output: JSON.stringify({ is_error: true, content: 'file not found' }),
        status: 'incomplete',
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

  test('json_schema without an object schema is rejected on the Responses translation path', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: {
        format: {
          type: 'json_schema',
        },
      },
    }

    expect(() => translateAnthropicRequestToResponses(payload)).toThrow(
      'output_config.format.type="json_schema" requires an object "schema"',
    )
  })

  test('unknown output format is rejected on the Responses translation path', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-5.4',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      output_config: {
        format: {
          type: 'future_format',
        },
      },
    }

    expect(() => translateAnthropicRequestToResponses(payload)).toThrow(
      'output_config.format.type="future_format" cannot be represented',
    )
  })
})

describe('translateResponsesRequestToAnthropic', () => {
  test('json_schema structured output is forwarded to native Anthropic output_config in flat shape', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      store: false,
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
      store: false,
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
      store: false,
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
      store: false,
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

  test('json_object structured output is rejected instead of returning schema-unconstrained success', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      store: false,
      input: 'Return JSON.',
      text: {
        format: {
          type: 'json_object',
        },
      },
    }

    expect(() => translateResponsesRequestToAnthropic(payload)).toThrow(
      'text.format.type="json_object" cannot be represented',
    )
  })

  test('reasoning.effort none disables thinking on native Anthropic requests', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      store: false,
      input: 'Hi',
      reasoning: { effort: 'none' },
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.output_config).toBeUndefined()
    expect(result.thinking).toEqual({ type: 'disabled' })
  })

  test('reasoning.effort minimal is downgraded to low on native Anthropic requests', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      store: false,
      input: 'Hi',
      reasoning: { effort: 'minimal' },
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.output_config).toEqual({ effort: 'low' })
  })

  test('reasoning.effort xhigh is preserved on native Anthropic requests', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.7',
      store: false,
      input: 'Hi',
      reasoning: { effort: 'xhigh' },
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.output_config).toEqual({ effort: 'xhigh' })
  })

  test('replayed Responses reasoning input items are ignored on native Anthropic requests', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      store: false,
      input: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'prior reasoning' }],
        } as never,
        { role: 'user', content: 'Continue.' },
      ],
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Continue.' }],
      },
    ])
  })

  test('unknown user and assistant content parts are rejected instead of reinterpreted as text', () => {
    for (const role of ['user', 'assistant'] as const) {
      const payload: ResponsesPayload = {
        model: 'claude-opus-4.6',
        store: false,
        input: [{
          role,
          content: [{ type: 'input_audio', audio: 'opaque' }],
        }],
      }

      expect(() => translateResponsesRequestToAnthropic(payload)).toThrow(
        `Unsupported Responses ${role} content part type "input_audio"`,
      )
    }
  })

  test('function_call_output error metadata becomes Anthropic is_error', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      store: false,
      input: [
        {
          type: 'function_call_output',
          call_id: 'toolu_error',
          output: JSON.stringify({ is_error: true, content: 'file not found' }),
          status: 'incomplete',
          is_error: true,
        },
      ],
    }

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_error',
            content: 'file not found',
            is_error: true,
          },
        ],
      },
    ])
  })

  test('invalid replayed function arguments are rejected instead of becoming an empty tool input', () => {
    expect(() => translateResponsesRequestToAnthropic({
      model: 'claude-opus-4.8',
      store: false,
      input: [{
        type: 'function_call',
        call_id: 'call_invalid',
        name: 'noop',
        arguments: '{not-json',
      }],
    })).toThrow(/must be valid JSON encoding an object/)
  })

  test('rich function_call_output text and base64 image parts become native Anthropic blocks', () => {
    const payload = {
      model: 'claude-opus-4.8',
      store: false,
      stream: null,
      instructions: null,
      input: [{
        type: 'function_call_output',
        call_id: 'toolu_rich',
        output: [
          { type: 'input_text', text: 'visual result' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      }],
    } as unknown as ResponsesPayload

    const result = translateResponsesRequestToAnthropic(payload)
    expect(result).not.toHaveProperty('system')
    expect(result).not.toHaveProperty('stream')
    expect(result.messages).toEqual([{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_rich',
        content: [
          { type: 'text', text: 'visual result' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      }],
    }])
  })

  test('rich function_call_output input_file is rejected instead of producing an invalid Anthropic block', () => {
    const payload = {
      model: 'claude-opus-4.8',
      store: false,
      input: [{
        type: 'function_call_output',
        call_id: 'toolu_file',
        output: [{ type: 'input_file', file_id: 'file_1' }],
      }],
    } as unknown as ResponsesPayload

    expect(() => translateResponsesRequestToAnthropic(payload)).toThrow(
      /input_file/,
    )
  })

  test('rich function_call_output image file_id is rejected with a base64 remediation', () => {
    const payload = {
      model: 'claude-opus-4.8',
      store: false,
      input: [{
        type: 'function_call_output',
        call_id: 'toolu_image_file',
        output: [{ type: 'input_image', file_id: 'file_1' }],
      }],
    } as unknown as ResponsesPayload

    expect(() => translateResponsesRequestToAnthropic(payload)).toThrow(
      /Provide a base64 data URL/,
    )
  })

  test('tool strict is forwarded to native Anthropic tools', () => {
    const payload: ResponsesPayload = {
      model: 'claude-opus-4.6',
      store: false,
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

  test('prefix instructions become top-level system and valid mid-conversation instructions keep position', () => {
    const result = translateResponsesRequestToAnthropic({
      model: 'claude-opus-4.6',
      store: false,
      instructions: 'Global instruction.',
      input: [
        { role: 'developer', content: 'Initial developer instruction.' },
        { role: 'user', content: 'First user turn.' },
        { role: 'developer', content: 'Use the updated policy.' },
        { role: 'system', content: 'Final local instruction.' },
        { role: 'assistant', content: 'Acknowledged.' },
        { role: 'user', content: 'Continue.' },
      ],
    })

    expect(result.system).toBe('Global instruction.\n\nInitial developer instruction.')
    expect(result.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'First user turn.' }] },
      { role: 'system', content: 'Use the updated policy.\n\nFinal local instruction.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Acknowledged.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Continue.' }] },
    ])
  })

  test('rejects a system/developer message after assistant output instead of changing its position', () => {
    expect(() => translateResponsesRequestToAnthropic({
      model: 'claude-opus-4.6',
      store: false,
      input: [
        { role: 'user', content: 'First user turn.' },
        { role: 'assistant', content: 'First assistant turn.' },
        { role: 'developer', content: 'Late instruction.' },
      ],
    })).toThrow(/immediately after a user\/tool-result turn/)
  })

  test('rejects a mid-conversation system/developer message followed by a user turn', () => {
    expect(() => translateResponsesRequestToAnthropic({
      model: 'claude-opus-4.8',
      store: false,
      input: [
        { role: 'user', content: 'First user turn.' },
        { role: 'developer', content: 'Mid-conversation instruction.' },
        { role: 'user', content: 'This placement is invalid upstream.' },
      ],
    })).toThrow(/must precede an assistant turn or end/)
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

  for (const status of ['queued', 'in_progress', 'cancelled'] as const) {
    test(`does not report Responses status ${status} as a completed Anthropic turn`, () => {
      expect(() => translateResponsesResponseToAnthropic({
        id: `resp_${status}`,
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status,
      })).toThrow(`Responses status "${status}" cannot be represented`)
    })
  }

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

  test('invalid upstream function arguments fail instead of producing tool_use input={}', () => {
    expect(() => translateResponsesResponseToAnthropic({
      id: 'resp_invalid_args',
      object: 'response',
      model: 'gpt-5.4',
      output: [{
        type: 'function_call',
        call_id: 'call_invalid',
        name: 'noop',
        arguments: '[]',
      }],
      status: 'completed',
    })).toThrow(/must decode to a JSON object/)
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
    expect(result.usage.input_tokens).toBe(20)
    expect(result.usage.cache_read_input_tokens).toBe(80)
  })
})

describe('additional Anthropic ↔ Responses coverage', () => {
  test('translated response envelopes distinguish nullable request values from resolved defaults', () => {
    const translated = translateAnthropicResponseToResponses({
      id: 'msg_nullable_request_context',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.8',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }, {
      requestContext: {
        instructions: null,
        max_output_tokens: null,
        metadata: null,
        parallel_tool_calls: null,
        reasoning: null,
        temperature: null,
        text: undefined,
        tool_choice: undefined,
        tools: undefined,
        top_p: null,
      },
    })

    expect(translated).toMatchObject({
      instructions: null,
      max_output_tokens: null,
      metadata: null,
      parallel_tool_calls: true,
      reasoning: null,
      temperature: null,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: [],
      top_p: null,
    })
  })

  test('Anthropic thinking stays in a reasoning output item, not top-level reasoning.summary', () => {
    const response: AnthropicResponse = {
      id: 'msg_reasoning_contract',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.8',
      content: [
        { type: 'thinking', thinking: 'Reasoning summary', signature: 'sig' },
        { type: 'text', text: 'Final answer' },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 4, output_tokens: 6 },
    }

    const translated = translateAnthropicResponseToResponses(response)

    expect(translated.reasoning).toEqual({ effort: null, summary: null })
    expect(translated.output).toContainEqual({
      type: 'reasoning',
      id: expect.stringMatching(/^rs_/),
      summary: [{ type: 'summary_text', text: 'Reasoning summary' }],
    })
  })

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

  test('Anthropic text citations are preserved on Responses output_text parts', () => {
    const result = translateAnthropicResponseToResponses({
      id: 'msg_citations',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.6',
      content: [
        {
          type: 'text',
          text: 'Paris',
          citations: [{ type: 'char_location', start_char_index: 0, end_char_index: 5 }],
        },
      ],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    })

    expect(result.output[0]?.content?.[0]).toEqual({
      type: 'output_text',
      text: 'Paris',
      annotations: [],
      citations: [{ type: 'char_location', start_char_index: 0, end_char_index: 5 }],
    })
  })

  test('Anthropic cache usage is converted to inclusive Responses input tokens', () => {
    const result = translateAnthropicResponseToResponses({
      id: 'msg_cache_usage',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.8',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 80,
        output_tokens: 5,
      },
    })

    expect(result.usage).toEqual({
      input_tokens: 130,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens: 5,
      total_tokens: 135,
    })
    expect(result.store).toBe(false)
    expect(result).toMatchObject({
      temperature: 1,
      top_p: 1,
      parallel_tool_calls: true,
      tool_choice: 'auto',
      tools: [],
    })
  })

  test('streamed Anthropic cache usage is converted to inclusive Responses input tokens', () => {
    const state = createAnthropicToResponsesStreamState()

    translateAnthropicStreamEventToResponses({
      type: 'message_start',
      message: {
        id: 'msg_stream_cache_usage',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4.8',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 80,
          output_tokens: 0,
        },
      },
    }, state)
    translateAnthropicStreamEventToResponses({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    }, state)
    const events = translateAnthropicStreamEventToResponses({ type: 'message_stop' }, state)
    const terminal = events.at(-1)

    expect(terminal?.type).toBe('response.completed')
    if (terminal?.type !== 'response.completed') {
      throw new Error('expected response.completed')
    }
    expect(terminal.response.usage).toEqual({
      input_tokens: 130,
      input_tokens_details: { cached_tokens: 80 },
      output_tokens: 5,
      total_tokens: 135,
    })
    expect(terminal.response.store).toBe(false)
  })

  test('Anthropic citations_delta stream events are accepted without Responses delta mapping', () => {
    const state = createAnthropicToResponsesStreamState()

    translateAnthropicStreamEventToResponses({
      type: 'message_start',
      message: {
        id: 'msg_stream_citations',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4.7',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 0,
        },
      },
    }, state)
    translateAnthropicStreamEventToResponses({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }, state)

    const citationEvents = translateAnthropicStreamEventToResponses({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: { type: 'char_location', start_char_index: 0, end_char_index: 5 },
      },
    }, state)
    expect(citationEvents).toEqual([])

    const textEvents = translateAnthropicStreamEventToResponses({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Paris' },
    }, state)
    expect(textEvents).toContainEqual({
      type: 'response.output_text.delta',
      item_id: 'msg_msg_stream_citations_0',
      output_index: 0,
      content_index: 0,
      delta: 'Paris',
      logprobs: [],
      sequence_number: 4,
    })
  })

  test('generated Responses stream events follow the official sequence and output contracts', () => {
    const state = createAnthropicToResponsesStreamState()
    const events = [
      ...translateAnthropicStreamEventToResponses({
        type: 'message_start',
        message: {
          id: 'msg_contract',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-opus-4.8',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 0 },
        },
      }, state),
      ...translateAnthropicStreamEventToResponses({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }, state),
      ...translateAnthropicStreamEventToResponses({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      }, state),
      ...translateAnthropicStreamEventToResponses({
        type: 'content_block_stop',
        index: 0,
      }, state),
      ...translateAnthropicStreamEventToResponses({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'toolu_contract',
          name: 'lookup',
          input: {},
        },
      }, state),
      ...translateAnthropicStreamEventToResponses({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"id":1}' },
      }, state),
      ...translateAnthropicStreamEventToResponses({
        type: 'content_block_stop',
        index: 1,
      }, state),
      ...translateAnthropicStreamEventToResponses({
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 8 },
      }, state),
      ...translateAnthropicStreamEventToResponses({ type: 'message_stop' }, state),
    ]

    expect(events.map(event => event.sequence_number)).toEqual(
      events.map((_, index) => index),
    )

    const textEvents = events.filter(event =>
      event.type === 'response.output_text.delta' || event.type === 'response.output_text.done')
    expect(textEvents).toHaveLength(2)
    expect(textEvents.every(event => event.logprobs.length === 0)).toBe(true)

    const functionDone = events.find(event => event.type === 'response.function_call_arguments.done')
    expect(functionDone).toMatchObject({
      name: 'lookup',
      arguments: '{"id":1}',
    })

    const completed = events.find(event => event.type === 'response.completed')
    expect(completed).toMatchObject({
      response: {
        temperature: 1,
        top_p: 1,
        parallel_tool_calls: true,
        tool_choice: 'auto',
        tools: [],
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'hello', annotations: [] }],
          },
          {
            type: 'function_call',
            name: 'lookup',
          },
        ],
      },
    })
  })

  test('pre-start Anthropic errors use the official top-level Responses error event shape', () => {
    const state = createAnthropicToResponsesStreamState()
    const events = translateAnthropicStreamEventToResponses({
      type: 'error',
      error: { type: 'overloaded_error', message: 'try again later' },
    }, state)

    expect(JSON.parse(JSON.stringify(events))).toEqual([{
      type: 'error',
      code: 'overloaded_error',
      message: 'try again later',
      param: null,
      sequence_number: 0,
    }])
  })
})
