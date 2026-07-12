import type { ResponsesPayload } from '~/services/copilot/create-responses'
import type { Model } from '~/services/copilot/get-models'

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

  test('live Anthropic endpoint support overrides static defaults for new models', () => {
    const route = resolveRoute('anthropic-messages', 'future-claude', fail, {
      models: [
        makeModel('future-claude', ['/v1/messages']),
      ],
    })

    expect(route).toEqual({ backend: 'anthropic-messages', kind: 'direct' })
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

  test('live Responses endpoint support lets future models route without static config', () => {
    const route = resolveRoute('responses', 'gpt-6-preview', fail, {
      models: [
        makeModel('gpt-6-preview', ['/responses', 'ws:/responses']),
      ],
    })

    expect(route).toEqual({ backend: 'responses', kind: 'direct' })
  })

  test('gpt-5-codex no longer inherits the dual chat-completions gpt-5 config', () => {
    const route = resolveRoute('responses', 'gpt-5-codex', fail)
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

  test('Current dual-stack GPT-5.4 → /chat/completions direct', () => {
    expect(resolveRoute('chat-completions', 'gpt-5.4', fail)).toEqual({
      backend: 'chat-completions',
      kind: 'direct',
    })
  })

  test('Codex model → 4xx', () => {
    expect(() => resolveRoute('chat-completions', 'gpt-5.3-codex', (msg) => {
      throw new Error(msg)
    })).toThrow(/cannot be reached via \/chat\/completions/)
  })

  test('gpt-5-codex → 4xx instead of inheriting gpt-5 chat support', () => {
    expect(() => resolveRoute('chat-completions', 'gpt-5-codex', (msg) => {
      throw new Error(msg)
    })).toThrow(/cannot be reached via \/chat\/completions/)
  })

  test('live endpoints can remove stale static chat-completions support', () => {
    expect(() => resolveRoute('chat-completions', 'gpt-5', (msg) => {
      throw new Error(msg)
    }, {
      models: [
        makeModel('gpt-5', ['/responses']),
      ],
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
        store: false,
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

  test('rejects Responses semantics that translation cannot preserve', () => {
    const cases: Array<[string, Partial<ResponsesPayload>]> = [
      ['store', { store: true }],
      ['previous_response_id', { previous_response_id: 'resp_prior' }],
      ['background', { background: true }],
      ['conversation', { conversation: { id: 'conv_1' } }],
      ['prompt', { prompt: { id: 'pmpt_1' } }],
      ['max_tool_calls', { max_tool_calls: 2 }],
      ['context_management', { context_management: [{ type: 'compaction' }] }],
      ['truncation', { truncation: 'auto' }],
      ['include', { include: ['reasoning.encrypted_content'] }],
      ['stream_options', { stream_options: { include_obfuscation: true } }],
      ['top_logprobs', { top_logprobs: 2 }],
      ['text.verbosity', { text: { verbosity: 'high' } }],
      ['reasoning summaries', { reasoning: { summary: 'detailed' } }],
    ]

    for (const [field, extra] of cases) {
      expect(() => assertResponsesPayloadTranslatable(
        {
          model: 'claude-opus-4.6',
          input: 'hi',
          store: false,
          ...extra,
        },
        (msg) => { throw new Error(msg) },
      )).toThrow(field)
    }
  })

  test('rejects non-function Responses tool choices that Anthropic cannot represent', () => {
    expect(() => assertResponsesPayloadTranslatable(
      {
        model: 'claude-opus-4.6',
        input: 'hi',
        store: false,
        tool_choice: {
          type: 'allowed_tools',
          mode: 'required',
          tools: [{ type: 'function', name: 'echo' }],
        },
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/tool_choice/)
  })

  test('rejects malformed compatibility fields instead of silently dropping them', () => {
    const cases: Array<Partial<ResponsesPayload>> = [
      { store: null as never },
      { background: 'false' as never },
      { context_management: {} as never },
      { include: 'reasoning.encrypted_content' as never },
      { stream_options: 'disabled' as never },
      { text: 'plain' as never },
      { reasoning: 'none' as never },
      { tools: [null as never] },
    ]

    for (const extra of cases) {
      expect(() => assertResponsesPayloadTranslatable(
        {
          model: 'claude-opus-4.6',
          input: 'hi',
          store: false,
          ...extra,
        },
        (msg) => { throw new Error(msg) },
      )).toThrow()
    }
  })

  test('allows explicit no-op Responses state settings', () => {
    expect(() => assertResponsesPayloadTranslatable(
      {
        model: 'claude-opus-4.6',
        input: 'hi',
        store: false,
        previous_response_id: null,
        background: null,
        conversation: null,
        prompt: null,
        max_tool_calls: null,
        context_management: [],
        truncation: null,
        include: [],
        stream_options: { include_obfuscation: false },
        text: { verbosity: null },
        reasoning: { summary: null, generate_summary: null },
      },
      (msg) => { throw new Error(msg) },
    )).not.toThrow()
  })

  test('rejects omitted store because Responses persist by default', () => {
    expect(() => assertResponsesPayloadTranslatable(
      {
        model: 'claude-opus-4.6',
        input: 'hi',
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/must explicitly set store=false/)
  })
})

function makeModel(id: string, supported_endpoints: string[]): Model {
  return {
    id,
    supported_endpoints,
    capabilities: {
      family: 'test',
      limits: {},
      object: 'model_capabilities',
      supports: {},
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'test',
    version: '1',
  }
}

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

  test('rejects unknown typed non-custom tools instead of silently omitting them', () => {
    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Fetch a page.' }],
        tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
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

  test('rejects Anthropic request semantics that Responses translation cannot preserve', () => {
    const base = {
      model: 'gpt-5.4',
      max_tokens: 64,
      messages: [{ role: 'user' as const, content: 'hi' }],
    }
    const cases: Array<[string, Record<string, unknown>]> = [
      ['stop_sequences', { stop_sequences: ['END'] }],
      ['top_k', { top_k: 40 }],
      ['task_budget', { output_config: { task_budget: { type: 'tokens', total: 20_000 } } }],
      ['MCP servers', { mcp_servers: [{ type: 'url', name: 'tools', url: 'https://example.com/mcp' }] }],
      ['context_management', { context_management: { edits: [{ type: 'compact_20260112' }] } }],
    ]

    for (const [field, extra] of cases) {
      expect(() => assertMessagesPayloadTranslatable(
        { ...base, ...extra } as never,
        (msg) => { throw new Error(msg) },
      )).toThrow(field)
    }
  })

  test('allows explicit no-op Anthropic translation settings', () => {
    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        stop_sequences: [],
        mcp_servers: [],
        context_management: { edits: [] },
        output_config: { task_budget: null },
      } as never,
      (msg) => { throw new Error(msg) },
    )).not.toThrow()
  })

  test('rejects replayed Anthropic server-tool history instead of deleting it', () => {
    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{
          role: 'assistant',
          content: [
            { type: 'server_tool_use', id: 'srv_1', name: 'code_execution', input: {} },
            { type: 'bash_code_execution_tool_result', tool_use_id: 'srv_1', content: { stdout: 'ok' } },
          ],
        }],
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/server-tool history/)
  })

  test('rejects explicit tool and reasoning controls only when model capability cannot preserve them', () => {
    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'future-responses-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'any' },
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/tool_choice/)

    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'o3-mini',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/parallel_tool_calls/)

    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'max' },
      },
      (msg) => { throw new Error(msg) },
    )).toThrow(/thinking\/output_config\.effort/)

    expect(() => assertMessagesPayloadTranslatable(
      {
        model: 'gpt-5.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        tool_choice: { type: 'tool', name: 'noop', disable_parallel_tool_use: true },
        output_config: { effort: 'max' },
      },
      (msg) => { throw new Error(msg) },
    )).not.toThrow()
  })
})
