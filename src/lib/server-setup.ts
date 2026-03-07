import type { RunServerOptions } from '~/start'
import consola from 'consola'

import { ensurePaths } from '~/lib/paths'
import { initProxyFromEnv } from '~/lib/proxy'
import { state } from '~/lib/state'
import { setupCopilotToken, setupGitHubToken } from '~/lib/token'
import { cacheModels, cacheVSCodeVersion } from '~/lib/utils'

/**
 * Performs all pre-server-start initialization:
 * proxy, logging, state, auth, model caching.
 */
export async function initializeServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info('Verbose logging enabled')
  }

  state.accountType = options.accountType
  if (options.accountType !== 'individual') {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken
  state.apiKey = options.apiKey

  await ensurePaths()
  await cacheVSCodeVersion()

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info('Using provided GitHub token')
  }
  else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  consola.info(
    `Available models: \n${state.models?.data.map(model => `- ${model.id}`).join('\n')}`,
  )
}
