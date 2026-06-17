import type { DaemonConfig } from '~/daemon/config'
import process from 'node:process'
import { defineCommand } from 'citty'

import consola from 'consola'
import { DEFAULT_SERVICE_CONFIG, loadDaemonConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands } from '~/daemon/native-service'
import { isDaemonRunning } from '~/daemon/pid'
import { stopDaemon } from '~/daemon/stop'

export function buildServiceStartArgs(scriptPath: string, config: DaemonConfig): string[] {
  const args = [
    scriptPath,
    'start',
    '--port',
    String(config.port),
    '--host',
    config.host,
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
  if (config.headersTimeoutMs !== undefined)
    args.push('--headers-timeout-ms', String(config.headersTimeoutMs))
  if (config.bodyTimeoutMs !== undefined)
    args.push('--body-timeout-ms', String(config.bodyTimeoutMs))
  if (config.connectTimeoutMs !== undefined)
    args.push('--connect-timeout-ms', String(config.connectTimeoutMs))
  if (config.proxyEnv)
    args.push('--proxy-env')

  return args
}

export const enable = defineCommand({
  meta: {
    name: 'enable',
    description: 'Register as auto-start service',
  },
  async run() {
    const savedConfig = loadDaemonConfig()
    const config = savedConfig ?? { ...DEFAULT_SERVICE_CONFIG }
    if (!savedConfig)
      consola.info('No legacy daemon config found. Using default native service config.')
    if (config.showToken) {
      consola.error('Cannot enable auto-start while --show-token is persisted in the legacy daemon config. Save the config again without --show-token first.')
      process.exit(1)
    }

    const execPath = process.argv[0]
    const scriptPath = process.argv[1]
    const args = buildServiceStartArgs(scriptPath, config)

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

    const nativeService = await loadInstalledNativeServiceCommands()
    if (!nativeService) {
      consola.warn('Auto-start service was installed, but no native service controller was detected for this platform.')
      return
    }

    const daemon = isDaemonRunning()
    if (daemon.running) {
      consola.info('Stopping existing app-managed daemon before starting the native service...')
      if (!stopDaemon()) {
        consola.error('Cannot start native service: failed to stop existing app-managed daemon')
        process.exit(1)
      }
    }

    if (!nativeService.restartAutoStartService()) {
      process.exit(1)
    }
  },
})
