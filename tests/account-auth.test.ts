import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'

import { accountsProxyRequiredTargets } from '~/accounts'
import { runAuth } from '~/auth'
import { assertProxyEndpointAvailable } from '~/daemon/service-env'
import { readTokenFromStdin } from '~/lib/account/auth'
import { readAccountToken, writeAccountsConfiguration, writeAccountToken } from '~/lib/account/store'
import { PATHS } from '~/lib/paths'

const originalFetch = globalThis.fetch

if (process.platform === 'win32')
  setDefaultTimeout(15_000)

beforeEach(() => {
  cleanAccountFiles()
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    const authorization = new Headers(init?.headers).get('authorization')
    if (target.includes('update.code.visualstudio.com'))
      return Response.json(['1.111.0'])
    if (target.endsWith('/user')) {
      if (authorization === 'token token_new' || authorization === 'token token_old')
        return Response.json({ id: 1, login: 'alice' })
      return new Response('unauthorized', { status: 401 })
    }
    if (target.includes('/copilot_internal/v2/token')) {
      if (authorization !== 'token token_new' && authorization !== 'token token_old')
        return new Response('unauthorized', { status: 401 })
      return Response.json({
        expires_at: 2_000_000_000,
        refresh_in: 3600,
        token: authorization === 'token token_new' ? 'copilot_new' : 'copilot_old',
      })
    }
    if (target.endsWith('/models')) {
      return Response.json({
        object: 'list',
        data: [makeModel('gpt-5.4')],
      })
    }
    return new Response('unexpected request', { status: 500 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  delete process.env.GH_TOKEN
  delete process.env.GITHUB_TOKEN
  cleanAccountFiles()
})

describe('account token stdin', () => {
  test('removes exactly one trailing newline without trimming other whitespace', async () => {
    expect(await read('ghp_test\n')).toBe('ghp_test')
    expect(await read('ghp_test\r\n')).toBe('ghp_test')
    await expect(read(' ghp_test\n')).rejects.toThrow('whitespace')
    await expect(read('ghp_test\n\n')).rejects.toThrow('whitespace')
  })

  test('rejects empty and oversized input', async () => {
    await expect(read('\n')).rejects.toThrow('empty')
    await expect(read('x'.repeat(8 * 1024 + 1))).rejects.toThrow('exceeds')
  })
})

describe('explicit account authentication preflight', () => {
  test('requires every account validation endpoint to remain on the selected proxy route', async () => {
    writeAccountsConfiguration({
      version: 1,
      revision: 1,
      defaultAccount: 'work',
      requiredRoutes: [],
      accounts: [{ id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 }],
      routes: [],
    })

    const proxyEnvironment = {
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
      NO_PROXY: 'api.enterprise.githubcopilot.com',
    }
    expect(() => assertProxyEndpointAvailable(
      proxyEnvironment,
      accountsProxyRequiredTargets([], false),
    )).toThrow('Refusing to fall back to a direct connection')
    expect(() => assertProxyEndpointAvailable({
      HTTPS_PROXY: proxyEnvironment.HTTPS_PROXY,
      NO_PROXY: 'github.com',
    }, accountsProxyRequiredTargets([], false))).not.toThrow()
    expect(() => assertProxyEndpointAvailable({
      HTTPS_PROXY: proxyEnvironment.HTTPS_PROXY,
      NO_PROXY: 'github.com',
    }, accountsProxyRequiredTargets([], true))).toThrow('Refusing to fall back to a direct connection')

    const previousHttpsProxy = process.env.HTTPS_PROXY
    const previousNoProxy = process.env.NO_PROXY
    process.env.HTTPS_PROXY = proxyEnvironment.HTTPS_PROXY
    try {
      for (const bypass of ['api.enterprise.githubcopilot.com', 'update.code.visualstudio.com']) {
        process.env.NO_PROXY = bypass
        await expect(runAuth({
          account: 'work',
          ifNeeded: false,
          proxyEnv: true,
          showToken: false,
          tokenStdin: true,
          verbose: false,
        })).rejects.toThrow('Refusing to fall back to a direct connection')
      }
    }
    finally {
      if (previousHttpsProxy === undefined)
        delete process.env.HTTPS_PROXY
      else
        process.env.HTTPS_PROXY = previousHttpsProxy
      if (previousNoProxy === undefined)
        delete process.env.NO_PROXY
      else
        process.env.NO_PROXY = previousNoProxy
    }
  })

  test('reuses required per-account tokens without creating the legacy token file', async () => {
    writeConfiguration()
    writeAccountToken('personal', 'token_old')

    await runAuth(authOptions())

    expect(readAccountToken('personal')).toBe('token_old')
    expect(fs.existsSync(PATHS.GITHUB_TOKEN_PATH)).toBe(false)
  })

  test('persists a launcher environment token into the explicit default account', async () => {
    writeConfiguration()
    writeAccountToken('personal', 'token_old')
    process.env.GH_TOKEN = 'token_new'

    await runAuth(authOptions())

    expect(readAccountToken('personal')).toBe('token_new')
    expect(fs.existsSync(PATHS.GITHUB_TOKEN_PATH)).toBe(false)
    expect(process.env.GH_TOKEN).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })

  test('fails closed for ambiguous normal auth and missing critical account tokens', async () => {
    writeConfiguration()
    await expect(runAuth({ ...authOptions(), ifNeeded: false }))
      .rejects
      .toThrow('specify --account')
    expect(fs.existsSync(PATHS.GITHUB_TOKEN_PATH)).toBe(false)

    writeAccountToken('personal', 'token_old')
    const configuration = writeConfiguration()
    writeAccountsConfiguration({
      ...configuration,
      revision: configuration.revision + 1,
      requiredRoutes: [{ surface: 'responses-http', model: 'gpt-5.4' }],
      routes: [{ match: 'gpt-*', account: 'work' }],
    })
    await expect(runAuth(authOptions()))
      .rejects
      .toThrow('work')
  })
})

async function read(value: string): Promise<string> {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean }
  stream.isTTY = false
  stream.end(value)
  return await readTokenFromStdin(stream as unknown as NodeJS.ReadStream)
}

function authOptions() {
  return {
    ifNeeded: true,
    proxyEnv: false,
    showToken: false,
    verbose: false,
  }
}

function writeConfiguration() {
  const configuration = {
    version: 1 as const,
    revision: 1,
    defaultAccount: 'personal',
    requiredRoutes: [],
    accounts: [
      { id: 'personal', accountType: 'individual' as const, githubLogin: 'alice', githubUserId: 1 },
      { id: 'work', accountType: 'enterprise' as const, githubLogin: 'alice-work', githubUserId: 2 },
    ],
    routes: [],
  }
  writeAccountsConfiguration(configuration)
  return configuration
}

function makeModel(id: string) {
  return {
    id,
    name: id,
    object: 'model',
    model_picker_enabled: true,
    preview: false,
    vendor: 'test',
    version: '1',
    supported_endpoints: ['/responses'],
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
    PATHS.GITHUB_TOKEN_PATH,
    PATHS.RUNTIME_LOCK,
    path.join(PATHS.APP_DIR, 'account-state.lock'),
  ]) {
    fs.rmSync(filePath, { force: true, recursive: true })
  }
  fs.rmSync(PATHS.TOKENS_DIR, { force: true, recursive: true })
}
