import type { DaemonConfig } from '~/daemon/config'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'

import consola from 'consola'
import { DEFAULT_SERVICE_CONFIG, loadDaemonConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands } from '~/daemon/native-service'
import { isDaemonRunning } from '~/daemon/pid'
import { loadNativeServiceEnvironment, saveNativeServiceEnvironment } from '~/daemon/service-env'
import { loadNativeServiceInstallState, removeNativeServiceInstallState, saveNativeServiceInstallState } from '~/daemon/service-install-state'
import { stopDaemon } from '~/daemon/stop'
import { PATHS } from '~/lib/paths'

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
    '--_service',
    '--_data-dir',
    PATHS.APP_DIR,
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
    || normalized.includes('/npm-cache/_npx/')
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

    let success = false
    const { platform } = process
    const args = buildServiceStartArgs(scriptPath, config)
    if (platform === 'darwin' || platform === 'win32')
      args.push('--_log-file')

    const previousServiceEnvironment = readExistingServiceEnvironment()
    const previousInstallState = loadNativeServiceInstallState()
    try {
      // Re-running enable snapshots the current shell exactly. Missing values
      // intentionally clear stale service settings, including lower/uppercase
      // proxy aliases that proxy-from-env resolves with different precedence.
      saveNativeServiceEnvironment({ proxyEnv: config.proxyEnv, sourceEnv: process.env })
      saveNativeServiceInstallState({ dataDir: PATHS.APP_DIR })
    }
    catch (error) {
      consola.error('Cannot persist native service environment:', error instanceof Error ? error.message : error)
      restoreServiceEnvironment(previousServiceEnvironment)
      restoreInstallState(previousInstallState)
      process.exit(1)
    }

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
      restoreServiceEnvironment(previousServiceEnvironment)
      restoreInstallState(previousInstallState)
      process.exit(1)
    }

    if (!success) {
      restoreServiceEnvironment(previousServiceEnvironment)
      restoreInstallState(previousInstallState)
      process.exit(1)
    }

    const nativeService = await loadInstalledNativeServiceCommands()
    if (!nativeService) {
      consola.error('Auto-start installation did not produce a detectable native service.')
      if (await rollbackAutoStartInstall(platform)) {
        restoreServiceEnvironment(previousServiceEnvironment)
        restoreInstallState(previousInstallState)
      }
      process.exit(1)
    }

    const daemon = isDaemonRunning()
    const legacyWasRunning = daemon.running
    if (daemon.running) {
      consola.info('Stopping existing app-managed daemon before starting the native service...')
      if (!stopDaemon()) {
        consola.error('Cannot start native service: failed to stop existing app-managed daemon')
        if (await rollbackAutoStartInstall(platform)) {
          restoreServiceEnvironment(previousServiceEnvironment)
          restoreInstallState(previousInstallState)
        }
        process.exit(1)
      }
    }

    if (!nativeService.restartAutoStartService()) {
      if (await rollbackAutoStartInstall(platform)) {
        restoreServiceEnvironment(previousServiceEnvironment)
        restoreInstallState(previousInstallState)
        if (legacyWasRunning)
          await restoreLegacyDaemon(config)
      }
      process.exit(1)
    }

    await commitAutoStartInstall(platform)

    if (previousInstallState && previousInstallState.dataDir !== PATHS.APP_DIR) {
      try {
        fs.rmSync(path.join(previousInstallState.dataDir, 'service-env.json'), { force: true })
      }
      catch (error) {
        consola.warn('Failed to remove the previous native-service environment:', error instanceof Error ? error.message : error)
      }
    }
  },
})

interface ExistingServiceEnvironment {
  content: Uint8Array
}

function readExistingServiceEnvironment(): ExistingServiceEnvironment | undefined {
  try {
    return {
      content: fs.readFileSync(PATHS.NATIVE_SERVICE_ENV),
    }
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

function restoreServiceEnvironment(previous: ExistingServiceEnvironment | undefined): void {
  try {
    if (previous) {
      fs.writeFileSync(PATHS.NATIVE_SERVICE_ENV, previous.content, { mode: 0o600 })
      fs.chmodSync(PATHS.NATIVE_SERVICE_ENV, 0o600)
    }
    else {
      fs.rmSync(PATHS.NATIVE_SERVICE_ENV, { force: true })
    }
  }
  catch (error) {
    consola.error('Failed to restore native service environment:', error instanceof Error ? error.message : error)
  }
}

function restoreInstallState(previous: ReturnType<typeof loadNativeServiceInstallState>): void {
  try {
    if (previous)
      saveNativeServiceInstallState(previous)
    else
      removeNativeServiceInstallState()
  }
  catch (error) {
    consola.error('Failed to restore native service control state:', error instanceof Error ? error.message : error)
  }
}

async function restoreLegacyDaemon(config: DaemonConfig): Promise<void> {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env }
    loadNativeServiceEnvironment({
      proxyEnv: config.proxyEnv,
      targetEnv: env,
      filePath: PATHS.DAEMON_ENV,
    })
    const { spawnLegacySupervisor } = await import('~/daemon/start')
    const pid = await spawnLegacySupervisor(config, env)
    consola.warn(`Native service activation failed; restored the previous legacy daemon (PID: ${pid}).`)
  }
  catch (error) {
    consola.error('Native service activation failed and the previous legacy daemon could not be restored:', error instanceof Error ? error.message : error)
  }
}

async function rollbackAutoStartInstall(platform: NodeJS.Platform): Promise<boolean> {
  consola.warn('Native service activation failed; restoring the previous auto-start definition.')
  if (platform === 'linux') {
    const { rollbackAutoStartInstall } = await import('~/daemon/platform/linux')
    return rollbackAutoStartInstall()
  }
  if (platform === 'darwin') {
    const { rollbackAutoStartInstall } = await import('~/daemon/platform/darwin')
    return rollbackAutoStartInstall()
  }
  if (platform === 'win32') {
    const { rollbackAutoStartInstall } = await import('~/daemon/platform/win32')
    return rollbackAutoStartInstall()
  }
  return false
}

async function commitAutoStartInstall(platform: NodeJS.Platform): Promise<void> {
  if (platform === 'linux') {
    const { commitAutoStartInstall } = await import('~/daemon/platform/linux')
    commitAutoStartInstall()
  }
  else if (platform === 'darwin') {
    const { commitAutoStartInstall } = await import('~/daemon/platform/darwin')
    commitAutoStartInstall()
  }
  else if (platform === 'win32') {
    const { commitAutoStartInstall } = await import('~/daemon/platform/win32')
    commitAutoStartInstall()
  }
}
