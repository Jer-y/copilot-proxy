import type { AnthropicMessagesPayload } from '~/routes/messages/anthropic-types'
import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import { translateToOpenAI } from '../src/routes/messages/non-stream-translation'

// Zod schema for a single message in the chat completion request.
const messageSchema = z.object({
  role: z.enum([
    'system',
    'user',
    'assistant',
    'tool',
    'function',
    'developer',
  ]),
  content: z.union([z.string(), z.object({}), z.array(z.any())]),
  name: z.string().optional(),
  tool_calls: z.array(z.any()).optional(),
  tool_call_id: z.string().optional(),
})

// Zod schema for the entire chat completion request payload.
// This is derived from the openapi.documented.yml specification.
const chatCompletionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1, 'Messages array cannot be empty.'),
  model: z.string(),
  frequency_penalty: z.number().min(-2).max(2).optional().nullable(),
  logit_bias: z.record(z.string(), z.number()).optional().nullable(),
  logprobs: z.boolean().optional().nullable(),
  top_logprobs: z.number().int().min(0).max(20).optional().nullable(),
  max_tokens: z.number().int().optional().nullable(),
  n: z.number().int().min(1).max(128).optional().nullable(),
  presence_penalty: z.number().min(-2).max(2).optional().nullable(),
  response_format: z
    .object({
      type: z.enum(['text', 'json_object', 'json_schema']),
      json_schema: z.object({}).optional(),
    })
    .optional(),
  seed: z.number().int().optional().nullable(),
  stop: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .nullable(),
  stream: z.boolean().optional().nullable(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  top_p: z.number().min(0).max(1).optional().nullable(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.union([z.string(), z.object({})]).optional(),
  user: z.string().optional(),
})

/**
 * Validates if a request payload conforms to the OpenAI Chat Completion v1 shape using Zod.
 * @param payload The request payload to validate.
 * @returns True if the payload is valid, false otherwise.
 */
function isValidChatCompletionRequest(payload: unknown): boolean {
  const result = chatCompletionRequestSchema.safeParse(payload)
  return result.success
}

describe('Anthropic to OpenAI translation logic', () => {
  test('should translate minimal Anthropic payload to valid OpenAI payload', () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 0,
    }

    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test('should translate comprehensive Anthropic payload to valid OpenAI payload', () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: 'gpt-4o',
      system: 'You are a helpful assistant.',
      messages: [
        { role: 'user', content: 'What is the weather like in Boston?' },
        {
          role: 'assistant',
          content: 'The weather in Boston is sunny and 75°F.',
        },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      stream: false,
      metadata: { user_id: 'user-123' },
      tools: [
        {
          name: 'getWeather',
          description: 'Gets weather info',
          input_schema: { location: { type: 'string' } },
        },
      ],
      tool_choice: { type: 'auto' },
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test('should handle missing fields gracefully', () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 0,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)
  })

  test('should handle invalid types in Anthropic payload', () => {
    const anthropicPayload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
      temperature: 'hot', // Should be a number
    }
    // @ts-expect-error intended to be invalid
    const openAIPayload = translateToOpenAI(anthropicPayload)
    // Should fail validation
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(false)
  })

  test('should handle thinking blocks in assistant messages', () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Let me think about this simple math problem...',
            },
            { type: 'text', text: '2+2 equals 4.' },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is combined with text content
    const assistantMessage = openAIPayload.messages.find(
      m => m.role === 'assistant',
    )
    expect(assistantMessage?.content).toContain(
      'Let me think about this simple math problem...',
    )
    expect(assistantMessage?.content).toContain('2+2 equals 4.')
  })

  test('should handle thinking blocks with tool calls', () => {
    const anthropicPayload: AnthropicMessagesPayload = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        { role: 'user', content: 'What\'s the weather?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking:
                'I need to call the weather API to get current weather information.',
            },
            { type: 'text', text: 'I\'ll check the weather for you.' },
            {
              type: 'tool_use',
              id: 'call_123',
              name: 'get_weather',
              input: { location: 'New York' },
            },
          ],
        },
      ],
      max_tokens: 100,
    }
    const openAIPayload = translateToOpenAI(anthropicPayload)
    expect(isValidChatCompletionRequest(openAIPayload)).toBe(true)

    // Check that thinking content is included in the message content
    const assistantMessage = openAIPayload.messages.find(
      m => m.role === 'assistant',
    )
    expect(assistantMessage?.content).toContain(
      'I need to call the weather API',
    )
    expect(assistantMessage?.content).toContain(
      'I\'ll check the weather for you.',
    )
    expect(assistantMessage?.tool_calls).toHaveLength(1)
    expect(assistantMessage?.tool_calls?.[0].function.name).toBe('get_weather')
  })
})

describe('Model name normalization via translateToOpenAI', () => {
  const makePayload = (model: string): AnthropicMessagesPayload => ({
    model,
    messages: [{ role: 'user', content: 'Hello!' }],
    max_tokens: 100,
  })

  test('should normalize claude-sonnet-4-20250514 to claude-sonnet-4', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4-20250514'))
    expect(result.model).toBe('claude-sonnet-4')
  })

  test('should normalize claude-opus-4-20250514 to claude-opus-4', () => {
    const result = translateToOpenAI(makePayload('claude-opus-4-20250514'))
    expect(result.model).toBe('claude-opus-4')
  })

  test('should normalize claude-haiku-4-20250514 to claude-haiku-4', () => {
    const result = translateToOpenAI(makePayload('claude-haiku-4-20250514'))
    expect(result.model).toBe('claude-haiku-4')
  })

  test('should normalize claude-sonnet-4.5-20250514 to claude-sonnet-4.5', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4.5-20250514'))
    expect(result.model).toBe('claude-sonnet-4.5')
  })

  test('should normalize claude-opus-4.5-20250514 to claude-opus-4.5', () => {
    const result = translateToOpenAI(makePayload('claude-opus-4.5-20250514'))
    expect(result.model).toBe('claude-opus-4.5')
  })

  test('should normalize claude-opus-4.6-20250514 to claude-opus-4.6', () => {
    const result = translateToOpenAI(makePayload('claude-opus-4.6-20250514'))
    expect(result.model).toBe('claude-opus-4.6')
  })

  test('should normalize claude-haiku-4.5-20250514 to claude-haiku-4.5', () => {
    const result = translateToOpenAI(makePayload('claude-haiku-4.5-20250514'))
    expect(result.model).toBe('claude-haiku-4.5')
  })

  test('should normalize claude-sonnet-4-5-20250929 to claude-sonnet-4.5', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4-5-20250929'))
    expect(result.model).toBe('claude-sonnet-4.5')
  })

  test('should normalize claude-sonnet-4-6 to claude-sonnet-4.6 (no date suffix)', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4-6'))
    expect(result.model).toBe('claude-sonnet-4.6')
  })

  test('should normalize claude-opus-4-6 to claude-opus-4.6 (no date suffix)', () => {
    const result = translateToOpenAI(makePayload('claude-opus-4-6'))
    expect(result.model).toBe('claude-opus-4.6')
  })

  test('should normalize claude-haiku-4-6 to claude-haiku-4.6 (no date suffix)', () => {
    const result = translateToOpenAI(makePayload('claude-haiku-4-6'))
    expect(result.model).toBe('claude-haiku-4.6')
  })

  test('should normalize claude-haiku-4-5 to claude-haiku-4.5 (no date suffix)', () => {
    const result = translateToOpenAI(makePayload('claude-haiku-4-5'))
    expect(result.model).toBe('claude-haiku-4.5')
  })

  test('should normalize claude-sonnet-4-5 to claude-sonnet-4.5 (no date suffix)', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4-5'))
    expect(result.model).toBe('claude-sonnet-4.5')
  })

  test('should normalize claude-opus-4-5 to claude-opus-4.5 (no date suffix)', () => {
    const result = translateToOpenAI(makePayload('claude-opus-4-5'))
    expect(result.model).toBe('claude-opus-4.5')
  })

  test('should leave gpt-4o unchanged', () => {
    const result = translateToOpenAI(makePayload('gpt-4o'))
    expect(result.model).toBe('gpt-4o')
  })

  test('should leave claude-sonnet-4 unchanged (no suffix)', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4'))
    expect(result.model).toBe('claude-sonnet-4')
  })

  test('should leave claude-sonnet-4-7 unchanged (unsupported minor)', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4-7'))
    expect(result.model).toBe('claude-sonnet-4-7')
  })

  test('should leave claude-sonnet-4-5-foo unchanged (malformed suffix)', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4-5-foo'))
    expect(result.model).toBe('claude-sonnet-4-5-foo')
  })

  test('should leave claude-sonnet-4-56 unchanged (concatenated version)', () => {
    const result = translateToOpenAI(makePayload('claude-sonnet-4-56'))
    expect(result.model).toBe('claude-sonnet-4-56')
  })
})

describe('copilot_cache_control injection for Claude models', () => {
  test('should add copilot_cache_control to system message for Claude models', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
    }
    const result = translateToOpenAI(payload)
    const systemMessage = result.messages.find(m => m.role === 'system')
    expect(systemMessage).toBeDefined()
    expect(systemMessage?.copilot_cache_control).toEqual({ type: 'ephemeral' })
  })

  test('should add copilot_cache_control to the last tool for Claude models', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
      tools: [
        {
          name: 'tool_a',
          description: 'First tool',
          input_schema: { type: 'object' },
        },
        {
          name: 'tool_b',
          description: 'Second tool',
          input_schema: { type: 'object' },
        },
      ],
    }
    const result = translateToOpenAI(payload)
    expect(result.tools).toBeDefined()
    expect(result.tools!.length).toBe(2)
    // First tool should NOT have copilot_cache_control
    expect(result.tools![0].copilot_cache_control).toBeUndefined()
    // Last tool should have copilot_cache_control
    expect(result.tools![1].copilot_cache_control).toEqual({ type: 'ephemeral' })
  })

  test('should add copilot_cache_control to the only tool for Claude models', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
      tools: [
        {
          name: 'tool_a',
          description: 'Only tool',
          input_schema: { type: 'object' },
        },
      ],
    }
    const result = translateToOpenAI(payload)
    expect(result.tools![0].copilot_cache_control).toEqual({ type: 'ephemeral' })
  })

  test('should NOT add copilot_cache_control for non-Claude models', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-4o',
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
      tools: [
        {
          name: 'tool_a',
          description: 'A tool',
          input_schema: { type: 'object' },
        },
      ],
    }
    const result = translateToOpenAI(payload)
    const systemMessage = result.messages.find(m => m.role === 'system')
    expect(systemMessage).toBeDefined()
    expect(systemMessage?.copilot_cache_control).toBeUndefined()
    expect(result.tools![0].copilot_cache_control).toBeUndefined()
  })
})

describe('reasoning_effort mapping', () => {
  test('should map thinking budget_tokens to reasoning_effort high', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
      thinking: {
        type: 'enabled',
        budget_tokens: 4096,
      },
    }
    const result = translateToOpenAI(payload)
    expect(result.reasoning_effort).toBe('high')
  })

  test('should use model default reasoning_effort when thinking is not set', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-opus-4.6',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
    }
    const result = translateToOpenAI(payload)
    expect(result.reasoning_effort).toBe('high')
  })

  test('should not include reasoning_effort when thinking is not set', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
    }
    const result = translateToOpenAI(payload)
    expect(result.reasoning_effort).toBeUndefined()
  })

  test('should not include reasoning_effort when thinking has no budget_tokens', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
      thinking: {
        type: 'enabled',
      },
    }
    const result = translateToOpenAI(payload)
    expect(result.reasoning_effort).toBeUndefined()
  })
})

describe('snippy field', () => {
  test('should always include snippy: { enabled: false }', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
    }
    const result = translateToOpenAI(payload)
    expect(result.snippy).toEqual({ enabled: false })
  })

  test('should include snippy for Claude models', () => {
    const payload: AnthropicMessagesPayload = {
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'Hello!' }],
      max_tokens: 100,
    }
    const result = translateToOpenAI(payload)
    expect(result.snippy).toEqual({ enabled: false })
  })
})

describe('OpenAI Chat Completion v1 Request Payload Validation with Zod', () => {
  test('should return true for a minimal valid request payload', () => {
    const validPayload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test('should return true for a comprehensive valid request payload', () => {
    const validPayload = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the weather like in Boston?' },
      ],
      temperature: 0.7,
      max_tokens: 150,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      stream: false,
      n: 1,
    }
    expect(isValidChatCompletionRequest(validPayload)).toBe(true)
  })

  test('should return false if the "model" field is missing', () => {
    const invalidPayload = {
      messages: [{ role: 'user', content: 'Hello!' }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" field is missing', () => {
    const invalidPayload = {
      model: 'gpt-4o',
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if the "messages" array is empty', () => {
    const invalidPayload = {
      model: 'gpt-4o',
      messages: [],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "model" is not a string', () => {
    const invalidPayload = {
      model: 12345,
      messages: [{ role: 'user', content: 'Hello!' }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if "messages" is not an array', () => {
    const invalidPayload = {
      model: 'gpt-4o',
      messages: { role: 'user', content: 'Hello!' },
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing a "role"', () => {
    const invalidPayload = {
      model: 'gpt-4o',
      messages: [{ content: 'Hello!' }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if a message in the "messages" array is missing "content"', () => {
    const invalidPayload = {
      model: 'gpt-4o',
      messages: [{ role: 'user' }],
    }
    // Note: Zod considers 'undefined' as missing, so this will fail as expected.
    const result = chatCompletionRequestSchema.safeParse(invalidPayload)
    expect(result.success).toBe(false)
  })

  test('should return false if a message has an invalid "role"', () => {
    const invalidPayload = {
      model: 'gpt-4o',
      messages: [{ role: 'customer', content: 'Hello!' }],
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false if an optional field has an incorrect type', () => {
    const invalidPayload = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
      temperature: 'hot', // Should be a number
    }
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false for a completely empty object', () => {
    const invalidPayload = {}
    expect(isValidChatCompletionRequest(invalidPayload)).toBe(false)
  })

  test('should return false for null or non-object payloads', () => {
    expect(isValidChatCompletionRequest(null)).toBe(false)
    expect(isValidChatCompletionRequest(undefined)).toBe(false)
    expect(isValidChatCompletionRequest('a string')).toBe(false)
    expect(isValidChatCompletionRequest(123)).toBe(false)
  })
})
