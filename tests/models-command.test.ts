import type { ModelsCommandDependencies } from '~/models'
import type { Model, ModelsResponse } from '~/services/copilot/get-models'
import { describe, expect, test } from 'bun:test'

import { compatibleModelsForClient } from '~/lib/client-setup'
import { runModels } from '~/models'

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
      'validate-proxy:business:true',
      'initialize-http:true',
      'account:business',
      'ensure-paths',
      'load-vscode-version',
      'authenticate',
      'fetch-models',
    ])
    expect(profiles.map(profile => profile.id)).toEqual(['gpt-live-responses', 'claude-live'])

    const body = JSON.parse(output.join('')) as {
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
})

function makeDependencies(events: Array<string>, output: Array<string>): ModelsCommandDependencies {
  return {
    initializeHttpClient(proxyEnv) {
      events.push(`initialize-http:${proxyEnv}`)
    },
    setAccountType(accountType) {
      events.push(`account:${accountType}`)
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
    writeOutput(value) {
      output.push(value)
    },
    validateProxyEnvironment(accountType, proxyEnv) {
      events.push(`validate-proxy:${accountType}:${proxyEnv}`)
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
