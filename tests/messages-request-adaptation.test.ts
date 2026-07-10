import type { AnthropicMessagesPayload } from '~/lib/translation/types'

import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'bun:test'

import {
  normalizeAdaptiveThinkingForCopilot,
  prepareAnthropicPayloadForNativeCopilotBackend,
  sanitizeForCopilotBackend,
  stripAssistantThinkingBlocks,
} from '~/routes/messages/request-adaptation'

function makePayload(
  overrides: Partial<AnthropicMessagesPayload> = {},
): AnthropicMessagesPayload {
  return {
    model: 'claude-opus-4.6',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Hi' }],
    ...overrides,
  }
}

describe('sanitizeForCopilotBackend', () => {
  test('strips unsupported native passthrough context_management', () => {
    const payload = makePayload() as AnthropicMessagesPayload & {
      context_management?: { clear_function_results?: boolean }
    }
    payload.context_management = { clear_function_results: true }

    sanitizeForCopilotBackend(payload)

    expect('context_management' in payload).toBe(false)
  })

  test('flattens legacy json_schema.schema while preserving client format metadata', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } }
    const payload = makePayload({
      output_config: {
        format: {
          type: 'json_schema',
          json_schema: { schema },
          name: 'response_shape',
          strict: true,
        },
      },
    })

    sanitizeForCopilotBackend(payload)

    expect(payload.output_config?.format).toEqual({
      type: 'json_schema',
      name: 'response_shape',
      strict: true,
      schema,
    })
  })

  test('rejects json_schema format with both flat and legacy nested schema', () => {
    const payload = makePayload({
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'object' },
          json_schema: { schema: { type: 'object' } },
        },
      },
    })

    expect(() => sanitizeForCopilotBackend(payload)).toThrow(
      'must use either flat "schema" or legacy "json_schema.schema", not both',
    )
  })

  test('rejects json_schema format without an object schema', () => {
    const payload = makePayload({
      output_config: {
        format: {
          type: 'json_schema',
          schema: 'not-an-object',
        },
      },
    })

    expect(() => sanitizeForCopilotBackend(payload)).toThrow(
      'requires an object "schema"',
    )
  })
})

describe('prepareAnthropicPayloadForNativeCopilotBackend', () => {
  test('expands inline text documents for native Copilot passthrough', async () => {
    const payload = makePayload({
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain; charset=iso-8859-1',
              data: 'Hello from document café.',
            },
            title: 'note.txt',
            context: 'Probe context',
            citations: { enabled: false },
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: 'Summarize it.' },
        ],
      }],
    })

    await prepareAnthropicPayloadForNativeCopilotBackend(payload)

    expect(payload.messages[0].content).toEqual([
      {
        type: 'text',
        text: '[Document: note.txt]\nContext: Probe context\n\nHello from document café.',
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: 'Summarize it.' },
    ])
  })

  test('rejects citations on text documents that require local expansion', async () => {
    const payload = makePayload({
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: 'Citation source.',
          },
          citations: { enabled: true },
        }],
      }],
    })

    await expect(prepareAnthropicPayloadForNativeCopilotBackend(payload)).rejects.toThrow(
      'Document citations cannot be preserved',
    )
  })

  test('leaves PDF document blocks for native Copilot passthrough', async () => {
    const payload = makePayload({
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERi0xLjQK',
            },
            citations: { enabled: true },
          },
        ],
      }],
    })

    await prepareAnthropicPayloadForNativeCopilotBackend(payload)

    expect(payload.messages[0].content).toEqual([
      {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'JVBERi0xLjQK',
        },
        citations: { enabled: true },
      },
    ])
  })

  test('expands content document sources without cache breakpoints', async () => {
    const payload = makePayload({
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: {
            type: 'content',
            content: [
              { type: 'text', text: 'First paragraph.' },
              { type: 'text', text: 'Second paragraph.' },
            ],
          },
        }],
      }],
    })

    await prepareAnthropicPayloadForNativeCopilotBackend(payload)

    expect(payload.messages[0].content).toEqual([
      { type: 'text', text: 'First paragraph.\n\nSecond paragraph.' },
    ])
  })

  test('rejects inner cache breakpoints that content document fallback cannot preserve', async () => {
    const payload = makePayload({
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: {
            type: 'content',
            content: [
              { type: 'text', text: 'Cached paragraph.', cache_control: { type: 'ephemeral' } },
            ],
          },
        }],
      }],
    })

    await expect(prepareAnthropicPayloadForNativeCopilotBackend(payload)).rejects.toThrow(
      'document.source.content cache_control cannot be preserved',
    )
  })

  test('expands text documents nested in tool results for native Copilot passthrough', async () => {
    const payload = makePayload({
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'text/plain',
                data: Buffer.from('Nested text document').toString('base64'),
              },
            },
          ],
        }],
      }],
    })

    await prepareAnthropicPayloadForNativeCopilotBackend(payload)

    expect(payload.messages[0].content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: [
        { type: 'text', text: 'Nested text document' },
      ],
    }])
  })

  test('rejects citations on nested base64 text documents', async () => {
    const payload = makePayload({
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/markdown',
              data: Buffer.from('# Citation source').toString('base64'),
            },
            citations: { enabled: true },
          }],
        }],
      }],
    })

    await expect(prepareAnthropicPayloadForNativeCopilotBackend(payload)).rejects.toThrow(
      'Document citations cannot be preserved',
    )
  })
})

describe('normalizeAdaptiveThinkingForCopilot', () => {
  test('rejects adaptive thinking budget_tokens', () => {
    const payload = makePayload({
      thinking: {
        type: 'adaptive',
        budget_tokens: 4096,
      } as AnthropicMessagesPayload['thinking'],
    })

    expect(() => normalizeAdaptiveThinkingForCopilot(payload)).toThrow(
      'thinking.adaptive.budget_tokens',
    )
  })

  test('strips unsupported adaptive thinking budget_tokens_max', () => {
    const payload = makePayload({
      thinking: {
        type: 'adaptive',
        display: 'omitted',
        budget_tokens_max: 4096,
      } as AnthropicMessagesPayload['thinking'],
    })

    normalizeAdaptiveThinkingForCopilot(payload)

    expect(payload.thinking).toEqual({
      type: 'adaptive',
      display: 'omitted',
    })
  })
})

describe('stripAssistantThinkingBlocks', () => {
  test('strips assistant thinking blocks and drops thinking-only assistant turns', () => {
    const payload = makePayload({
      messages: [
        { role: 'user', content: 'Start.' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'old reasoning', signature: 'sig_1' },
            { type: 'redacted_thinking', data: 'redacted' },
          ],
        },
        { role: 'user', content: 'Continue.' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'more reasoning', signature: 'sig_2' },
            { type: 'text', text: 'Visible answer.' },
          ],
        },
      ],
    })

    const result = stripAssistantThinkingBlocks(payload)

    expect(result.stripped).toBe(true)
    expect(result.strippedBlocks).toBe(3)
    expect(result.droppedAssistantMessages).toBe(1)
    expect(result.payload.messages).toEqual([
      { role: 'user', content: 'Start.' },
      { role: 'user', content: 'Continue.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Visible answer.' },
        ],
      },
    ])
  })

  test('returns the original payload when there are no assistant thinking blocks', () => {
    const payload = makePayload({
      messages: [
        { role: 'user', content: 'Start.' },
        { role: 'assistant', content: [{ type: 'text', text: 'Visible answer.' }] },
      ],
    })

    const result = stripAssistantThinkingBlocks(payload)

    expect(result).toEqual({
      payload,
      stripped: false,
      strippedBlocks: 0,
      droppedAssistantMessages: 0,
    })
    expect(result.payload).toBe(payload)
  })
})
