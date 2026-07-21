#!/usr/bin/env node

import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { assertProxyEndpointAvailable } from './daemon/service-env'
import { ensurePaths, PATHS } from './lib/paths'
import { initializeNodeHttpClient } from './lib/proxy'
import { state } from './lib/state'
import { setupGitHubToken, writeGithubTokenFile } from './lib/token'

interface RunAuthOptions {
  ifNeeded: boolean
  verbose: boolean
  showToken: boolean
  proxyEnv: boolean
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info('Verbose logging enabled')
  }

  state.showToken = options.showToken
  if (options.proxyEnv) {
    assertProxyEndpointAvailable(process.env, [
      'https://github.com',
      'https://api.github.com',
    ])
  }
  initializeNodeHttpClient({ proxyEnv: options.proxyEnv })

  await ensurePaths()
  const environmentToken = process.env.GH_TOKEN?.trim()
    || process.env.GITHUB_TOKEN?.trim()
  if (options.ifNeeded && environmentToken) {
    await writeGithubTokenFile(PATHS.GITHUB_TOKEN_PATH, environmentToken)
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    consola.success('GitHub authentication input was saved securely for startup.')
    return
  }

  await setupGitHubToken({
    force: !options.ifNeeded,
    logUser: !options.ifNeeded,
  })
  if (options.ifNeeded)
    consola.success('GitHub authentication input is available.')
  else
    consola.success('GitHub token written to', PATHS.GITHUB_TOKEN_PATH)
}

export const auth = defineCommand({
  meta: {
    name: 'auth',
    description: 'Run GitHub auth flow without running the server',
  },
  args: {
    'verbose': {
      alias: 'v',
      type: 'boolean',
      default: false,
      description: 'Enable verbose logging',
    },
    'show-token': {
      type: 'boolean',
      default: false,
      description: 'Show GitHub token on auth',
    },
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Use HTTP(S)_PROXY/NO_PROXY environment variables for authentication requests',
    },
    'github-token': {
      alias: 'g',
      type: 'string',
      description: 'Persist a GitHub token securely, then exit without starting the device flow',
    },
    '_if-needed': {
      type: 'boolean',
      default: false,
      description: 'Internal: authenticate only when no startup token input is available',
    },
  },
  run({ args }) {
    return runAuth({
      ifNeeded: args['_if-needed'],
      verbose: args.verbose,
      showToken: args['show-token'],
      proxyEnv: args['proxy-env'],
    })
  },
})
