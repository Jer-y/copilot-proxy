import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test'

import { APPLIED_NATIVE_SERVICE_DATA_DIR_ENV, getNativeServiceControlStatePath } from '~/daemon/service-install-state'
import { acquireRuntimeLock } from '~/lib/account/lock'
import { addAccount, authenticateExistingAccount, isExpectedAccountReadinessResponse, isInstalledNativeServiceRunning, removeAccount, removeAccountRoute, removeRequiredAccountRoute, setAccountMaxConcurrency, setAccountRoute, setDefaultAccount, setRequiredAccountRoute } from '~/lib/account/operations'
import { accountTokenPath, readAccountsConfiguration, writeAccountsConfiguration } from '~/lib/account/store'
import { PATHS } from '~/lib/paths'

const originalFetch = globalThis.fetch
let editorVersions: Array<string | null> = []

if (process.platform === 'win32')
  setDefaultTimeout(60_000)

beforeEach(() => {
  cleanAccountFiles()
  editorVersions = []
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    if (target.includes('update.code.visualstudio.com'))
      return Response.json(['1.111.0'])

    const headers = new Headers(init?.headers)
    if (target.includes('/copilot_internal/v2/token') || target.endsWith('/models'))
      editorVersions.push(headers.get('editor-version'))
    const token = new Headers(init?.headers).get('authorization')?.replace(/^token /, '')
    const identities: Record<string, { id: number, login: string }> = {
      token_personal: { id: 1, login: 'alice' },
      token_personal_new: { id: 1, login: 'alice' },
      token_work: { id: 2, login: 'alice-work' },
      token_work_new: { id: 2, login: 'alice-work' },
      token_no_copilot: { id: 3, login: 'no-copilot' },
      token_empty_catalog: { id: 4, login: 'empty-catalog' },
    }
    if (target.endsWith('/user')) {
      const identity = token ? identities[token] : undefined
      return identity
        ? Response.json(identity)
        : new Response('unauthorized', { status: 401 })
    }

    if (target.includes('/copilot_internal/v2/token')) {
      if (token === 'token_no_copilot')
        return new Response('forbidden', { status: 403 })
      if (!token || !identities[token])
        return new Response('unauthorized', { status: 401 })
      return Response.json({
        expires_at: 2_000_000_000,
        refresh_in: 3600,
        token: `copilot_${token.replace(/^token_/, '')}`,
      })
    }

    if (target.endsWith('/models')) {
      const bearer = headers.get('authorization')?.replace(/^Bearer /, '')
      if (bearer === 'copilot_empty_catalog')
        return Response.json({ object: 'list', data: [] })
      const work = bearer === 'copilot_work'
      return Response.json({
        object: 'list',
        data: [makeModel(work ? 'claude-opus-4.8' : 'gpt-5.4', work ? ['/v1/messages'] : ['/responses'])],
      })
    }

    return new Response('unexpected request', { status: 500 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanAccountFiles()
})

describe('account configuration operations without a running proxy', () => {
  test('ignores broken global native-service state for an explicit alternate data-dir mutation', async () => {
    const controlStatePath = getNativeServiceControlStatePath()
    fs.writeFileSync(controlStatePath, '{invalid global control state', { mode: 0o600 })
    delete process.env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]

    try {
      await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
      expect(readAccountsConfiguration()).toMatchObject({
        defaultAccount: 'personal',
        revision: 1,
      })
    }
    finally {
      fs.rmSync(controlStatePath, { force: true })
      delete process.env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]
    }
  })

  test('detects a running installed service that predates runtime.lock', async () => {
    const loadRunning = async () => ({
      captureAutoStartState: () => ({ enabled: true, installed: true, running: true }),
    }) as never
    const loadStopped = async () => ({
      captureAutoStartState: () => ({ enabled: true, installed: true, running: false }),
    }) as never

    const installedState = { dataDir: PATHS.APP_DIR }
    expect(await isInstalledNativeServiceRunning(loadRunning, installedState)).toBe(true)
    expect(await isInstalledNativeServiceRunning(loadStopped, installedState)).toBe(false)
    expect(await isInstalledNativeServiceRunning(async () => null, installedState)).toBe(false)
    expect(await isInstalledNativeServiceRunning(loadRunning, {
      dataDir: path.join(PATHS.APP_DIR, 'other'),
    })).toBe(false)

    const aliasRoot = fs.mkdtempSync(path.join(path.dirname(PATHS.APP_DIR), 'copilot-proxy-app-alias-'))
    const aliasPath = path.join(aliasRoot, 'app-alias')
    try {
      fs.symlinkSync(PATHS.APP_DIR, aliasPath, process.platform === 'win32' ? 'junction' : 'dir')
      expect(await isInstalledNativeServiceRunning(
        loadRunning,
        { dataDir: aliasPath },
        PATHS.APP_DIR,
      )).toBe(true)
    }
    finally {
      fs.rmSync(aliasRoot, { force: true, recursive: true })
    }
  })

  test('adds, re-authenticates, routes, and removes with revisioned disk state', async () => {
    await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    await addAccount({ id: 'work', accountType: 'enterprise', token: 'token_work' })
    expect(readAccountsConfiguration()).toMatchObject({
      revision: 2,
      defaultAccount: 'personal',
      accounts: [{ id: 'personal' }, { id: 'work' }],
    })

    await authenticateExistingAccount({ id: 'personal', token: 'token_personal_new' })
    expect(fs.readFileSync(accountTokenPath('personal'), 'utf8')).toBe('token_personal_new')

    await setAccountRoute('claude-*', 'work')
    await expect(removeAccount('work')).rejects.toThrow('still referenced')
    await removeAccountRoute('claude-*')
    await removeAccount('work')

    const configuration = readAccountsConfiguration()
    expect(configuration?.accounts.map(account => account.id)).toEqual(['personal'])
    expect(configuration?.revision).toBe(5)
    expect(fs.existsSync(accountTokenPath('work'))).toBe(false)
  })

  test('rejects duplicate GitHub identities before changing disk state', async () => {
    await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    await expect(addAccount({ id: 'duplicate', accountType: 'enterprise', token: 'token_personal_new' }))
      .rejects
      .toThrow('already configured')
    expect(readAccountsConfiguration()?.accounts).toHaveLength(1)
  })

  test('validates Copilot access and a non-empty model catalog before the first publish', async () => {
    await expect(addAccount({ id: 'blocked', accountType: 'individual', token: 'token_no_copilot' }))
      .rejects
      .toThrow('failed Copilot validation')
    expect(readAccountsConfiguration()).toBeUndefined()
    expect(fs.existsSync(accountTokenPath('blocked'))).toBe(false)

    await expect(addAccount({ id: 'empty', accountType: 'individual', token: 'token_empty_catalog' }))
      .rejects
      .toThrow('model catalog is empty')
    expect(readAccountsConfiguration()).toBeUndefined()
    expect(fs.existsSync(accountTokenPath('empty'))).toBe(false)
  })

  test('initializes the VS Code version before offline Copilot validation', async () => {
    await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    expect(editorVersions.length).toBeGreaterThan(0)
    expect(editorVersions).not.toContain('vscode/undefined')
    expect(editorVersions.every(value => value === 'vscode/1.111.0')).toBe(true)
  })

  test('publishes token files before accounts.json', async () => {
    const renameSync = fs.renameSync.bind(fs)
    let tokenExistedAtConfigPublish = false
    const rename = spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
      if (String(newPath) === PATHS.ACCOUNTS_CONFIG)
        tokenExistedAtConfigPublish = fs.existsSync(accountTokenPath('personal'))
      return renameSync(oldPath, newPath)
    })
    try {
      await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    }
    finally {
      rename.mockRestore()
    }
    expect(tokenExistedAtConfigPublish).toBe(true)
  })

  test('aborts without publishing when a foreground runtime wins during offline validation', async () => {
    const upstreamFetch = globalThis.fetch
    let releaseValidation!: () => void
    let signalValidationStarted!: () => void
    const validationStarted = new Promise<void>((resolve) => {
      signalValidationStarted = resolve
    })
    const validationRelease = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    let userRequests = 0
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/user') && ++userRequests === 2) {
        signalValidationStarted()
        await validationRelease
      }
      return await upstreamFetch(url, init)
    }) as unknown as typeof fetch

    const mutation = addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    await validationStarted
    const runtimeLock = await acquireRuntimeLock({
      host: '127.0.0.1',
      nativeService: false,
      port: 4399,
    })
    try {
      releaseValidation()
      await expect(mutation).rejects.toThrow('foreground copilot-proxy process is running')
      expect(readAccountsConfiguration()).toBeUndefined()
      expect(fs.existsSync(accountTokenPath('personal'))).toBe(false)
    }
    finally {
      runtimeLock.release()
      globalThis.fetch = upstreamFetch
    }
  })

  test('validates candidate default and required-route capabilities while offline', async () => {
    await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    await addAccount({ id: 'work', accountType: 'enterprise', token: 'token_work' })
    const current = readAccountsConfiguration()!
    writeAccountsConfiguration({
      ...current,
      revision: current.revision + 1,
      requiredRoutes: [{ surface: 'responses-http', model: 'gpt-5.4' }],
      routes: [{ match: 'gpt-*', account: 'personal' }],
    })
    const before = readAccountsConfiguration()!

    await expect(setAccountRoute('gpt-*', 'work'))
      .rejects
      .toThrow('Required Copilot routes are unavailable')
    expect(readAccountsConfiguration()).toEqual(before)

    writeAccountsConfiguration({
      ...before,
      revision: before.revision + 1,
      routes: [],
    })
    const beforeDefault = readAccountsConfiguration()!
    await expect(setDefaultAccount('work'))
      .rejects
      .toThrow('Required Copilot routes are unavailable')
    expect(readAccountsConfiguration()).toEqual(beforeDefault)
  })

  test('re-authentication preserves default and required-route capability gates', async () => {
    await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    await addAccount({ id: 'work', accountType: 'enterprise', token: 'token_work' })
    const current = readAccountsConfiguration()!
    writeAccountsConfiguration({
      ...current,
      revision: current.revision + 1,
      requiredRoutes: [{ surface: 'anthropic-messages', model: 'claude-opus-4.8' }],
      routes: [{ match: 'claude-*', account: 'work' }],
    })

    await expect(authenticateExistingAccount({ id: 'work', token: 'token_work_new' }))
      .rejects
      .toThrow('Required Copilot routes are unavailable')
    expect(fs.readFileSync(accountTokenPath('work'), 'utf8')).toBe('token_work')
  })

  test('moves the most recently set route ahead of older overlapping rules', async () => {
    await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    await addAccount({ id: 'work', accountType: 'enterprise', token: 'token_work' })
    await setAccountRoute('*', 'personal')
    await setAccountRoute('claude-*', 'work')

    expect(readAccountsConfiguration()?.routes).toEqual([
      { match: 'claude-*', account: 'work' },
      { match: '*', account: 'personal' },
    ])

    await setAccountRoute('*', 'work')
    expect(readAccountsConfiguration()?.routes).toEqual([
      { match: '*', account: 'work' },
      { match: 'claude-*', account: 'work' },
    ])
  })

  test('requires exact configuration revision and full account readiness in native probes', () => {
    const configuration = {
      version: 1 as const,
      revision: 7,
      defaultAccount: 'personal',
      requiredRoutes: [],
      accounts: [{
        id: 'personal',
        accountType: 'individual' as const,
        githubLogin: 'alice',
        githubUserId: 1,
      }],
      routes: [],
    }
    const body = (revision: number, status = 'ready', reasons: string[] = []) => JSON.stringify({
      status,
      reasons,
      configuration: { explicit: true, revision },
    })

    expect(isExpectedAccountReadinessResponse(200, body(7), configuration, 'ready')).toBe(true)
    expect(isExpectedAccountReadinessResponse(200, body(6), configuration, 'ready')).toBe(false)
    expect(isExpectedAccountReadinessResponse(503, body(7, 'degraded', ['model_catalog_unavailable']), configuration, 'ready')).toBe(false)
    expect(isExpectedAccountReadinessResponse(503, body(7, 'degraded'), configuration, 'loaded')).toBe(true)
    expect(isExpectedAccountReadinessResponse(503, body(7, 'degraded', ['unknown_account']), configuration, 'absent')).toBe(true)
    expect(isExpectedAccountReadinessResponse(503, body(7, 'degraded', ['initialization_failed']), configuration, 'known')).toBe(true)
    expect(isExpectedAccountReadinessResponse(503, body(7, 'degraded', ['unknown_account']), configuration, 'known')).toBe(false)

    const requiredRoute = [{
      accountId: 'personal',
      model: 'gpt-5.4',
      ready: true,
      surface: 'responses-http',
    }]
    const routeBody = (ready: boolean, accountId = 'personal') => JSON.stringify({
      status: 'degraded',
      reasons: [],
      configuration: { explicit: true, revision: 7 },
      requiredRoutes: [{
        accountId,
        model: 'gpt-5.4',
        ready,
        surface: 'responses-http',
      }],
    })
    expect(isExpectedAccountReadinessResponse(503, routeBody(true), configuration, 'loaded', requiredRoute)).toBe(true)
    expect(isExpectedAccountReadinessResponse(503, routeBody(false), configuration, 'loaded', requiredRoute)).toBe(false)
    expect(isExpectedAccountReadinessResponse(503, routeBody(true, 'work'), configuration, 'loaded', requiredRoute)).toBe(false)

    const accountBody = (accountId: string, status = 'ready', reasons: string[] = []) => JSON.stringify({
      status,
      reasons,
      configuration: { explicit: true, revision: 7 },
      account: status === 'ready' || !reasons.includes('unknown_account')
        ? { id: accountId }
        : accountId,
    })
    expect(isExpectedAccountReadinessResponse(200, accountBody('personal'), configuration, 'ready', [], 'personal')).toBe(true)
    expect(isExpectedAccountReadinessResponse(200, accountBody('work'), configuration, 'ready', [], 'personal')).toBe(false)
    expect(isExpectedAccountReadinessResponse(503, accountBody('personal', 'degraded', ['initialization_failed']), configuration, 'known', [], 'personal')).toBe(true)
    expect(isExpectedAccountReadinessResponse(503, accountBody('work', 'degraded', ['initialization_failed']), configuration, 'known', [], 'personal')).toBe(false)
    expect(isExpectedAccountReadinessResponse(503, accountBody('personal', 'degraded', ['unknown_account']), configuration, 'absent', [], 'personal')).toBe(true)
    expect(isExpectedAccountReadinessResponse(503, accountBody('work', 'degraded', ['unknown_account']), configuration, 'absent', [], 'personal')).toBe(false)
  })

  test('configures per-account concurrency and required routes through transactions', async () => {
    await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })

    await setAccountMaxConcurrency('personal', 3)
    expect(readAccountsConfiguration()?.accounts[0]?.maxConcurrency).toBe(3)
    await setAccountMaxConcurrency('personal', undefined)
    expect(readAccountsConfiguration()?.accounts[0]).not.toHaveProperty('maxConcurrency')

    await setRequiredAccountRoute('responses-http', 'gpt-5.4')
    expect(readAccountsConfiguration()?.requiredRoutes).toEqual([
      { surface: 'responses-http', model: 'gpt-5.4' },
    ])
    await removeRequiredAccountRoute('responses-http', 'gpt-5.4')
    expect(readAccountsConfiguration()?.requiredRoutes).toEqual([])
  })

  test('normalizes a required-route alias before selecting accounts for offline validation', async () => {
    await addAccount({ id: 'personal', accountType: 'individual', token: 'token_personal' })
    await addAccount({ id: 'work', accountType: 'enterprise', token: 'token_work' })
    await setAccountRoute('claude-opus-4.8', 'work')

    await expect(setRequiredAccountRoute(
      'anthropic-messages',
      'claude-opus-4-8-20250514',
    )).resolves.toMatchObject({
      requiredRoutes: [{
        model: 'claude-opus-4-8-20250514',
        surface: 'anthropic-messages',
      }],
    })
  })
})

function makeModel(id: string, supportedEndpoints: string[]) {
  return {
    id,
    name: id,
    object: 'model',
    model_picker_enabled: true,
    preview: false,
    vendor: 'test',
    version: '1',
    supported_endpoints: supportedEndpoints,
    capabilities: {
      family: 'test',
      object: 'model_capabilities',
      type: 'chat',
    },
  }
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
