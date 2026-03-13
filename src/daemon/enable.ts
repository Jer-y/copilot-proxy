import type { DaemonConfig } from '~/daemon/config'
import process from 'node:process'
import { defineCommand } from 'citty'

import consola from 'consola'
import { loadDaemonConfig } from '~/daemon/config'

export function buildSupervisorStartArgs(scriptPath: string, config: DaemonConfig): string[] {
  const args = [
    scriptPath,
    'start',
    '--_supervisor',
    '--port',
    String(config.port),
    '--account-type',
    config.accountType,
  ]

  if (config.verbose)
    args.push('--verbose')
  if (config.manual)
    args.push('--manual')
  if (config.rateLimit !== undefined)
    args.push('--rate-limit', String(config.rateLimit))
  if (config.rateLimitWait)
    args.push('--wait')
  if (config.showToken)
    args.push('--show-token')
  if (config.proxyEnv)
    args.push('--proxy-env')
  // Note: apiKey is intentionally NOT passed via command-line arguments.
  // The supervisor already recovers it from daemon.json at startup, and
  // putting it in argv would persist the secret into systemd units /
  // launchd plists / Windows scheduled task XML.

  return args
}

export const enable = defineCommand({
  meta: {
    name: 'enable',
    description: 'Register as auto-start service',
  },
  async run() {
    const config = loadDaemonConfig()
    if (!config) {
      consola.error('No daemon config found. Start the daemon first with `start -d`')
      process.exit(1)
    }

    const execPath = process.argv[0]
    const scriptPath = process.argv[1]
    const args = buildSupervisorStartArgs(scriptPath, config)

    let success = false
    const { platform } = process
    if (platform === 'linux') {
      const { installAutoStart } = await import('~/daemon/platform/linux')
      success = await installAutoStart(execPath, args)
    }
    else if (platform === 'darwin') {
      const { installAutoStart } = await import('~/daemon/platform/darwin')
      success = await installAutoStart(execPath, args)
    }
    else if (platform === 'win32') {
      const { installAutoStart } = await import('~/daemon/platform/win32')
      success = await installAutoStart(execPath, args)
    }
    else {
      consola.error(`Unsupported platform: ${platform}`)
      process.exit(1)
    }

    if (!success) {
      process.exit(1)
    }
  },
})
