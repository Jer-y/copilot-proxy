import type { AccountsConfiguration } from '~/lib/account/types'
import type { RunServerOptions } from '~/start'

import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test'

import { AccountRegistry } from '~/lib/account/registry'
import { writeAccountToken } from '~/lib/account/store'
import { PATHS } from '~/lib/paths'
import { setDefaultAccountContext, state } from '~/lib/state'
import { isModelRefreshScheduled } from '~/lib/utils'

const originalFetch = globalThis.fetch
const originalAccounts = state.accounts
const originalDefault = state.defaultAccount

if (process.platform === 'win32')
  setDefaultTimeout(60_000)

beforeEach(() => {
  cleanAccountFiles()
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  state.vsCodeVersion = '1.0.0'
  globalThis.fetch = createUpstreamMock()
})

afterEach(() => {
  state.accounts?.stopRefreshes()
  state.accounts = originalAccounts
  setDefaultAccountContext(originalDefault)
  globalThis.fetch = originalFetch
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  cleanAccountFiles()
})

describe('explicit account registry initialization', () => {
  test('initializes identities, tokens, catalogs, and deterministic default state', async () => {
    writeAccountToken('personal', 'token_personal')
    writeAccountToken('work', 'token_work')
    const registry = new AccountRegistry(configuration())

    await registry.initializeExplicit(runOptions())

    expect(registry.list().map(ctx => [ctx.id, ctx.availability])).toEqual([
      ['personal', 'ready'],
      ['work', 'ready'],
    ])
    expect(registry.get('personal')?.copilotToken).toBe('copilot_personal')
    expect(registry.get('work')?.copilotToken).toBe('copilot_work')
    expect(registry.get('work')?.models?.data[0]?.vendor).toBe('work-vendor')
    expect(state.defaultAccount).toBe(registry.get('personal')!)
  })

  test('continues when only a noncritical non-default account fails', async () => {
    writeAccountToken('personal', 'token_personal')
    writeAccountToken('work', 'token_broken')
    const registry = new AccountRegistry(configuration())

    await registry.initializeExplicit(runOptions())

    expect(registry.defaultAccount.availability).toBe('ready')
    expect(registry.get('work')).toMatchObject({
      availability: 'unavailable',
      unavailableReason: 'initialization_failed',
    })
  })

  test('keeps an identity-unverified noncritical account unavailable without requesting Copilot state', async () => {
    writeAccountToken('personal', 'token_personal')
    writeAccountToken('work', 'token_work_unverified')
    const requests: Array<{ authorization: string | null, url: string }> = []
    globalThis.fetch = createIdentityFailureMock(requests)
    const registry = new AccountRegistry(configuration())

    await registry.initializeExplicit(runOptions())

    expect(registry.defaultAccount.availability).toBe('ready')
    const work = registry.get('work')!
    expect(work).toMatchObject({
      availability: 'unavailable',
      identityState: 'unverified',
      unavailableReason: 'identity_unverified',
    })
    expect(work.copilotToken).toBeUndefined()
    expect(work.models).toBeUndefined()
    expect(requests.some(request => request.authorization === 'token token_work_unverified'
      && request.url.includes('/copilot_internal/v2/token'))).toBe(false)
    expect(requests.some(request => request.authorization === 'Bearer copilot_work_unverified'
      && request.url.endsWith('/models'))).toBe(false)
  })

  test('fails closed before Copilot token or model loading when ambient GH_TOKEN identity is unverified', async () => {
    writeAccountToken('personal', 'token_personal')
    writeAccountToken('work', 'token_work')
    process.env.GH_TOKEN = 'token_ambient_wrong_identity'
    const requests: Array<{ authorization: string | null, url: string }> = []
    globalThis.fetch = createIdentityFailureMock(requests)
    const registry = new AccountRegistry(configuration())

    await expect(registry.initializeExplicit(runOptions()))
      .rejects
      .toThrow('Default account personal is unavailable: identity_unverified')

    expect(registry.defaultAccount).toMatchObject({
      availability: 'unavailable',
      identityState: 'unverified',
      unavailableReason: 'identity_unverified',
    })
    expect(registry.defaultAccount.copilotToken).toBeUndefined()
    expect(registry.defaultAccount.models).toBeUndefined()
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
    expect(requests.some(request => request.authorization === 'token token_ambient_wrong_identity'
      && request.url.includes('/copilot_internal/v2/token'))).toBe(false)
    expect(requests.some(request => request.authorization === 'Bearer copilot_ambient_wrong_identity'
      && request.url.endsWith('/models'))).toBe(false)
  })

  test('fails fast when the default account cannot initialize', async () => {
    writeAccountToken('personal', 'token_broken')
    writeAccountToken('work', 'token_work')
    const registry = new AccountRegistry(configuration())
    const observations = observeRefreshCleanup(registry)

    try {
      await expect(registry.initializeExplicit(runOptions())).rejects.toThrow('Default account personal is unavailable')
      expectRefreshCleanup(observations)
    }
    finally {
      observations.forEach(observation => observation.cancel.mockRestore())
    }
  })

  test('cancels every account refresh when a required-route gate fails', async () => {
    writeAccountToken('personal', 'token_personal')
    writeAccountToken('work', 'token_work')
    const config = configuration()
    config.requiredRoutes = [{ surface: 'responses-websocket', model: 'claude-opus-4.8' }]
    const registry = new AccountRegistry(config)
    const observations = observeRefreshCleanup(registry)

    try {
      await expect(registry.initializeExplicit(runOptions())).rejects.toThrow('Required Copilot routes are unavailable')
      expectRefreshCleanup(observations)
    }
    finally {
      observations.forEach(observation => observation.cancel.mockRestore())
    }
  })
})

function observeRefreshCleanup(registry: AccountRegistry) {
  return registry.list().map(ctx => ({
    cancel: spyOn(ctx.tokens, 'cancelInFlight'),
    ctx,
  }))
}

function expectRefreshCleanup(
  observations: ReturnType<typeof observeRefreshCleanup>,
): void {
  for (const observation of observations) {
    expect(observation.cancel).toHaveBeenCalledTimes(1)
    expect(observation.cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(observation.ctx.tokens.getStatus().refreshScheduled).toBe(false)
    expect(isModelRefreshScheduled(observation.ctx)).toBe(false)
  }
}

function configuration(): AccountsConfiguration {
  return {
    version: 1,
    revision: 1,
    defaultAccount: 'personal',
    requiredRoutes: [],
    accounts: [
      { id: 'personal', accountType: 'individual', githubLogin: 'alice', githubUserId: 1 },
      { id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 },
    ],
    routes: [{ match: 'claude-*', account: 'work' }],
  }
}

function runOptions(): RunServerOptions {
  return {
    port: 4399,
    host: '127.0.0.1',
    verbose: false,
    accountType: 'individual',
    manual: false,
    rateLimitWait: false,
    claudeCode: false,
    showToken: false,
    proxyEnv: false,
  }
}

function createUpstreamMock(): typeof fetch {
  return mock(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    const authorization = new Headers(init?.headers).get('authorization')
    if (target.endsWith('/user')) {
      if (authorization === 'token token_personal')
        return Response.json({ id: 1, login: 'alice' })
      if (authorization === 'token token_work')
        return Response.json({ id: 2, login: 'alice-work' })
      if (authorization === 'token token_broken')
        return Response.json({ id: 2, login: 'alice-work' })
    }
    if (target.includes('/copilot_internal/v2/token')) {
      if (authorization === 'token token_broken')
        return new Response('unauthorized', { status: 401 })
      const suffix = authorization === 'token token_work' ? 'work' : 'personal'
      return Response.json({
        token: `copilot_${suffix}`,
        refresh_in: 3600,
        expires_at: 2_000_000_000,
      })
    }
    if (target.endsWith('/models')) {
      const suffix = authorization === 'Bearer copilot_work' ? 'work' : 'personal'
      return Response.json({
        object: 'list',
        data: [{
          id: suffix === 'work' ? 'claude-opus-4.8' : 'gpt-5.4',
          name: suffix,
          object: 'model',
          model_picker_enabled: true,
          preview: false,
          vendor: `${suffix}-vendor`,
          version: '1',
          supported_endpoints: suffix === 'work' ? ['/v1/messages'] : ['/responses'],
          capabilities: { family: 'test', object: 'model_capabilities', type: 'chat' },
        }],
      })
    }
    return new Response('unexpected request', { status: 500 })
  }) as unknown as typeof fetch
}

function createIdentityFailureMock(
  requests: Array<{ authorization: string | null, url: string }>,
): typeof fetch {
  return mock(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    const authorization = new Headers(init?.headers).get('authorization')
    requests.push({ authorization, url: target })

    if (target.endsWith('/user')) {
      if (authorization === 'token token_personal')
        return Response.json({ id: 1, login: 'alice' })
      if (authorization === 'token token_work')
        return Response.json({ id: 2, login: 'alice-work' })
      return new Response('identity unavailable', { status: 503 })
    }
    if (target.includes('/copilot_internal/v2/token')) {
      const suffix = authorization?.replace('token token_', '') ?? 'unknown'
      return Response.json({
        token: `copilot_${suffix}`,
        refresh_in: 3600,
        expires_at: 2_000_000_000,
      })
    }
    if (target.endsWith('/models')) {
      return Response.json({
        object: 'list',
        data: [{
          id: authorization === 'Bearer copilot_work' ? 'claude-opus-4.8' : 'gpt-5.4',
          name: 'test',
          object: 'model',
          model_picker_enabled: true,
          preview: false,
          vendor: 'test',
          version: '1',
          supported_endpoints: ['/responses'],
          capabilities: { family: 'test', object: 'model_capabilities', type: 'chat' },
        }],
      })
    }
    return new Response('unexpected request', { status: 500 })
  }) as unknown as typeof fetch
}

function cleanAccountFiles(): void {
  for (const filePath of [
    PATHS.ACCOUNTS_CONFIG,
    PATHS.ACCOUNTS_LOCK,
    PATHS.RUNTIME_LOCK,
    path.join(PATHS.APP_DIR, 'account-state.lock'),
  ]) {
    fs.rmSync(filePath, { force: true, recursive: true })
  }
  fs.rmSync(PATHS.TOKENS_DIR, { force: true, recursive: true })
}
