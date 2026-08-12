import type { ModelsCommandDependencies } from '~/models'
import type { Model, ModelsResponse } from '~/services/copilot/get-models'
import fs from 'node:fs'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { assertProxyEndpointAvailable } from '~/daemon/service-env'
import { createAccountContext } from '~/lib/account/context'
import { AccountRegistry } from '~/lib/account/registry'
import { writeAccountsConfiguration, writeAccountToken } from '~/lib/account/store'
import { compatibleModelsForClient } from '~/lib/client-setup'
import { PATHS } from '~/lib/paths'
import { modelsProxyRequiredTargets, runModels } from '~/models'

const originalFetch = globalThis.fetch

describe('models command', () => {
  test('authenticates, fetches the live inventory, and emits complete JSON profiles', async () => {
    const events: Array<string> = []
    const output: Array<string> = []
    const profiles = await runModels({
      accountType: 'business',
      client: 'codex',
      json: true,
      proxyEnv: true,
    }, makeDependencies(events, output))

    expect(events).toEqual([
      'select-account:business:default',
      'ensure-paths',
      'validate-proxy:business:true',
      'initialize-http:true',
      'load-vscode-version',
      'authenticate',
      'fetch-models',
    ])
    expect(profiles.map(profile => profile.id)).toEqual(['gpt-live-responses', 'claude-live'])

    const body = JSON.parse(output.join('')) as {
      account: string
      account_type: string
      client: string
      data: Array<{
        id: string
        routes: { responsesHttp: { mode: string } }
      }>
      documentation: string
      object: string
    }
    expect(body).toMatchObject({
      object: 'copilot_proxy.model_capability_profiles',
      account: 'default',
      account_type: 'business',
      client: 'codex',
      documentation: 'docs/protocol-compatibility.md',
    })
    expect(body.data[0]).toMatchObject({
      id: 'gpt-live-responses',
      routes: {
        responsesHttp: { mode: 'direct' },
      },
    })
    expect(body.data[0]).not.toHaveProperty('validationEvidence')
    expect(body.data[0]).not.toHaveProperty('productSupport')
    expect(output.join('')).not.toContain('trajectory-compaction')
    expect(compatibleModelsForClient('codex', makeModelsResponse().data)
      .map(choice => choice.model.id)).not.toContain('trajectory-compaction')
  })

  test('renders a readable client-filtered matrix', async () => {
    const output: Array<string> = []
    const profiles = await runModels({
      accountType: 'individual',
      client: 'claude',
      json: false,
      proxyEnv: false,
    }, makeDependencies([], output))

    expect(profiles.map(profile => profile.id)).toEqual(['gpt-live-responses', 'claude-live'])
    expect(output[0]).toContain('Copilot model compatibility (account: individual, client: claude)')
    expect(output[0]).toContain('MESSAGES')
    expect(output[0]).toContain('gpt-live-responses')
    expect(output[0]).toContain('translated/conditional')
    expect(output[0]).toContain('claude-live')
    expect(output[0]).toContain('direct/stable')
    expect(output[0]).not.toContain('chat-only\n')
    expect(output[0]).not.toContain('trajectory-compaction')
    expect(output[0]).toContain('routing evidence only')
  })

  test('rejects invalid account and client values before doing any work', async () => {
    const events: Array<string> = []
    const dependencies = makeDependencies(events, [])

    await expect(runModels({
      accountType: 'team',
      client: 'all',
      json: false,
      proxyEnv: false,
    }, dependencies)).rejects.toThrow('Invalid account-type')
    await expect(runModels({
      accountType: 'individual',
      client: 'unknown',
      json: false,
      proxyEnv: false,
    }, dependencies)).rejects.toThrow('Invalid client')
    expect(events).toEqual([])
  })

  test('rejects an explicitly empty account and only requires device-flow routing for legacy mode', async () => {
    cleanAccountState()
    await expect(runModels({
      account: '',
      accountType: 'individual',
      client: 'all',
      json: true,
      proxyEnv: false,
    })).rejects.toThrow('--account must contain an account id')

    const explicitTargets = modelsProxyRequiredTargets({ accountType: 'enterprise', explicit: true })
    expect(explicitTargets).not.toContain('https://github.com')
    expect(modelsProxyRequiredTargets({ accountType: 'enterprise', explicit: false })).toContain('https://github.com')
    expect(() => assertProxyEndpointAvailable({
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
      NO_PROXY: 'github.com',
    }, explicitTargets)).not.toThrow()
  })

  test('rejects malformed live model fields before rendering profiles', async () => {
    const dependencies = makeDependencies([], [])
    dependencies.fetchModels = async () => {
      const malformed = makeModelsResponse() as unknown as {
        data: Array<Record<string, unknown>>
        object: string
      }
      malformed.data[0]!.model_picker_enabled = 'false'
      return malformed as unknown as ModelsResponse
    }

    await expect(runModels({
      accountType: 'individual',
      client: 'all',
      json: true,
      proxyEnv: false,
    }, dependencies)).rejects.toThrow('boolean model_picker_enabled')
  })

  test('uses the explicit default enterprise account and never the coexisting legacy token', async () => {
    cleanAccountState()
    writeAccountsConfiguration({
      version: 1,
      revision: 1,
      defaultAccount: 'work',
      requiredRoutes: [],
      accounts: [
        { id: 'personal', accountType: 'individual', githubLogin: 'alice', githubUserId: 1 },
        { id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 },
      ],
      routes: [{ match: 'gpt-*', account: 'personal' }],
    })
    writeAccountToken('personal', 'token_personal')
    writeAccountToken('work', 'token_work')
    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, 'token_legacy', { mode: 0o600 })

    const requests: Array<{ authorization: string | null, target: string }> = []
    const output: string[] = []
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input)
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      const authorization = headers.get('authorization')
      requests.push({ authorization, target })
      if (target.includes('update.code.visualstudio.com'))
        return Response.json(['1.111.0'])
      if (target === 'https://api.github.com/user') {
        return authorization === 'token token_work'
          ? Response.json({ id: 2, login: 'alice-work' })
          : new Response('wrong GitHub identity token', { status: 401 })
      }
      if (target.endsWith('/copilot_internal/v2/token')) {
        return authorization === 'token token_work'
          ? Response.json({ expires_at: 2_000_000_000, refresh_in: 3600, token: 'copilot_work' })
          : new Response('wrong GitHub token', { status: 401 })
      }
      if (target === 'https://api.enterprise.githubcopilot.com/models') {
        return authorization === 'Bearer copilot_work'
          ? Response.json({
              object: 'list',
              data: [
                makeModel('claude-work', ['/v1/messages']),
                makeModel('gpt-work', ['/responses']),
              ],
            })
          : new Response('wrong Copilot token', { status: 401 })
      }
      return new Response('unexpected request', { status: 500 })
    }) as unknown as typeof fetch

    try {
      const profiles = await runModels({
        accountType: 'individual',
        client: 'all',
        json: true,
        proxyEnv: false,
      }, {
        writeOutput(value) {
          output.push(value)
        },
      })

      expect(profiles.map(profile => profile.id)).toEqual(['claude-work', 'gpt-work'])
      expect(JSON.parse(output.join(''))).toMatchObject({
        account: 'work',
        account_type: 'enterprise',
        data: [{ id: 'claude-work' }, { id: 'gpt-work' }],
      })
      expect(requests).toContainEqual({
        authorization: 'token token_work',
        target: 'https://api.github.com/user',
      })
      expect(requests).toContainEqual({
        authorization: 'token token_work',
        target: 'https://api.github.com/copilot_internal/v2/token',
      })
      expect(requests).toContainEqual({
        authorization: 'Bearer copilot_work',
        target: 'https://api.enterprise.githubcopilot.com/models',
      })
      expect(JSON.stringify(requests)).not.toContain('token_legacy')
      expect(requests.some(request => request.target.includes('/login/device/code'))).toBe(false)
    }
    finally {
      globalThis.fetch = originalFetch
      cleanAccountState()
    }
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanAccountState()
})

function makeDependencies(events: Array<string>, output: Array<string>): ModelsCommandDependencies {
  return {
    initializeHttpClient(proxyEnv) {
      events.push(`initialize-http:${proxyEnv}`)
    },
    async ensurePaths() {
      events.push('ensure-paths')
    },
    async loadVSCodeVersion() {
      events.push('load-vscode-version')
    },
    async authenticate() {
      events.push('authenticate')
    },
    async fetchModels() {
      events.push('fetch-models')
      return makeModelsResponse()
    },
    selectAccount(accountType, accountId) {
      const context = createAccountContext({ accountType, id: accountId ?? 'default' })
      const registry = new AccountRegistry(undefined, context)
      events.push(`select-account:${accountType}:${accountId ?? 'default'}`)
      return {
        accountId: accountId ?? 'default',
        accountType,
        context,
        explicit: false,
        registry,
      }
    },
    writeOutput(value) {
      output.push(value)
    },
    validateProxyEnvironment(selection, proxyEnv) {
      events.push(`validate-proxy:${selection.accountType}:${proxyEnv}`)
    },
  }
}

function makeModelsResponse(): ModelsResponse {
  return {
    object: 'list',
    data: [
      makeModel('gpt-live-responses', ['/responses', 'ws:/responses']),
      makeModel('claude-live', ['/v1/messages']),
      makeModel('chat-only', ['/chat/completions']),
      makeModel('trajectory-compaction', ['/responses'], { model_picker_enabled: false }),
    ],
  }
}

function makeModel(id: string, supportedEndpoints: Array<string>, options: Partial<Model> = {}): Model {
  return {
    id,
    capabilities: {
      family: 'test',
      limits: {
        max_context_window_tokens: 128_000,
        max_output_tokens: 16_000,
      },
      object: 'model_capabilities',
      supports: {
        reasoning_effort: ['low', 'high'],
        tool_calls: true,
        vision: true,
      },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    supported_endpoints: supportedEndpoints,
    vendor: 'github-copilot',
    version: '1',
    ...options,
  }
}

function cleanAccountState(): void {
  fs.rmSync(PATHS.ACCOUNTS_CONFIG, { force: true })
  fs.rmSync(PATHS.TOKENS_DIR, { force: true, recursive: true })
  fs.rmSync(PATHS.GITHUB_TOKEN_PATH, { force: true })
}
