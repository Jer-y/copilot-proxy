import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { loadDaemonConfig, saveDaemonConfig } from '~/daemon/config'
import { isDaemonRunning } from '~/daemon/pid'
import { daemonStart } from '~/daemon/start'
import { stopDaemon } from '~/daemon/stop'

export const config = defineCommand({
  meta: {
    name: 'config',
    description: 'View or update daemon configuration (applies on next restart)',
  },
  args: {
    'api-key': {
      alias: 'k',
      type: 'string',
      description:
        'Set or rotate the API key. Use "auto" to generate a random key, '
        + 'or provide your own. Use "none" to disable API key authentication.',
    },
    'show': {
      alias: 's',
      type: 'boolean',
      default: false,
      description: 'Show the current daemon configuration',
    },
  },
  async run({ args }) {
    const existing = loadDaemonConfig()

    // --- show mode ---
    if (args.show) {
      if (!existing) {
        consola.error('No daemon config found. Start the daemon first with `start -d`')
        process.exit(1)
      }

      // Never print the actual API key value — only reveal whether one is set.
      const display: Record<string, unknown> = {
        port: existing.port,
        verbose: existing.verbose,
        accountType: existing.accountType,
        manual: existing.manual,
        rateLimit: existing.rateLimit,
        rateLimitWait: existing.rateLimitWait,
        showToken: existing.showToken,
        proxyEnv: existing.proxyEnv,
        apiKey: existing.apiKey ? '********' : '(not set)',
      }
      consola.info('Current daemon config:')
      consola.log(display)
      return
    }

    // --- mutation mode ---
    const apiKeyRaw = args['api-key']

    if (apiKeyRaw === undefined) {
      consola.info('No changes specified. Use --show to view, or --api-key to update.')
      return
    }

    if (!existing) {
      consola.error('No daemon config found. Start the daemon first with `start -d`')
      process.exit(1)
    }

    // Resolve the api-key value
    let newApiKey: string | undefined

    // citty may return boolean `true` when a string flag is passed without a value
    const normalised = typeof apiKeyRaw === 'string' ? apiKeyRaw : undefined

    if (normalised === 'none') {
      newApiKey = undefined
      consola.info('API key authentication will be disabled')
    }
    else if (!normalised || normalised === 'auto') {
      const { randomUUID } = await import('node:crypto')
      newApiKey = randomUUID()
    }
    else {
      newApiKey = normalised
    }

    const updated = { ...existing, apiKey: newApiKey }
    // saveDaemonConfig already strips githubToken and sets file mode 0o600
    saveDaemonConfig(updated)

    if (newApiKey) {
      // Print the key exactly once so the user can copy it.
      // This is the foreground CLI — stdout is the user's terminal, not a log file.
      consola.box(`🔒 API Key: ${newApiKey}`)
    }

    consola.success('Config saved.')

    // If the daemon is currently running, offer to restart it immediately
    const daemon = isDaemonRunning()
    if (daemon.running) {
      const shouldRestart = await consola.prompt(
        'Daemon is running. Restart now to apply changes?',
        { type: 'confirm', initial: true },
      )

      // consola.prompt returns a symbol when the user presses Ctrl-C
      if (typeof shouldRestart === 'symbol' || !shouldRestart) {
        consola.info('Restart skipped. Run `copilot-proxy restart` when ready.')
        return
      }

      if (!stopDaemon()) {
        consola.error('Failed to stop daemon. Try `copilot-proxy restart` manually.')
        process.exit(1)
      }

      await daemonStart(updated)
    }
    else {
      consola.info('Daemon is not running. Changes will apply on next `copilot-proxy start -d`.')
    }
  },
})
