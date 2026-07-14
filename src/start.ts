#!/usr/bin/env node

import type { Server, ServerHandler } from 'srvx'
import type { DaemonConfig } from '~/daemon/config'
import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import clipboard from 'clipboardy'
import consola from 'consola'
import { serve } from 'srvx'
import invariant from 'tiny-invariant'

import { validateAccountType, validateHost, validatePort, validateRateLimit, validateTimeoutMs } from './lib/cli-validators'
import { MAX_TIMER_DELAY_MS } from './lib/http-timeouts'
import { PATHS } from './lib/paths'
import { exitWithPortInUse, isPortInUseError } from './lib/port'
import { DEFAULT_HOST, isLoopbackHostname } from './lib/security'
import { initializeServer } from './lib/server-setup'
import { generateEnvScript } from './lib/shell'
import { state } from './lib/state'
import { toAnthropicClientModelName } from './routes/messages/model-normalization'
import { server } from './server'

export interface RunServerOptions {
  port: number
  host: string
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
  connectTimeoutMs?: number
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  exitOnPortInUse?: boolean
  nativeService?: boolean
  nativeServiceInstanceToken?: string
}

function formatHostForUrl(host: string): string {
  const normalized = host.toLowerCase()
  if (normalized === DEFAULT_HOST || normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]')
    return 'localhost'

  if (host.includes(':') && !host.startsWith('['))
    return `[${host}]`

  return host
}

export async function runServer(options: RunServerOptions): Promise<void> {
  await initializeServer(options)

  const serverUrl = `http://${formatHostForUrl(options.host)}:${options.port}`

  try {
    const appServer = serve({
      fetch: server.fetch as ServerHandler,
      port: options.port,
      hostname: options.host,
      gracefulShutdown: false,
      bun: {
        idleTimeout: 0,
      },
    })

    await appServer.ready()
    installShutdownHandlers(appServer, {
      watchStopFile: process.platform === 'win32' && options.nativeService === true,
    })

    if (!isLoopbackHostname(options.host)) {
      consola.warn(
        `Listening on non-loopback host ${options.host}. Do not expose this proxy to LAN or Internet unless you fully trust every client that can reach it.`,
      )
    }
    consola.box(
      `🌐 Usage Viewer: https://jer-y.github.io/copilot-proxy?endpoint=${serverUrl}/usage`,
    )

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
      const clientModel = toAnthropicClientModelName(selectedModel)
      const clientSmallModel = toAnthropicClientModelName(selectedSmallModel)

      const command = generateEnvScript(
        {
          ANTHROPIC_BASE_URL: serverUrl,
          ANTHROPIC_AUTH_TOKEN: 'dummy',
          ANTHROPIC_MODEL: clientModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL: clientModel,
          ANTHROPIC_SMALL_FAST_MODEL: clientSmallModel,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: clientSmallModel,
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

export async function closeServerGracefully(
  appServer: Pick<Server, 'close'>,
  timeoutMs = 3_000,
): Promise<'graceful' | 'forced'> {
  let timeout: ReturnType<typeof setTimeout> | undefined

  try {
    const gracefulClose = appServer.close(false)
    const result = await Promise.race([
      gracefulClose.then(() => 'graceful' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs, 'timeout')
        timeout.unref?.()
      }),
    ])

    if (result === 'graceful')
      return 'graceful'
  }
  catch (error) {
    consola.warn('Graceful server close failed; forcing active connections closed:', error)
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
  }

  await appServer.close(true)
  return 'forced'
}

function installShutdownHandlers(
  appServer: Server,
  options: { watchStopFile: boolean },
): void {
  let shuttingDown = false
  let stopPoll: ReturnType<typeof setInterval> | undefined

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown)
      return

    shuttingDown = true
    if (stopPoll)
      clearInterval(stopPoll)
    consola.info(`Received ${signal}, shutting down...`)
    try {
      const result = await closeServerGracefully(appServer)
      if (result === 'forced')
        consola.warn('Graceful shutdown timed out; active connections were forcibly closed')
    }
    catch (error) {
      consola.warn('Failed to close server cleanly:', error)
    }
    if (options.watchStopFile) {
      try {
        fs.rmSync(PATHS.DAEMON_STOP, { force: true })
      }
      catch {}
    }
    process.exit(0)
  }

  // Keep the listeners installed while draining. A Bun bootstrap parent and
  // service managers may both deliver the same signal; a once-listener would
  // disappear after the first delivery and let the duplicate take the default
  // hard-exit path.
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    void shutdown('SIGINT')
  })

  if (options.watchStopFile) {
    stopPoll = setInterval(() => {
      if (fs.existsSync(PATHS.DAEMON_STOP))
        void shutdown('SIGTERM')
    }, 250)
    stopPoll.unref?.()
  }
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
    'host': {
      alias: 'H',
      type: 'string',
      default: DEFAULT_HOST,
      description: 'Host/IP to bind to. Use 0.0.0.0 only when intentionally exposing the port',
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
    'headers-timeout-ms': {
      type: 'string',
      description: 'Upstream HTTP response headers timeout in milliseconds (uses built-in Copilot defaults when omitted; 0 disables timeout)',
    },
    'body-timeout-ms': {
      type: 'string',
      description: 'Upstream HTTP response body timeout in milliseconds (uses built-in Copilot defaults when omitted; 0 disables timeout)',
    },
    'connect-timeout-ms': {
      type: 'string',
      description: 'Upstream HTTP connect timeout in milliseconds (uses built-in Copilot defaults when omitted; 0 disables timeout)',
    },
    'github-token': {
      alias: 'g',
      type: 'string',
      description:
        'Persist a GitHub token securely, then exit; rerun start without this flag',
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
      description: 'Run as a legacy app-managed background daemon',
    },
    '_supervisor': {
      type: 'boolean',
      default: false,
      description: 'Internal: run as supervisor (do not use directly)',
    },
    '_service': {
      type: 'boolean',
      default: false,
      description: 'Internal: load the persisted native-service environment',
    },
    '_log-file': {
      type: 'boolean',
      default: false,
      description: 'Internal: write stdout/stderr through the rotating daemon log',
    },
    '_data-dir': {
      type: 'string',
      description: 'Internal: use the persisted native-service data directory',
    },
    '_instance-token': {
      type: 'string',
      description: 'Internal: identify the installed native-service instance',
    },
  },
  async run({ args }) {
    if (args['_log-file']) {
      const { installRotatingProcessLog } = await import('~/daemon/log-file')
      installRotatingProcessLog()
    }

    if (args._service) {
      const { loadNativeServiceEnvironment } = await import('~/daemon/service-env')
      loadNativeServiceEnvironment({ proxyEnv: args['proxy-env'] })
      // A crash between a Windows stop request and its acknowledgement can
      // leave a stale marker. Clear it before initialization; a concurrent stop
      // will rewrite the marker and the watcher below will still observe it.
      fs.rmSync(PATHS.DAEMON_STOP, { force: true })
    }

    const port = validatePort(args.port)
    if (port === null) {
      consola.error(`Invalid port: ${args.port}`)
      process.exit(1)
    }

    const host = validateHost(args.host)
    if (host === null) {
      consola.error(`Invalid host: ${args.host}`)
      process.exit(1)
    }

    const rateLimitResult = validateRateLimit(args['rate-limit'])
    if (!rateLimitResult.valid) {
      consola.error(`Invalid rate-limit: ${args['rate-limit']} (must be 1-86400)`)
      process.exit(1)
    }
    const rateLimit = rateLimitResult.value

    const headersTimeoutResult = validateTimeoutMs(args['headers-timeout-ms'])
    if (!headersTimeoutResult.valid) {
      consola.error(`Invalid headers-timeout-ms: ${args['headers-timeout-ms']} (must be between 0 and ${MAX_TIMER_DELAY_MS})`)
      process.exit(1)
    }
    const headersTimeoutMs = headersTimeoutResult.value

    const bodyTimeoutResult = validateTimeoutMs(args['body-timeout-ms'])
    if (!bodyTimeoutResult.valid) {
      consola.error(`Invalid body-timeout-ms: ${args['body-timeout-ms']} (must be between 0 and ${MAX_TIMER_DELAY_MS})`)
      process.exit(1)
    }
    const bodyTimeoutMs = bodyTimeoutResult.value

    const connectTimeoutResult = validateTimeoutMs(args['connect-timeout-ms'])
    if (!connectTimeoutResult.valid) {
      consola.error(`Invalid connect-timeout-ms: ${args['connect-timeout-ms']} (must be between 0 and ${MAX_TIMER_DELAY_MS})`)
      process.exit(1)
    }
    const connectTimeoutMs = connectTimeoutResult.value

    if (!validateAccountType(args['account-type'])) {
      consola.error(`Invalid account-type: ${args['account-type']} (must be one of: individual, business, enterprise)`)
      process.exit(1)
    }

    const nativeServiceInstanceToken = args['_instance-token']?.trim()
    if (nativeServiceInstanceToken && !/^[\w-]{16,128}$/.test(nativeServiceInstanceToken)) {
      consola.error('Invalid internal native-service instance token')
      process.exit(1)
    }

    if (args['proxy-env']) {
      const { assertProxyEndpointAvailable } = await import('~/daemon/service-env')
      const copilotOrigin = args['account-type'] === 'individual'
        ? 'https://api.githubcopilot.com'
        : `https://api.${args['account-type']}.githubcopilot.com`
      assertProxyEndpointAvailable(process.env, [
        'https://api.github.com',
        copilotOrigin,
        'https://update.code.visualstudio.com',
        'https://raw.githubusercontent.com',
      ])
    }

    if (args._supervisor) {
      const { loadDaemonConfigWithRecovery, mergeDaemonConfigWithExplicitFlags } = await import('~/daemon/config')
      const fallbackConfig: DaemonConfig = {
        port,
        host,
        verbose: args.verbose,
        accountType: args['account-type'],
        manual: args.manual,
        rateLimit,
        rateLimitWait: args.wait,
        headersTimeoutMs,
        bodyTimeoutMs,
        connectTimeoutMs,
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

      const mergedConfig = mergeDaemonConfigWithExplicitFlags(
        configResult.config,
        fallbackConfig,
        process.argv.slice(2),
      )
      if (mergedConfig.showToken) {
        consola.error('Cannot use --show-token in supervisor mode because tokens would be written to daemon logs.')
        process.exit(1)
      }
      if (mergedConfig.manual) {
        consola.error('Cannot use manual approval in supervisor mode because no interactive TTY is available.')
        process.exit(1)
      }

      const { runAsSupervisor } = await import('~/daemon/supervisor')
      const options: RunServerOptions = {
        ...mergedConfig,
        claudeCode: false,
        exitOnPortInUse: false,
        nativeService: false,
      }

      return runAsSupervisor(() => runServer(options))
    }

    if (args.daemon) {
      if (args['claude-code']) {
        consola.error('Cannot use --claude-code with --daemon (interactive mode)')
        process.exit(1)
      }
      if (args['show-token']) {
        consola.error('Cannot use --show-token with --daemon because tokens would be written to daemon logs.')
        process.exit(1)
      }
      if (args.manual) {
        consola.error('Cannot use --manual with --daemon because manual approval requires an interactive foreground TTY.')
        process.exit(1)
      }
      const { loadInstalledNativeServiceCommands } = await import('~/daemon/native-service')
      const nativeService = await loadInstalledNativeServiceCommands()
      if (nativeService) {
        consola.error('Cannot use legacy --daemon while a native auto-start service is installed. Use `restart`/`stop`, or run `disable` before starting a legacy daemon.')
        process.exit(1)
      }

      const { daemonStart } = await import('~/daemon/start')

      await daemonStart({
        port,
        host,
        verbose: args.verbose,
        accountType: args['account-type'],
        manual: args.manual,
        rateLimit,
        rateLimitWait: args.wait,
        headersTimeoutMs,
        bodyTimeoutMs,
        connectTimeoutMs,
        githubToken: args['github-token'],
        showToken: args['show-token'],
        proxyEnv: args['proxy-env'],
      })
      return
    }

    return runServer({
      port,
      host,
      verbose: args.verbose,
      accountType: args['account-type'],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      headersTimeoutMs,
      bodyTimeoutMs,
      connectTimeoutMs,
      githubToken: args['github-token'],
      claudeCode: args['claude-code'],
      showToken: args['show-token'],
      proxyEnv: args['proxy-env'],
      nativeService: args._service,
      nativeServiceInstanceToken,
    })
  },
})
