#!/usr/bin/env node

import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { assertProxyEndpointAvailable } from './daemon/service-env'
import { ensurePaths, PATHS } from './lib/paths'
import { initializeNodeHttpClient } from './lib/proxy'
import { state } from './lib/state'
import { setupGitHubToken } from './lib/token'

interface RunAuthOptions {
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
  await setupGitHubToken({ force: true })
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
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args['show-token'],
      proxyEnv: args['proxy-env'],
    })
  },
})
