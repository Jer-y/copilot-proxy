import type { AccountsConfiguration } from '~/lib/account/types'
import type { ModelsResponse } from '~/services/copilot/get-models'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { AccountRegistry } from '~/lib/account/registry'
import { setDefaultAccountContext, state } from '~/lib/state'
import { buildReadinessStatus } from '~/routes/health/route'
import { buildBoundModelCatalog } from '~/routes/models/route'
import { server } from '~/server'

const originalAccounts = state.accounts
const originalDefault = state.defaultAccount
const originalExposeIdentity = process.env.COPILOT_PROXY_EXPOSE_ACCOUNT_IDENTITY

beforeEach(() => {
  const registry = createRegistry()
  state.accounts = registry
  setDefaultAccountContext(registry.defaultAccount)
})

afterEach(() => {
  state.accounts?.stopRefreshes()
  state.accounts = originalAccounts
  setDefaultAccountContext(originalDefault)
  if (originalExposeIdentity === undefined)
    delete process.env.COPILOT_PROXY_EXPOSE_ACCOUNT_IDENTITY
  else
    process.env.COPILOT_PROXY_EXPOSE_ACCOUNT_IDENTITY = originalExposeIdentity
})

describe('multi-account health and models', () => {
  test('reports safe per-account readiness and supports account-scoped checks', async () => {
    const readiness = await server.request('/readyz')
    expect(readiness.status).toBe(200)
    const text = await readiness.text()
    const body = JSON.parse(text) as {
      accounts: Array<Record<string, unknown>>
    }
    expect(text).toContain('"id":"personal"')
    expect(text).toContain('"id":"work"')
    expect(text).not.toContain('alice-work')
    expect(body.accounts.find(account => account.id === 'work')).toMatchObject({
      token: { tokenAvailable: true, refreshScheduled: true },
      recovery: { globalCircuit: { phase: 'closed' } },
      modelCatalog: { status: 'fresh' },
    })

    const work = await server.request('/readyz?account=work')
    expect(work.status).toBe(200)
    expect(await work.json()).toMatchObject({
      status: 'ready',
      configuration: { explicit: true, revision: 1 },
      account: { id: 'work', availability: 'ready' },
      modelCatalog: { status: 'fresh' },
    })
  })

  test('requires a live token lifecycle and model catalog for account-scoped readiness', async () => {
    const registry = state.accounts!
    const work = registry.get('work')!

    work.tokens.stopRefresh()
    let response = await server.request('/readyz?account=work')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      reasons: ['copilot_token_refresh_unscheduled'],
    })

    work.tokens.startRefresh(3600)
    work.models = undefined
    response = await server.request('/readyz?account=work')
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      reasons: ['model_catalog_unavailable'],
      account: { modelsAvailable: 0 },
    })
  })

  test('makes required routed-account runtime failures hard readiness failures', () => {
    const work = state.accounts!.get('work')!

    work.tokens.stopRefresh()
    expect(buildReadinessStatus()).toMatchObject({
      status: 'degraded',
      reasons: ['required_route_unavailable:responses-http:gpt-5.4'],
      requiredRoutes: [{
        accountId: 'work',
        ready: false,
        reason: 'copilot_token_refresh_unscheduled',
      }],
    })

    work.tokens.startRefresh(3600)
    const getStatus = work.tokens.getStatus.bind(work.tokens)
    work.tokens.getStatus = () => ({ ...getStatus(), expiresInMs: 0 })
    expect(buildReadinessStatus()).toMatchObject({
      status: 'degraded',
      requiredRoutes: [{ ready: false, reason: 'copilot_token_expired' }],
    })

    work.tokens.getStatus = getStatus
    work.recovery.globalCircuit.phase = 'open'
    work.recovery.globalCircuit.openUntil = Date.now() + 60_000
    expect(buildReadinessStatus()).toMatchObject({
      status: 'degraded',
      requiredRoutes: [{ ready: false, reason: 'copilot_upstream_circuit_not_closed' }],
    })
  })

  test('rejects expired account tokens and reports the loaded revision for unknown accounts', async () => {
    const work = state.accounts!.get('work')!
    const getStatus = work.tokens.getStatus.bind(work.tokens)
    work.tokens.getStatus = () => ({ ...getStatus(), expiresInMs: 0 })

    const expired = await server.request('/readyz?account=work')
    expect(expired.status).toBe(503)
    expect(await expired.json()).toMatchObject({
      reasons: ['copilot_token_expired'],
      configuration: { explicit: true, revision: 1 },
    })

    const unknown = await server.request('/readyz?account=missing')
    expect(unknown.status).toBe(503)
    expect(await unknown.json()).toMatchObject({
      reasons: ['unknown_account'],
      configuration: { explicit: true, revision: 1 },
    })

    const empty = await server.request('/readyz?account=')
    expect(empty.status).toBe(503)
    expect(await empty.json()).toMatchObject({
      account: '',
      reasons: ['unknown_account'],
      configuration: { explicit: true, revision: 1 },
    })
  })

  test('exposes identities only under the independent opt-in', async () => {
    process.env.COPILOT_PROXY_EXPOSE_ACCOUNT_IDENTITY = '1'
    const readiness = await server.request('/readyz')
    expect(await readiness.text()).toContain('alice-work')
  })

  test('warns when the default GitHub identity could not be verified', () => {
    state.accounts!.defaultAccount.identityState = 'unverified'

    expect(buildReadinessStatus()).toMatchObject({
      status: 'ready',
      warnings: expect.arrayContaining(['account_identity_unverified']),
    })
  })

  test('aggregates safe warnings from non-default routed accounts', () => {
    const work = state.accounts!.get('work')!
    work.identityState = 'unverified'
    work.modelCatalogLifecycle = {
      consecutiveRefreshFailures: 1,
      lastRefreshAttemptAt: Date.now(),
      lastRefreshFailureAt: Date.now(),
      lastRefreshSuccessAt: Date.now() - 1,
    }

    expect(buildReadinessStatus()).toMatchObject({
      status: 'ready',
      warnings: expect.arrayContaining([
        'account_identity_unverified:work',
        'model_catalog_stale:work',
      ]),
    })
  })

  test('aggregates non-required account runtime failures as warnings', () => {
    state.accounts?.stopRefreshes()
    const registry = createRegistry({ requiredRoutes: [] })
    state.accounts = registry
    setDefaultAccountContext(registry.defaultAccount)
    const work = registry.get('work')!
    work.tokens.stopRefresh()

    expect(buildReadinessStatus()).toMatchObject({
      status: 'ready',
      warnings: expect.arrayContaining(['copilot_token_refresh_unscheduled:work']),
      accounts: expect.arrayContaining([
        expect.objectContaining({
          id: 'work',
          reasons: ['copilot_token_refresh_unscheduled'],
        }),
      ]),
    })
  })

  test('uses the statically bound account metadata for unprefixed models', async () => {
    const response = await server.request('/v1/models')
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<{ id: string, owned_by: string }> }
    expect(body.data.find(model => model.id === 'gpt-5.4')?.owned_by).toBe('work-vendor')
    expect(body.data.find(model => model.id === 'claude-opus-4.8')?.owned_by).toBe('personal-vendor')
  })

  test('normalizes Claude aliases before assessing required-route bindings', () => {
    state.accounts?.stopRefreshes()
    const registry = createRegistry({
      requiredRoutes: [{
        surface: 'anthropic-messages',
        model: 'claude-opus-4-8-20250514',
      }],
      routes: [{ match: 'claude-opus-4.8', account: 'work' }],
    })
    state.accounts = registry
    setDefaultAccountContext(registry.defaultAccount)

    expect(buildReadinessStatus()).toMatchObject({
      status: 'ready',
      requiredRoutes: [{
        accountId: 'work',
        model: 'claude-opus-4-8-20250514',
        ready: true,
      }],
    })
  })

  test('requires an exact live model entry for required WebSocket capability', () => {
    state.accounts?.stopRefreshes()
    const registry = createRegistry({
      requiredRoutes: [{
        surface: 'responses-websocket',
        model: 'gpt-5.4-snapshot',
      }],
      routes: [{ match: 'gpt-*', account: 'work' }],
    })
    const work = registry.get('work')!
    const baseModel = work.models?.data.find(model => model.id === 'gpt-5.4')
    if (!baseModel)
      throw new Error('Expected the work account gpt-5.4 fixture')
    baseModel.supported_endpoints = ['/responses', 'ws:/responses']
    state.accounts = registry
    setDefaultAccountContext(registry.defaultAccount)

    expect(buildReadinessStatus()).toMatchObject({
      status: 'degraded',
      requiredRoutes: [{
        accountId: 'work',
        model: 'gpt-5.4-snapshot',
        ready: false,
        reason: 'model_unavailable',
      }],
    })
  })

  test('keeps default-account readiness separate from the bound cross-account catalog', () => {
    const defaultAccount = state.accounts!.defaultAccount
    defaultAccount.models = undefined

    expect(buildBoundModelCatalog().map(model => model.id)).toEqual(['gpt-5.4'])
    expect(buildReadinessStatus()).toMatchObject({
      status: 'degraded',
      modelsAvailable: 0,
      reasons: expect.arrayContaining(['model_catalog_unavailable']),
    })
  })
})

function createRegistry(
  overrides: Partial<AccountsConfiguration> = {},
): AccountRegistry {
  const configuration: AccountsConfiguration = {
    version: 1,
    revision: 1,
    defaultAccount: 'personal',
    requiredRoutes: [{ surface: 'responses-http', model: 'gpt-5.4' }],
    accounts: [
      { id: 'personal', accountType: 'individual', githubLogin: 'alice', githubUserId: 1 },
      { id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 },
    ],
    routes: [{ match: 'gpt-*', account: 'work' }],
    ...overrides,
  }
  const registry = new AccountRegistry(configuration)
  const personal = registry.get('personal')!
  const work = registry.get('work')!
  prepare(personal, models('personal-vendor'))
  prepare(work, models('work-vendor'))
  return registry
}

function prepare(
  ctx: ReturnType<AccountRegistry['get']> & {},
  modelsResponse: ModelsResponse,
): void {
  ctx.availability = 'ready'
  ctx.identityState = 'ok'
  ctx.copilotToken = `${ctx.id}-token`
  ctx.models = modelsResponse
  ctx.modelCatalogLifecycle = {
    consecutiveRefreshFailures: 0,
    lastRefreshAttemptAt: Date.now(),
    lastRefreshSuccessAt: Date.now(),
  }
  ctx.tokens.startRefresh(3600)
}

function models(vendor: string): ModelsResponse {
  return {
    object: 'list',
    data: [
      makeModel('gpt-5.4', vendor, ['/responses']),
      makeModel('claude-opus-4.8', vendor, ['/v1/messages']),
    ],
  }
}

function makeModel(id: string, vendor: string, supportedEndpoints: string[]) {
  return {
    id,
    name: `${vendor}-${id}`,
    object: 'model',
    model_picker_enabled: true,
    preview: false,
    vendor,
    version: '1',
    supported_endpoints: supportedEndpoints,
    capabilities: {
      family: 'test',
      object: 'model_capabilities',
      type: 'chat',
    },
  }
}
