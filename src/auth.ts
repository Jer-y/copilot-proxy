#!/usr/bin/env node

import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { assertProxyEndpointAvailable } from './daemon/service-env'
import { readTokenFromStdin, runDeviceFlow } from './lib/account/auth'
import { boundAccountIdForRequiredRoute } from './lib/account/capabilities'
import { AccountTransactionError, assertAccountMutationAllowed, authenticateExistingAccount } from './lib/account/operations'
import { buildAccountNetworkTargets } from './lib/account/proxy-targets'
import { AccountRegistry } from './lib/account/registry'
import { hardenAccountStoragePaths, readAccountsConfiguration, readAccountToken } from './lib/account/store'
import { ensurePaths, PATHS } from './lib/paths'
import { initializeNodeHttpClient } from './lib/proxy'
import { state } from './lib/state'
import { setupGitHubToken, writeGithubTokenFile } from './lib/token'

interface RunAuthOptions {
  account?: string
  ifNeeded: boolean
  verbose: boolean
  showToken: boolean
  proxyEnv: boolean
  tokenStdin?: boolean
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info('Verbose logging enabled')
  }

  state.showToken = options.showToken
  if (options.account !== undefined && !options.account.trim()) {
    process.exitCode = 1
    consola.error('--account must contain an account id.')
    return
  }
  const environmentToken = process.env.GH_TOKEN?.trim()
    || process.env.GITHUB_TOKEN?.trim()
  const configuration = readAccountsConfiguration()
  if (options.proxyEnv) {
    const authenticatesExplicitAccount = options.account !== undefined
      || Boolean(configuration && environmentToken)
    const targets = authenticatesExplicitAccount
      ? buildAccountNetworkTargets({
          accountTypes: configuration?.accounts.map(account => account.accountType),
          deviceFlow: options.account !== undefined && !options.tokenStdin,
          vsCode: true,
        })
      : configuration
        ? []
        : buildAccountNetworkTargets({
            deviceFlow: !environmentToken,
          })
    if (targets.length > 0)
      assertProxyEndpointAvailable(process.env, targets)
  }
  initializeNodeHttpClient({ proxyEnv: options.proxyEnv })

  if (options.account !== undefined) {
    try {
      await assertAccountMutationAllowed()
      const token = options.tokenStdin
        ? await readTokenFromStdin()
        : await runDeviceFlow()
      await authenticateExistingAccount({ id: options.account, token })
      consola.success(`Re-authenticated account ${options.account}.`)
    }
    catch (error) {
      process.exitCode = error instanceof AccountTransactionError ? error.exitCode : 1
      consola.error(error instanceof Error ? error.message : error)
    }
    return
  }

  if (configuration) {
    if (!options.ifNeeded) {
      throw new Error(
        'accounts.json is active; specify --account <id> (and optionally --token-stdin) to authenticate one account.',
      )
    }

    try {
      if (environmentToken) {
        await assertAccountMutationAllowed()
        await authenticateExistingAccount({
          id: configuration.defaultAccount,
          token: environmentToken,
        })
      }
    }
    finally {
      delete process.env.GH_TOKEN
      delete process.env.GITHUB_TOKEN
    }

    hardenAccountStoragePaths()
    const missing = criticalAccountIds(configuration)
      .filter(accountId => !readAccountToken(accountId))
    if (missing.length > 0) {
      throw new Error(
        `Missing persisted token for required account${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Run \`copilot-proxy accounts auth <id>\` for each account.`,
      )
    }
    consola.success('Explicit account authentication inputs are available.')
    return
  }

  await ensurePaths()
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

function criticalAccountIds(
  configuration: NonNullable<ReturnType<typeof readAccountsConfiguration>>,
): string[] {
  const registry = new AccountRegistry(configuration)
  return [...new Set([
    configuration.defaultAccount,
    ...configuration.requiredRoutes.map(route => boundAccountIdForRequiredRoute(registry, route)),
  ])]
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
    'account': {
      type: 'string',
      description: 'Re-authenticate one accounts.json account (alias of accounts auth)',
    },
    'token-stdin': {
      type: 'boolean',
      default: false,
      description: 'Read the account token from stdin instead of device flow',
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
      account: args.account,
      verbose: args.verbose,
      showToken: args['show-token'],
      proxyEnv: args['proxy-env'],
      tokenStdin: args['token-stdin'],
    })
  },
})
