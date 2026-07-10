import type { DaemonConfig } from '~/daemon/config'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'

import consola from 'consola'
import { DEFAULT_SERVICE_CONFIG, loadDaemonConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands, loadNativeServiceCommands } from '~/daemon/native-service'
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

export function isEphemeralPackageRunnerPath(scriptPath: string): boolean {
  const normalized = path.resolve(scriptPath).replace(/\\/g, '/').toLowerCase()
  return normalized.includes('/.npm/_npx/')
    || normalized.includes('/npm/_npx/')
    || normalized.includes('/pnpm/dlx/')
    || normalized.includes('/.bun/install/cache/')
    || /\/xfs-[^/]+\/dlx-/.test(normalized)
    || /\/bunx-[^/]+\//.test(normalized)
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
    if (config.manual) {
      consola.error('Cannot enable auto-start with manual approval enabled because native services have no interactive TTY. Disable manual mode in the saved daemon config first.')
      process.exit(1)
    }

    const execPath = process.argv[0]
    const scriptPath = process.argv[1]
    if (isEphemeralPackageRunnerPath(scriptPath)) {
      consola.error('Cannot enable auto-start from an ephemeral npx/dlx/bunx cache path. Install @jer-y/copilot-proxy globally (or run enable from a stable source checkout) and retry.')
      process.exit(1)
    }
    const args = buildServiceStartArgs(scriptPath, config)

    let success = false
    const { platform } = process
    const existingCommands = await loadNativeServiceCommands()
    const serviceWasInstalled = existingCommands?.isAutoStartInstalled() ?? false
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
      consola.error('Auto-start installation did not produce a detectable native service.')
      await rollbackNewInstallation(platform, serviceWasInstalled)
      process.exit(1)
    }

    const daemon = isDaemonRunning()
    if (daemon.running) {
      consola.info('Stopping existing app-managed daemon before starting the native service...')
      if (!stopDaemon()) {
        consola.error('Cannot start native service: failed to stop existing app-managed daemon')
        await rollbackNewInstallation(platform, serviceWasInstalled)
        process.exit(1)
      }
    }

    if (!nativeService.restartAutoStartService()) {
      await rollbackNewInstallation(platform, serviceWasInstalled)
      process.exit(1)
    }
  },
})

async function rollbackNewInstallation(platform: NodeJS.Platform, serviceWasInstalled: boolean): Promise<void> {
  if (serviceWasInstalled)
    return

  consola.warn('Native service activation failed; rolling back the new auto-start installation.')
  if (platform === 'linux') {
    const { uninstallAutoStart } = await import('~/daemon/platform/linux')
    await uninstallAutoStart()
  }
  else if (platform === 'darwin') {
    const { uninstallAutoStart } = await import('~/daemon/platform/darwin')
    await uninstallAutoStart()
  }
  else if (platform === 'win32') {
    const { uninstallAutoStart } = await import('~/daemon/platform/win32')
    await uninstallAutoStart()
  }
}
