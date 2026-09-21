import { describe, expect, test } from 'bun:test'

import { HTTPError } from '~/lib/error'
import { modelSupportsResponsesWebSocket, resolveRoute } from '~/lib/routing-policy'
import { state } from '~/lib/state'
import { makeModel } from './model-fixtures'

function fail(message: string): never {
  throw new Error(message)
}

describe('dynamic native routing', () => {
  test('requires an account catalog, even for formerly hardcoded model names', () => {
    const previous = state.defaultAccount.models
    state.defaultAccount.models = { object: 'list', data: [makeModel('gpt-5.4', ['/responses'])] }
    try {
      for (const model of ['gpt-5.4', 'claude-opus-4.8', 'future-model']) {
        expect(() => resolveRoute('responses', model, fail)).toThrow(HTTPError)
        expect(() => resolveRoute('responses', model, fail)).toThrow('model catalog is unavailable')
      }
    }
    finally {
      state.defaultAccount.models = previous
    }
  })

  test('requires exact membership and does not infer model variants', () => {
    const models = [makeModel('gpt-5.4', ['/responses'])]
    for (const model of ['gpt-5.4-fast', 'gpt-5.40', 'missing-model']) {
      expect(() => resolveRoute('responses', model, fail, { models })).toThrow('not available')
    }
    expect(() => resolveRoute('responses', 'gpt-5.4', fail, { models: [] })).toThrow('not available')
  })

  test('routes every advertised native HTTP API without brand assumptions', () => {
    for (const [api, endpoints] of [
      ['responses', ['/responses', ' /V1/RESPONSES/ ']],
      ['anthropic-messages', ['/v1/messages', ' messages/ ']],
      ['chat-completions', ['/chat/completions', '/v1/chat/completions/']],
    ] as const) {
      for (const endpoint of endpoints) {
        const models = [makeModel('any-vendor-model', [endpoint])]
        expect(resolveRoute(api, 'any-vendor-model', fail, { models })).toEqual({ backend: api, kind: 'direct' })
      }
    }
  })

  test('does not recover missing endpoint metadata from a model name', () => {
    for (const id of ['claude-opus-4.8', 'gpt-4o', 'gpt-5.4']) {
      for (const endpoints of [undefined, []]) {
        const model = { ...makeModel(id), supported_endpoints: endpoints }
        expect(() => resolveRoute('responses', id, fail, { models: [model] })).toThrow('no advertised native HTTP endpoint')
        expect(() => resolveRoute('anthropic-messages', id, fail, { models: [model] })).toThrow('no advertised native HTTP endpoint')
      }
    }
  })

  test('keeps account-specific endpoint declarations separate', () => {
    const accountA = [makeModel('shared-model', ['/responses'])]
    const accountB = [makeModel('shared-model', ['/v1/messages'])]
    expect(resolveRoute('responses', 'shared-model', fail, { models: accountA }).backend).toBe('responses')
    expect(() => resolveRoute('responses', 'shared-model', fail, { models: accountB })).toThrow('cross-protocol translation is not supported')
    expect(resolveRoute('anthropic-messages', 'shared-model', fail, { models: accountB }).backend).toBe('anthropic-messages')
  })

  test('rejects incompatible protocols rather than falling back to another endpoint', () => {
    const models = [makeModel('messages-only', ['/v1/messages']), makeModel('responses-only', ['/responses'])]
    expect(() => resolveRoute('responses', 'messages-only', fail, { models })).toThrow('cannot be reached via /responses')
    expect(() => resolveRoute('anthropic-messages', 'responses-only', fail, { models })).toThrow('cannot be reached via /v1/messages')
    expect(() => resolveRoute('chat-completions', 'responses-only', fail, { models })).toThrow('cannot be reached via /chat/completions')
  })

  test('does not treat WebSocket or unrelated endpoints as HTTP Responses support', () => {
    for (const endpoint of [' ws:/V1/RESPONSES/ ', '/embeddings', 'https:/responses']) {
      const model = makeModel('ws-only', [endpoint])
      expect(() => resolveRoute('responses', model.id, fail, { models: [model] })).toThrow('no advertised native HTTP endpoint')
    }
  })
})

describe('modelSupportsResponsesWebSocket', () => {
  test('accepts only explicit live WebSocket endpoints', () => {
    for (const endpoint of ['ws:/responses', 'wss:/responses', 'ws:/v1/responses', ' WSS:/V1/RESPONSES/ '])
      expect(modelSupportsResponsesWebSocket(makeModel('ws-model', [endpoint]))).toBe(true)
    for (const endpoint of ['/responses', '/v1/responses', 'responses', 'ws://responses', 'https:/responses'])
      expect(modelSupportsResponsesWebSocket(makeModel('http-model', [endpoint]))).toBe(false)
    expect(modelSupportsResponsesWebSocket(makeModel('missing-metadata'))).toBe(false)
    expect(modelSupportsResponsesWebSocket(undefined)).toBe(false)
  })
})
