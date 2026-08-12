import type { CommandAccountSelection } from './lib/account/command-selection'
import type { CopilotUsageResponse, QuotaDetail } from './services/github/get-copilot-usage'

import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { assertProxyEndpointAvailable } from './daemon/service-env'
import { selectCommandAccount, verifyCommandAccountIdentity } from './lib/account/command-selection'
import { buildAccountNetworkTargets } from './lib/account/proxy-targets'
import { ensurePaths } from './lib/paths'
import { initializeNodeHttpClient } from './lib/proxy'
import { setupGitHubToken } from './lib/token'
import { cacheVSCodeVersion } from './lib/utils'
import { getCopilotUsage } from './services/github/get-copilot-usage'

export interface RunCheckUsageOptions {
  account?: string
  proxyEnv: boolean
}

export interface CheckUsageDependencies {
  authenticate: (selection: CommandAccountSelection) => Promise<void>
  ensurePaths: () => Promise<void>
  fetchUsage: (selection: CommandAccountSelection) => Promise<CopilotUsageResponse>
  initializeHttpClient: (proxyEnv: boolean) => void
  loadVSCodeVersion: (selection: CommandAccountSelection) => Promise<void>
  selectAccount: (accountId?: string) => CommandAccountSelection
  validateProxyEnvironment: (selection: CommandAccountSelection, proxyEnv: boolean) => void
  writeOutput: (output: string) => void
}

const DEFAULT_DEPENDENCIES: CheckUsageDependencies = {
  async authenticate(selection) {
    if (selection.explicit) {
      await verifyCommandAccountIdentity(selection)
      return
    }
    await setupGitHubToken()
  },
  ensurePaths,
  async fetchUsage(selection) {
    return await getCopilotUsage(selection.context)
  },
  initializeHttpClient(proxyEnv) {
    initializeNodeHttpClient({ proxyEnv })
  },
  async loadVSCodeVersion(selection) {
    await cacheVSCodeVersion([selection.context])
  },
  selectAccount(accountId) {
    return selectCommandAccount('individual', accountId)
  },
  validateProxyEnvironment(selection, proxyEnv) {
    if (proxyEnv)
      assertProxyEndpointAvailable(process.env, checkUsageProxyRequiredTargets(selection))
  },
  writeOutput(output) {
    consola.box(output)
  },
}

export function checkUsageProxyRequiredTargets(
  selection: Pick<CommandAccountSelection, 'explicit'>,
): string[] {
  return buildAccountNetworkTargets({
    deviceFlow: !selection.explicit,
    vsCode: true,
  })
}

export async function runCheckUsage(
  options: RunCheckUsageOptions,
  dependencies: Partial<CheckUsageDependencies> = {},
): Promise<CopilotUsageResponse> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  const selection = deps.selectAccount(options.account)
  if (!selection.explicit)
    await deps.ensurePaths()
  deps.validateProxyEnvironment(selection, options.proxyEnv)
  deps.initializeHttpClient(options.proxyEnv)
  await deps.loadVSCodeVersion(selection)
  await deps.authenticate(selection)
  const usage = await deps.fetchUsage(selection)
  deps.writeOutput(formatUsage(usage, selection))
  return usage
}

export function formatUsage(
  usage: CopilotUsageResponse,
  selection: Pick<CommandAccountSelection, 'accountId' | 'accountType' | 'explicit'>,
): string {
  const premium = usage.quota_snapshots.premium_interactions
  const premiumTotal = premium.entitlement
  const premiumUsed = premiumTotal - premium.remaining
  const premiumPercentUsed = premiumTotal > 0 ? (premiumUsed / premiumTotal) * 100 : 0
  const premiumPercentRemaining = premium.percent_remaining
  const account = selection.explicit
    ? `${selection.accountId}/${selection.accountType}`
    : selection.accountType

  const premiumLine = `Premium: ${premiumUsed}/${premiumTotal} used (${premiumPercentUsed.toFixed(1)}% used, ${premiumPercentRemaining.toFixed(1)}% remaining)`
  const chatLine = summarizeQuota('Chat', usage.quota_snapshots.chat)
  const completionsLine = summarizeQuota('Completions', usage.quota_snapshots.completions)
  return `Copilot Usage (account: ${account}, plan: ${usage.copilot_plan})\n`
    + `Quota resets: ${usage.quota_reset_date}\n`
    + `\nQuotas:\n`
    + `  ${premiumLine}\n`
    + `  ${chatLine}\n`
    + `  ${completionsLine}`
}

function summarizeQuota(name: string, snap: QuotaDetail | undefined): string {
  if (!snap)
    return `${name}: N/A`
  const total = snap.entitlement
  const used = total - snap.remaining
  const percentUsed = total > 0 ? (used / total) * 100 : 0
  const percentRemaining = snap.percent_remaining
  return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`
}

export const checkUsage = defineCommand({
  meta: {
    name: 'check-usage',
    description: 'Show current GitHub Copilot usage/quota information',
  },
  args: {
    'account': {
      type: 'string',
      description: 'Configured accounts.json account id (defaults to defaultAccount)',
    },
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Use HTTP(S)_PROXY/NO_PROXY environment variables for GitHub requests',
    },
  },
  async run({ args }) {
    try {
      await runCheckUsage({
        account: args.account,
        proxyEnv: args['proxy-env'],
      })
    }
    catch (error) {
      consola.error('Failed to fetch Copilot usage:', error)
      process.exitCode = 1
    }
  },
})
