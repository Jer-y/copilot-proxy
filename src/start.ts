#!/usr/bin/env node

import type { ServerHandler } from 'srvx'
import type { DaemonConfig } from '~/daemon/config'
import process from 'node:process'
import { defineCommand } from 'citty'
import clipboard from 'clipboardy'
import consola from 'consola'
import { serve } from 'srvx'
import invariant from 'tiny-invariant'

import { ensurePaths } from './lib/paths'
import { exitWithPortInUse, isPortInUseError } from './lib/port'
import { initProxyFromEnv } from './lib/proxy'
import { generateEnvScript } from './lib/shell'
import { state } from './lib/state'
import { setupCopilotToken, setupGitHubToken } from './lib/token'
import { cacheModels, cacheVSCodeVersion } from './lib/utils'
import { server } from './server'

export interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  exitOnPortInUse?: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
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

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(state.models, 'Models should be loaded by now')

    const selectedModel = await consola.prompt(
      'Select a model to use with Claude Code',
      {
        type: 'select',
        options: state.models.data.map(model => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      'Select a small model to use with Claude Code',
      {
        type: 'select',
        options: state.models.data.map(model => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: 'dummy',
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      'claude',
    )

    try {
      clipboard.writeSync(command)
      consola.success('Copied Claude Code command to clipboard!')
    }
    catch {
      consola.warn(
        'Failed to copy to clipboard. Here is the Claude Code command:',
      )
      consola.log(command)
    }
  }

  consola.box(
    `🌐 Usage Viewer: https://jer-y.github.io/copilot-proxy?endpoint=${serverUrl}/usage`,
  )

  try {
    serve({
      fetch: server.fetch as ServerHandler,
      port: options.port,
    })
  }
  catch (error) {
    if (isPortInUseError(error) && (options.exitOnPortInUse ?? true)) {
      exitWithPortInUse(options.port)
    }
    throw error
  }

  // Keep the process alive — serve() is non-blocking.
  // This promise never resolves, which is correct for a long-running server.
  // The process exits via SIGTERM/SIGINT signal handlers.
  await new Promise(() => {})
}

export const start = defineCommand({
  meta: {
    name: 'start',
    description: 'Start the Copilot API server',
  },
  args: {
    'port': {
      alias: 'p',
      type: 'string',
      default: '4399',
      description: 'Port to listen on',
    },
    'verbose': {
      alias: 'v',
      type: 'boolean',
      default: false,
      description: 'Enable verbose logging',
    },
    'account-type': {
      alias: 'a',
      type: 'string',
      default: 'individual',
      description: 'Account type to use (individual, business, enterprise)',
    },
    'manual': {
      type: 'boolean',
      default: false,
      description: 'Enable manual request approval',
    },
    'rate-limit': {
      alias: 'r',
      type: 'string',
      description: 'Rate limit in seconds between requests',
    },
    'wait': {
      alias: 'w',
      type: 'boolean',
      default: false,
      description:
        'Wait instead of error when rate limit is hit. Has no effect if rate limit is not set',
    },
    'github-token': {
      alias: 'g',
      type: 'string',
      description:
        'Provide GitHub token directly (must be generated using the `auth` subcommand)',
    },
    'claude-code': {
      alias: 'c',
      type: 'boolean',
      default: false,
      description:
        'Generate a command to launch Claude Code with Copilot API config',
    },
    'show-token': {
      type: 'boolean',
      default: false,
      description: 'Show GitHub and Copilot tokens on fetch and refresh',
    },
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Initialize proxy from environment variables',
    },
    'daemon': {
      alias: 'd',
      type: 'boolean',
      default: false,
      description: 'Run as a background daemon',
    },
    '_supervisor': {
      type: 'boolean',
      default: false,
      description: 'Internal: run as supervisor (do not use directly)',
    },
  },
  async run({ args }) {
    // Validate numeric arguments
    const port = Number.parseInt(args.port, 10)
    if (Number.isNaN(port) || port <= 0 || port > 65535 || String(port) !== args.port) {
      consola.error(`Invalid port: ${args.port}`)
      process.exit(1)
    }

    const rateLimitRaw = args['rate-limit']
    const rateLimit = rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)
    if (rateLimitRaw !== undefined && (Number.isNaN(rateLimit!) || rateLimit! <= 0 || rateLimit! > 86400 || String(rateLimit) !== rateLimitRaw)) {
      consola.error(`Invalid rate-limit: ${rateLimitRaw} (must be 1-86400)`)
      process.exit(1)
    }

    const validAccountTypes = ['individual', 'business', 'enterprise']
    if (!validAccountTypes.includes(args['account-type'])) {
      consola.error(`Invalid account-type: ${args['account-type']} (must be one of: ${validAccountTypes.join(', ')})`)
      process.exit(1)
    }

    if (args._supervisor) {
      const { loadDaemonConfigWithRecovery } = await import('~/daemon/config')
      const fallbackConfig: DaemonConfig = {
        port,
        verbose: args.verbose,
        accountType: args['account-type'],
        manual: args.manual,
        rateLimit,
        rateLimitWait: args.wait,
        githubToken: args['github-token'],
        showToken: args['show-token'],
        proxyEnv: args['proxy-env'],
      }
      const configResult = loadDaemonConfigWithRecovery(fallbackConfig)

      if (configResult.recovered) {
        const reason = configResult.reason ?? 'unknown'
        consola.warn(`Supervisor mode: daemon config ${reason}, fallback applied`)
        if (configResult.backupPath) {
          consola.warn(`Supervisor mode: backed up previous config to ${configResult.backupPath}`)
        }
        if (!configResult.persisted) {
          consola.warn('Supervisor mode: failed to persist recovered daemon config')
        }
      }

      const { runAsSupervisor } = await import('~/daemon/supervisor')
      const options: RunServerOptions = {
        ...configResult.config,
        claudeCode: false,
        exitOnPortInUse: false,
      }

      return runAsSupervisor(() => runServer(options))
    }

    if (args.daemon) {
      if (args['claude-code']) {
        consola.error('Cannot use --claude-code with --daemon (interactive mode)')
        process.exit(1)
      }

      const { daemonStart } = await import('~/daemon/start')

      await daemonStart({
        port,
        verbose: args.verbose,
        accountType: args['account-type'],
        manual: args.manual,
        rateLimit,
        rateLimitWait: args.wait,
        githubToken: args['github-token'],
        showToken: args['show-token'],
        proxyEnv: args['proxy-env'],
      })
      return
    }

    return runServer({
      port,
      verbose: args.verbose,
      accountType: args['account-type'],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args['github-token'],
      claudeCode: args['claude-code'],
      showToken: args['show-token'],
      proxyEnv: args['proxy-env'],
    })
  },
})
