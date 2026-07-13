import type { RunServerOptions } from '~/start'
import process from 'node:process'
import consola from 'consola'

import { ensurePaths } from '~/lib/paths'
import { initializeNodeHttpClient } from '~/lib/proxy'
import { state } from '~/lib/state'
import {
  setupCopilotToken,
  setupGitHubToken,
  startCopilotTokenRefresh,
  stopCopilotTokenRefresh,
} from '~/lib/token'
import {
  cacheModels,
  cacheVSCodeVersion,
  startModelRefresh,
  stopModelRefresh,
} from '~/lib/utils'

/**
 * Performs all pre-server-start initialization:
 * proxy, logging, state, auth, model caching.
 */
export async function initializeServer(options: RunServerOptions): Promise<void> {
  // A supervisor retry runs initialization again in the same process. Clear
  // any prior schedules first so failed retries cannot accumulate refresh
  // loops.
  stopCopilotTokenRefresh()
  stopModelRefresh()

  if (options.verbose) {
    consola.level = 5
    consola.info('Verbose logging enabled')
  }

  initializeNodeHttpClient({
    proxyEnv: options.proxyEnv,
    headersTimeoutMs: options.headersTimeoutMs,
    bodyTimeoutMs: options.bodyTimeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
  })

  state.accountType = options.accountType
  state.nativeServiceInstanceToken = options.nativeServiceInstanceToken
  if (options.accountType !== 'individual') {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken

  await ensurePaths()
  await cacheVSCodeVersion()

  const githubToken = consumeGithubToken(options.githubToken, process.env, state.githubToken)
  if (githubToken) {
    state.githubToken = githubToken
    consola.info('Using provided GitHub token')
  }
  else {
    await setupGitHubToken()
  }

  const copilotToken = await setupCopilotToken({ scheduleRefresh: false })
  await cacheModels()
  startCopilotTokenRefresh(copilotToken.refresh_in)
  startModelRefresh()

  consola.info(
    `Available models: \n${state.models?.data.map(model => `- ${model.id}`).join('\n')}`,
  )
}

export function consumeGithubToken(
  explicitToken: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  inMemoryToken?: string,
): string | undefined {
  try {
    for (const candidate of [explicitToken, env.GH_TOKEN, env.GITHUB_TOKEN, inMemoryToken]) {
      const token = candidate?.trim()
      if (token)
        return token
    }
    return undefined
  }
  finally {
    // Environment tokens are a one-shot startup input. Remove both aliases
    // even when an explicit CLI token won precedence so they are not retained
    // in the long-running proxy process or inherited by later child processes.
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
  }
}
