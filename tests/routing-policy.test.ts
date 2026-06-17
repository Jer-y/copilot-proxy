import { describe, expect, test } from 'bun:test'

import { assertMessagesPayloadTranslatable, assertResponsesPayloadTranslatable, resolveRoute } from '~/lib/routing-policy'

function fail(message: string): never {
  throw new Error(message)
}

describe('resolveRoute — anthropic-messages client', () => {
  test('Claude → native /v1/messages (direct)', () => {
    const route = resolveRoute('anthropic-messages', 'claude-opus-4.6', fail)
    expect(route).toEqual({ backend: 'anthropic-messages', kind: 'direct' })
  })

  test('Claude minor version (claude-opus-4.7) → native /v1/messages (direct)', () => {
    const route = resolveRoute('anthropic-messages', 'claude-opus-4.7', fail)
    expect(route).toEqual({ backend: 'anthropic-messages', kind: 'direct' })
  })

  test('Responses-only model (gpt-5.4) → translate to /responses', () => {
    const route = resolveRoute('anthropic-messages', 'gpt-5.4', fail)
    expect(route).toEqual({ backend: 'responses', kind: 'translate' })
  })

  test('Responses-only Codex model → translate to /responses', () => {
    const route = resolveRoute('anthropic-messages', 'gpt-5.2-codex', fail)
    expect(route).toEqual({ backend: 'responses', kind: 'translate' })
  })

  test('chat-completions-only model (gpt-4o) → 4xx (proxy refuses to translate to chat-completions)', () => {
    let captured: string | undefined
    expect(() => resolveRoute('anthropic-messages', 'gpt-4o', (msg) => {
      captured = msg
      throw new Error('rejected')
    })).toThrow('rejected')
    expect(captured).toContain('cannot be reached via /v1/messages')
    expect(captured).toContain('/chat/completions')
  })
})

describe('resolveRoute — responses client', () => {
  test('Responses-only GPT-5 → /responses (direct)', () => {
    const route = resolveRoute('responses', 'gpt-5.5', fail)
    expect(route).toEqual({ backend: 'responses', kind: 'direct' })
  })

  test('Claude → translate to /v1/messages', () => {
    const route = resolveRoute('responses', 'claude-opus-4.6', fail)
    expect(route).toEqual({ backend: 'anthropic-messages', kind: 'translate' })
  })

  test('Dual-stack GPT-5.2 → /responses (direct, preferredApi)', () => {
    const route = resolveRoute('responses', 'gpt-5.2', fail)
    expect(route).toEqual({ backend: 'responses', kind: 'direct' })
  })

  test('chat-completions-only model (gpt-4o) → 4xx', () => {
    expect(() => resolveRoute('responses', 'gpt-4o', (msg) => {
      throw new Error(msg)
    })).toThrow(/cannot be reached via \/responses/)
  })
})

describe('resolveRoute — chat-completions client', () => {
  test('chat-completions-only model → /chat/completions (direct)', () => {
    const route = resolveRoute('chat-completions', 'gpt-4o', fail)
    expect(route).toEqual({ backend: 'chat-completions', kind: 'direct' })
  })

  test('Claude (dual-listed) → /chat/completions (direct passthrough)', () => {
    const route = resolveRoute('chat-completions', 'claude-opus-4.6', fail)
    expect(route).toEqual({ backend: 'chat-completions', kind: 'direct' })
  })

  test('Dual-stack GPT-5.2 → /chat/completions (direct, since CC ∈ supportedApis)', () => {
    const route = resolveRoute('chat-completions', 'gpt-5.2', fail)
    expect(route).toEqual({ backend: 'chat-completions', kind: 'direct' })
  })

  test('Responses-only GPT-5.4 → 4xx (no translation into chat-completions)', () => {
    expect(() => resolveRoute('chat-completions', 'gpt-5.4', (msg) => {
      throw new Error(msg)
    })).toThrow(/cannot be reached via \/chat\/completions/)
  })

  test('Codex model → 4xx', () => {
    expect(() => resolveRoute('chat-completions', 'gpt-5.3-codex', (msg) => {
      throw new Error(msg)
    })).toThrow(/cannot be reached via \/chat\/completions/)
  })
})

describe('assertResponsesPayloadTranslatable', () => {
  test('rejects hosted Responses tools', () => {
    expect(() => assertResponsesPayloadTranslatable(
      {
        model: 'claude-opus-4.6',
        input: 'Search the web.',
        tools: [{ type: 'web_search' } as never],
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/Hosted Responses tools/)
  })

  test('rejects input_file content parts', () => {
    expect(() => assertResponsesPayloadTranslatable(
      {
        model: 'claude-opus-4.6',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Summarize this file.' },
              { type: 'input_file', file_url: 'https://example.com/report.pdf' } as never,
            ],
          },
        ],
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/input_file/)
  })

  test('passes a clean function-tools payload', () => {
    expect(() => assertResponsesPayloadTranslatable(
      {
        model: 'claude-opus-4.6',
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'echo',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          } as never,
        ],
      },
      (msg) => { throw new Error(msg) },
    )).not.toThrow()
  })
})

describe('assertMessagesPayloadTranslatable', () => {
  test('rejects Anthropic server-side tools that cannot be translated to Responses', () => {
    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Use code execution.' }],
        tools: [{ type: 'code_execution_20260120', name: 'code_execution' }],
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/server-side tools/)
  })

  test('passes custom tools that can be translated to Responses function tools', () => {
    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Call noop.' }],
        tools: [{ name: 'noop', input_schema: { type: 'object', properties: {} } }],
      },
      (msg) => { throw new Error(msg) },
    )).not.toThrow()
  })

  test('passes custom tools that retain Anthropic type=custom metadata', () => {
    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Call noop.' }],
        tools: [{ type: 'custom', name: 'noop', input_schema: { type: 'object', properties: {} } }],
      },
      (msg) => { throw new Error(msg) },
    )).not.toThrow()
  })
})
