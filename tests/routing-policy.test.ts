import type { Model } from '~/services/copilot/get-models'

import { describe, expect, test } from 'bun:test'

import { modelSupportsResponsesWebSocket, resolveRoute } from '~/lib/routing-policy'

function fail(message: string): never {
  throw new Error(message)
}

describe('modelSupportsResponsesWebSocket', () => {
  test('accepts only explicit live Responses WebSocket endpoints', () => {
    for (const endpoint of [
      'ws:/responses',
      'wss:/responses',
      'ws:/v1/responses',
      ' ws:/V1/RESPONSES/ ',
      ' WSS:/V1/RESPONSES/ ',
    ]) {
      expect(modelSupportsResponsesWebSocket(makeModel('gpt-ws', [endpoint]))).toBe(true)
    }
  })

  test('does not infer WebSocket support from ordinary Responses or missing live metadata', () => {
    for (const endpoint of [
      'responses',
      '/responses',
      '/v1/responses',
      'ws://responses',
      'https:/responses',
    ]) {
      expect(modelSupportsResponsesWebSocket(makeModel('gpt-http', [endpoint]))).toBe(false)
    }

    expect(modelSupportsResponsesWebSocket(makeModel('gpt-unknown'))).toBe(false)
    expect(modelSupportsResponsesWebSocket(undefined)).toBe(false)
  })
})

describe('resolveRoute — Claude Opus 5', () => {
  test('uses native Messages and Chat Completions, but rejects Responses', () => {
    expect(resolveRoute('anthropic-messages', 'claude-opus-5', fail)).toEqual({
      backend: 'anthropic-messages',
      kind: 'direct',
    })
    expect(() => resolveRoute('responses', 'claude-opus-5', fail)).toThrow('cross-protocol translation is not supported')
    expect(resolveRoute('chat-completions', 'claude-opus-5', fail)).toEqual({
      backend: 'chat-completions',
      kind: 'direct',
    })
  })
})

describe('resolveRoute — anthropic-messages client', () => {
  test('Claude → native /v1/messages (direct)', () => {
    const route = resolveRoute('anthropic-messages', 'claude-opus-4.6', fail)
    expect(route).toEqual({ backend: 'anthropic-messages', kind: 'direct' })
  })

  test('Claude minor version (claude-opus-4.7) → native /v1/messages (direct)', () => {
    const route = resolveRoute('anthropic-messages', 'claude-opus-4.7', fail)
    expect(route).toEqual({ backend: 'anthropic-messages', kind: 'direct' })
  })

  test('Responses-only model rejects Messages instead of translating', () => {
    expect(() => resolveRoute('anthropic-messages', 'gpt-5.4', fail)).toThrow('cross-protocol translation is not supported')
  })

  test('Responses-only Codex model rejects Messages instead of translating', () => {
    expect(() => resolveRoute('anthropic-messages', 'gpt-5.2-codex', fail)).toThrow('cross-protocol translation is not supported')
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

  test('Messages-backed model rejects Responses instead of translating', () => {
    expect(() => resolveRoute('responses', 'claude-opus-4.6', fail)).toThrow('cross-protocol translation is not supported')
  })

  test('Dual-stack GPT-5.2 → /responses (direct, preferredApi)', () => {
    const route = resolveRoute('responses', 'gpt-5.2', fail)
    expect(route).toEqual({ backend: 'responses', kind: 'direct' })
  })

  test('live HTTP Responses endpoint support lets future models route without static config', () => {
    const route = resolveRoute('responses', 'gpt-6-preview', fail, {
      models: [
        makeModel('gpt-6-preview', [' /V1/RESPONSES/ ']),
      ],
    })

    expect(route).toEqual({ backend: 'responses', kind: 'direct' })
  })

  test('does not infer HTTP Responses support from a WebSocket-only live endpoint', () => {
    expect(() => resolveRoute('responses', 'gpt-ws-only', (message) => {
      throw new Error(message)
    }, {
      models: [
        makeModel('gpt-ws-only', [' ws:/V1/RESPONSES/ ']),
      ],
    })).toThrow(/no supported backend API/)
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

function makeModel(id: string, supported_endpoints?: string[]): Model {
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
