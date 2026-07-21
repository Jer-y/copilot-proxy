import type { AccountType } from './lib/cli-validators'
import type { ModelCapabilityProfile, ProductClientRoute } from './lib/product-capabilities'
import type { ModelsResponse } from './services/copilot/get-models'
import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { assertProxyEndpointAvailable } from './daemon/service-env'
import { validateAccountType } from './lib/cli-validators'
import { ensurePaths } from './lib/paths'
import { buildModelCapabilityProfiles } from './lib/product-capabilities'
import { initializeNodeHttpClient } from './lib/proxy'
import { state } from './lib/state'
import { setupCopilotToken, setupGitHubToken } from './lib/token'
import { assertModelCatalogSnapshot, cacheVSCodeVersion } from './lib/utils'
import { getModels } from './services/copilot/get-models'

export type ModelsClient = 'all' | 'claude' | 'codex' | 'openai-sdk'

export interface RunModelsOptions {
  accountType: string
  client: string
  json: boolean
  proxyEnv: boolean
}

export interface ModelsCommandDependencies {
  authenticate: () => Promise<void>
  ensurePaths: () => Promise<void>
  fetchModels: () => Promise<ModelsResponse>
  initializeHttpClient: (proxyEnv: boolean) => void
  loadVSCodeVersion: () => Promise<void>
  setAccountType: (accountType: AccountType) => void
  writeOutput: (output: string) => void
  validateProxyEnvironment: (accountType: AccountType, proxyEnv: boolean) => void
}

export interface ModelsCommandJsonOutput {
  account_type: AccountType
  client: ModelsClient
  data: Array<ModelCapabilityProfile>
  documentation: 'docs/protocol-compatibility.md'
  object: 'copilot_proxy.model_capability_profiles'
}

const DEFAULT_DEPENDENCIES: ModelsCommandDependencies = {
  initializeHttpClient(proxyEnv) {
    initializeNodeHttpClient({ proxyEnv })
  },
  ensurePaths,
  loadVSCodeVersion: cacheVSCodeVersion,
  setAccountType(accountType) {
    state.accountType = accountType
  },
  async authenticate() {
    await setupGitHubToken()
    await setupCopilotToken({ scheduleRefresh: false })
  },
  fetchModels: getModels,
  writeOutput(output) {
    process.stdout.write(`${output}\n`)
  },
  validateProxyEnvironment(accountType, proxyEnv) {
    if (!proxyEnv)
      return
    const copilotOrigin = accountType === 'individual'
      ? 'https://api.githubcopilot.com'
      : `https://api.${accountType}.githubcopilot.com`
    assertProxyEndpointAvailable(process.env, [
      'https://github.com',
      'https://api.github.com',
      copilotOrigin,
      'https://update.code.visualstudio.com',
    ])
  },
}

export async function runModels(
  options: RunModelsOptions,
  dependencies?: Partial<ModelsCommandDependencies>,
): Promise<Array<ModelCapabilityProfile>> {
  if (!validateAccountType(options.accountType)) {
    throw new Error(`Invalid account-type: ${options.accountType} (must be one of: individual, business, enterprise)`)
  }
  if (!isModelsClient(options.client)) {
    throw new Error(`Invalid client: ${options.client} (must be one of: all, claude, codex, openai-sdk)`)
  }

  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const restoreConsolaOutput = dependencies === undefined && options.json
    ? directConsolaInfoToStderr()
    : undefined

  let models: ModelsResponse
  try {
    deps.validateProxyEnvironment(options.accountType, options.proxyEnv)
    deps.initializeHttpClient(options.proxyEnv)
    deps.setAccountType(options.accountType)
    await deps.ensurePaths()
    await deps.loadVSCodeVersion()
    await deps.authenticate()
    models = await deps.fetchModels()
    assertModelCatalogSnapshot(models)
  }
  finally {
    restoreConsolaOutput?.()
  }

  const profiles = filterProfilesForClient(
    buildModelCapabilityProfiles(models.data),
    options.client,
  )

  if (options.json) {
    const output: ModelsCommandJsonOutput = {
      object: 'copilot_proxy.model_capability_profiles',
      account_type: options.accountType,
      client: options.client,
      documentation: 'docs/protocol-compatibility.md',
      data: profiles,
    }
    deps.writeOutput(JSON.stringify(output, null, 2))
  }
  else {
    deps.writeOutput(formatModelsTable(profiles, options.accountType, options.client))
  }

  return profiles
}

export function filterProfilesForClient(
  profiles: Array<ModelCapabilityProfile>,
  client: ModelsClient,
): Array<ModelCapabilityProfile> {
  if (client === 'all')
    return profiles

  const relevantRoutes = routesForClient(client)
  return profiles.filter(profile =>
    relevantRoutes.some(route => profile.routes[route].mode !== 'unsupported'),
  )
}

export function formatModelsTable(
  profiles: Array<ModelCapabilityProfile>,
  accountType: AccountType,
  client: ModelsClient,
): string {
  const lines = [`Copilot model compatibility (account: ${accountType}, client: ${client})`]

  if (profiles.length === 0) {
    lines.push('', `No compatible models found for client "${client}".`)
    return lines.join('\n')
  }

  const routeColumns = client === 'all'
    ? [
        ['CHAT', 'chatCompletions'],
        ['RESPONSES HTTP', 'responsesHttp'],
        ['RESPONSES WS', 'responsesWebSocket'],
        ['MESSAGES', 'anthropicMessages'],
      ] as const
    : routesForClient(client).map(route => [formatRouteColumn(route), route] as const)
  const headers = [
    'MODEL',
    ...routeColumns.map(([label]) => label),
    'CONTEXT',
    'OUTPUT',
    'R/T/V',
  ]
  const rows = profiles.map(profile => [
    profile.id,
    ...routeColumns.map(([, route]) => formatRouteStatus(profile, route)),
    formatTokenLimit(profile.contextWindow),
    formatTokenLimit(profile.maxOutputTokens),
    [profile.features.reasoning, profile.features.toolCalls, profile.features.vision]
      .map(formatFeatureFlag)
      .join('/'),
  ])

  lines.push('', renderTable(headers, rows), '', 'R/T/V = reasoning/tool calls/vision. Live catalog metadata is routing evidence only; use --json for route reasons and sources.')
  return lines.join('\n')
}

export const models = defineCommand({
  meta: {
    name: 'models',
    description: 'Show live Copilot models with client routes, maturity, limits, and routing sources',
  },
  args: {
    'account-type': {
      alias: 'a',
      type: 'string',
      default: 'individual',
      description: 'Account type to use (individual, business, enterprise)',
    },
    'client': {
      type: 'string',
      default: 'all',
      description: 'Filter for a client (all, claude, codex, openai-sdk)',
    },
    'json': {
      type: 'boolean',
      default: false,
      description: 'Output complete live capability profiles as JSON',
    },
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Use configured HTTP(S)_PROXY/NO_PROXY variables',
    },
  },
  run({ args }) {
    return runModels({
      accountType: args['account-type'],
      client: args.client,
      json: args.json,
      proxyEnv: args['proxy-env'],
    })
  },
})

function routesForClient(client: Exclude<ModelsClient, 'all'>): Array<ProductClientRoute> {
  switch (client) {
    case 'claude':
      return ['anthropicMessages']
    case 'codex':
      return ['responsesHttp', 'responsesWebSocket']
    case 'openai-sdk':
      return ['chatCompletions', 'responsesHttp']
  }
}

function formatRouteStatus(profile: ModelCapabilityProfile, route: ProductClientRoute): string {
  const capability = profile.routes[route]
  return capability.mode === 'unsupported'
    ? 'unsupported'
    : `${capability.mode}/${capability.maturity}`
}

function formatRouteColumn(route: ProductClientRoute): string {
  switch (route) {
    case 'anthropicMessages':
      return 'MESSAGES'
    case 'chatCompletions':
      return 'CHAT'
    case 'responsesHttp':
      return 'RESPONSES HTTP'
    case 'responsesWebSocket':
      return 'RESPONSES WS'
  }
}

function formatTokenLimit(limit: number | null): string {
  if (limit === null)
    return '?'
  if (limit >= 1_000_000 && limit % 1_000_000 === 0)
    return `${limit / 1_000_000}M`
  if (limit >= 1_000 && limit % 1_000 === 0)
    return `${limit / 1_000}K`
  return String(limit)
}

function formatFeatureFlag(value: boolean | null): string {
  if (value === null)
    return '?'
  return value ? 'yes' : 'no'
}

function renderTable(headers: Array<string>, rows: Array<Array<string>>): string {
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map(row => row[column]?.length ?? 0),
  ))
  const renderRow = (row: Array<string>) => row
    .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
    .join(' | ')
    .trimEnd()

  return [
    renderRow(headers),
    widths.map(width => '-'.repeat(width)).join('-+-'),
    ...rows.map(renderRow),
  ].join('\n')
}

function isModelsClient(client: string): client is ModelsClient {
  return client === 'all' || client === 'claude' || client === 'codex' || client === 'openai-sdk'
}

function directConsolaInfoToStderr(): () => void {
  const previousStdout = consola.options.stdout
  consola.options.stdout = process.stderr
  return () => {
    consola.options.stdout = previousStdout
  }
}
