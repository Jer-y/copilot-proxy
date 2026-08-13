import type { AnthropicDocumentBlock, AnthropicMessagesPayload } from '~/lib/translation/types'

import { describe, expect, test } from 'bun:test'

import {
  normalizeAdaptiveThinkingForCopilot,
  prepareAnthropicPayloadForNativeCopilotBackend,
  prepareAnthropicPayloadForTranslatedBackends,
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
  test('rejects advisor tools instead of stripping their semantics', () => {
    const payload = makePayload({
      tools: [
        {
          type: 'advisor_20260301',
          name: 'advisor',
          model: 'claude-opus-4-8',
        },
        {
          name: 'noop',
          input_schema: { type: 'object', properties: {} },
        },
      ],
    })

    expect(() => sanitizeForCopilotBackend(payload)).toThrow(
      'advisor_20260301 tools are not supported',
    )
    expect(payload.tools).toHaveLength(2)
  })

  test('preserves native context_management for Copilot upstream capability truth', () => {
    const payload = makePayload() as AnthropicMessagesPayload & {
      context_management?: { edits?: Array<{ type: string }> }
    }
    payload.context_management = {
      edits: [{ type: 'clear_tool_uses_20250919' }],
    }

    sanitizeForCopilotBackend(payload)

    expect(payload.context_management).toEqual({
      edits: [{ type: 'clear_tool_uses_20250919' }],
    })
  })

  test('flattens legacy json_schema.schema and strips Responses-only metadata', () => {
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
  test('rejects inline text documents outside the Claude Code wire surface', () => {
    const payload = makePayload({
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: 'Hello from document.',
          },
        }],
      }],
    })

    expect(() => prepareAnthropicPayloadForNativeCopilotBackend(payload)).toThrow(
      'supports only base64 application/pdf blocks; received text',
    )
  })

  test('leaves base64 PDF blocks unchanged for Claude Code passthrough', () => {
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

    prepareAnthropicPayloadForNativeCopilotBackend(payload)

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

  test('rejects URL, content, file, and non-PDF base64 document sources', () => {
    const unsupportedSources: Array<AnthropicDocumentBlock['source']> = [
      { type: 'url', url: 'https://example.com/document.pdf' },
      { type: 'content', content: [{ type: 'text', text: 'Content block.' }] },
      { type: 'file', file_id: 'file_123' },
      { type: 'base64', media_type: 'text/plain', data: 'SGVsbG8=' },
    ]

    for (const source of unsupportedSources) {
      const payload = makePayload({
        messages: [{
          role: 'user',
          content: [{ type: 'document', source }],
        }],
      })

      expect(() => prepareAnthropicPayloadForNativeCopilotBackend(payload)).toThrow(
        'Claude Code document compatibility supports only base64 application/pdf blocks',
      )
    }
  })

  test('allows a base64 PDF nested in a tool result', () => {
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
              media_type: 'application/pdf',
              data: 'JVBERi0xLjQK',
            },
          }],
        }],
      }],
    })

    const before = structuredClone(payload.messages[0].content)
    prepareAnthropicPayloadForNativeCopilotBackend(payload)

    expect(payload.messages[0].content).toEqual(before)
  })

  test('rejects non-PDF documents nested in tool results', () => {
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
              data: 'IyBDaXRhdGlvbiBzb3VyY2U=',
            },
          }],
        }],
      }],
    })

    expect(() => prepareAnthropicPayloadForNativeCopilotBackend(payload)).toThrow(
      'supports only base64 application/pdf blocks; received base64 text/markdown',
    )
  })
})

describe('prepareAnthropicPayloadForTranslatedBackends', () => {
  test('rejects document blocks instead of translating them to Responses', () => {
    const payload = makePayload({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'JVBERi0xLjQK',
          },
        }],
      }],
    })

    expect(() => prepareAnthropicPayloadForTranslatedBackends(payload)).toThrow(
      'document blocks cannot be translated faithfully',
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
