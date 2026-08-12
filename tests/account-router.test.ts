import type { AccountsConfiguration } from '~/lib/account/types'
import type { ModelsResponse } from '~/services/copilot/get-models'

import { describe, expect, test } from 'bun:test'

import { AccountRegistry } from '~/lib/account/registry'
import { selectAccount } from '~/lib/account/router'
import { normalizeAnthropicModelName } from '~/routes/messages/model-normalization'

describe('multi-account deterministic routing', () => {
  test('applies header, prefix, first matching rule, and default precedence', () => {
    const registry = createRegistry()
    expect(select(registry, 'gpt-5.4').ctx.id).toBe('personal')
    expect(select(registry, 'claude-opus-4.8').ctx.id).toBe('work')
    expect(select(registry, 'personal/claude-opus-4.8').ctx.id).toBe('personal')
    expect(select(registry, 'gpt-5.4', 'work').ctx.id).toBe('work')
  })

  test('rejects conflicting selectors and unavailable bound accounts without fallback', () => {
    const registry = createRegistry()
    expect(() => select(registry, 'personal/gpt-5.4', 'work')).toThrow()
    registry.get('work')!.availability = 'unavailable'
    registry.get('work')!.unavailableReason = 'token_failed'
    expect(() => select(registry, 'claude-opus-4.8')).toThrow('unavailable')
  })

  test('keeps a WebSocket pin ahead of later route rules and rejects cross-account selectors', () => {
    const registry = createRegistry()
    expect(selectAccount({
      registry,
      requestedModel: 'claude-opus-4.8',
      headers: new Headers(),
      pinnedAccountId: 'personal',
    }).ctx.id).toBe('personal')
    expect(() => selectAccount({
      registry,
      requestedModel: 'work/claude-opus-4.8',
      headers: new Headers(),
      pinnedAccountId: 'personal',
    })).toThrow('pinned')
  })

  test('normalizes client aliases before static route matching and after model-prefix selection', () => {
    const registry = createRegistry([
      { match: 'claude-opus-4.8', account: 'work' },
      { match: '*', account: 'personal' },
    ])

    const routed = selectAccount({
      registry,
      requestedModel: 'claude-opus-4-8-20250514',
      headers: new Headers(),
      normalizeModel: normalizeAnthropicModelName,
    })
    expect(routed.ctx.id).toBe('work')
    expect(routed.effectiveModel).toBe('claude-opus-4.8')

    const prefixed = selectAccount({
      registry,
      requestedModel: 'personal/claude-opus-4-8-20250514',
      headers: new Headers(),
      normalizeModel: normalizeAnthropicModelName,
    })
    expect(prefixed.ctx.id).toBe('personal')
    expect(prefixed.effectiveModel).toBe('claude-opus-4.8')
  })
})

function select(registry: AccountRegistry, model: string, header?: string) {
  return selectAccount({
    registry,
    requestedModel: model,
    headers: new Headers(header ? { 'x-copilot-account': header } : undefined),
  })
}

function createRegistry(routes: AccountsConfiguration['routes'] = [
  { match: 'claude-*', account: 'work' },
  { match: '*', account: 'personal' },
]): AccountRegistry {
  const configuration: AccountsConfiguration = {
    version: 1,
    revision: 1,
    defaultAccount: 'personal',
    requiredRoutes: [],
    accounts: [
      { id: 'personal', accountType: 'individual', githubLogin: 'alice', githubUserId: 1 },
      { id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 },
    ],
    routes,
  }
  const registry = new AccountRegistry(configuration)
  for (const ctx of registry.list()) {
    ctx.availability = 'ready'
    ctx.copilotToken = `${ctx.id}-token`
    ctx.models = models()
  }
  return registry
}

function models(): ModelsResponse {
  return {
    object: 'list',
    data: ['gpt-5.4', 'claude-opus-4.8'].map(id => ({
      id,
      name: id,
      object: 'model',
      model_picker_enabled: true,
      preview: false,
      vendor: 'test',
      version: '1',
      supported_endpoints: id.startsWith('claude') ? ['/v1/messages'] : ['/responses'],
      capabilities: {
        family: 'test',
        object: 'model_capabilities',
        type: 'chat',
      },
    })),
  }
}
