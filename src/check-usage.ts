import type { QuotaDetail } from './services/github/get-copilot-usage'
import process from 'node:process'
import { defineCommand } from 'citty'

import consola from 'consola'
import { assertProxyEndpointAvailable } from './daemon/service-env'
import { ensurePaths } from './lib/paths'
import { initializeNodeHttpClient } from './lib/proxy'
import { setupGitHubToken } from './lib/token'
import {
  getCopilotUsage,

} from './services/github/get-copilot-usage'

export const checkUsage = defineCommand({
  meta: {
    name: 'check-usage',
    description: 'Show current GitHub Copilot usage/quota information',
  },
  args: {
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Use HTTP(S)_PROXY/NO_PROXY environment variables for GitHub requests',
    },
  },
  async run({ args }) {
    if (args['proxy-env'])
      assertProxyEndpointAvailable(process.env, ['https://api.github.com'])
    initializeNodeHttpClient({ proxyEnv: args['proxy-env'] })
    await ensurePaths()
    await setupGitHubToken()
    try {
      const usage = await getCopilotUsage()
      const premium = usage.quota_snapshots.premium_interactions
      const premiumTotal = premium.entitlement
      const premiumUsed = premiumTotal - premium.remaining
      const premiumPercentUsed
        = premiumTotal > 0 ? (premiumUsed / premiumTotal) * 100 : 0
      const premiumPercentRemaining = premium.percent_remaining

      // Helper to summarize a quota snapshot
      function summarizeQuota(name: string, snap: QuotaDetail | undefined) {
        if (!snap)
          return `${name}: N/A`
        const total = snap.entitlement
        const used = total - snap.remaining
        const percentUsed = total > 0 ? (used / total) * 100 : 0
        const percentRemaining = snap.percent_remaining
        return `${name}: ${used}/${total} used (${percentUsed.toFixed(1)}% used, ${percentRemaining.toFixed(1)}% remaining)`
      }

      const premiumLine = `Premium: ${premiumUsed}/${premiumTotal} used (${premiumPercentUsed.toFixed(1)}% used, ${premiumPercentRemaining.toFixed(1)}% remaining)`
      const chatLine = summarizeQuota('Chat', usage.quota_snapshots.chat)
      const completionsLine = summarizeQuota(
        'Completions',
        usage.quota_snapshots.completions,
      )

      consola.box(
        `Copilot Usage (plan: ${usage.copilot_plan})\n`
        + `Quota resets: ${usage.quota_reset_date}\n`
        + `\nQuotas:\n`
        + `  ${premiumLine}\n`
        + `  ${chatLine}\n`
        + `  ${completionsLine}`,
      )
    }
    catch (err) {
      consola.error('Failed to fetch Copilot usage:', err)
      process.exit(1)
    }
  },
})
