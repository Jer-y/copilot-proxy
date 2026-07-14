import type { DaemonConfig } from '~/daemon/config'
import type { NativeServiceActivationState, NativeServiceCommands } from '~/daemon/native-service'
import type { NativeServiceConfig } from '~/daemon/service-install-state'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'

import consola from 'consola'
import { writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'
import { DEFAULT_SERVICE_CONFIG, loadDaemonConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands, loadNativeServiceCommands, waitForNativeServiceReadiness } from '~/daemon/native-service'
import { isDaemonRunning } from '~/daemon/pid'
import { loadNativeServiceEnvironment, saveNativeServiceEnvironment } from '~/daemon/service-env'
import { loadNativeServiceInstallState, NATIVE_SERVICE_DEFINITION_PATH_ENV, removeNativeServiceInstallState, saveNativeServiceInstallState, toNativeServiceConfig } from '~/daemon/service-install-state'
import { stopDaemon } from '~/daemon/stop'
import { validateMaxConcurrency, validateMaxQueue, validateQueueTimeoutMs } from '~/lib/cli-validators'
import { resolveConcurrencyLimitConfig } from '~/lib/concurrency-limiter'
import { getUserHomeDir, PATHS } from '~/lib/paths'

export function buildServiceStartArgs(
  scriptPath: string,
  config: DaemonConfig,
  instanceToken?: string,
): string[] {
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
  if (config.maxConcurrency !== undefined)
    args.push('--max-concurrency', String(config.maxConcurrency))
  if (config.maxQueue !== undefined)
    args.push('--max-queue', String(config.maxQueue))
  if (config.queueTimeoutMs !== undefined)
    args.push('--queue-timeout-ms', String(config.queueTimeoutMs))
  if (config.headersTimeoutMs !== undefined)
    args.push('--headers-timeout-ms', String(config.headersTimeoutMs))
  if (config.bodyTimeoutMs !== undefined)
    args.push('--body-timeout-ms', String(config.bodyTimeoutMs))
  if (config.connectTimeoutMs !== undefined)
    args.push('--connect-timeout-ms', String(config.connectTimeoutMs))
  if (config.proxyEnv)
    args.push('--proxy-env')
  if (instanceToken)
    args.push('--_instance-token', instanceToken)

  return args
}

interface NativeServiceEnableConfigOptions {
  savedConfig?: DaemonConfig
  installedConfig?: NativeServiceConfig
  maxConcurrency?: string
  maxQueue?: string
  queueTimeoutMs?: string
  clearConcurrencyLimit?: boolean
}

export function resolveNativeServiceEnableConfig(
  options: NativeServiceEnableConfigOptions,
): DaemonConfig {
  const config: DaemonConfig = {
    ...(options.installedConfig
      ?? options.savedConfig
      ?? DEFAULT_SERVICE_CONFIG),
  }

  const hasConcurrencyOverride = options.maxConcurrency !== undefined
    || options.maxQueue !== undefined
    || options.queueTimeoutMs !== undefined
  if (options.clearConcurrencyLimit && hasConcurrencyOverride) {
    throw new TypeError('--clear-concurrency-limit cannot be combined with concurrency limit options')
  }

  if (options.clearConcurrencyLimit) {
    delete config.maxConcurrency
    delete config.maxQueue
    delete config.queueTimeoutMs
    return config
  }

  const maxConcurrency = validateMaxConcurrency(options.maxConcurrency)
  if (!maxConcurrency.valid)
    throw new TypeError('--max-concurrency must be a positive integer')
  const maxQueue = validateMaxQueue(options.maxQueue)
  if (!maxQueue.valid)
    throw new TypeError('--max-queue must be a non-negative integer')
  const queueTimeoutMs = validateQueueTimeoutMs(options.queueTimeoutMs)
  if (!queueTimeoutMs.valid)
    throw new TypeError('--queue-timeout-ms must be an integer between 0 and the platform timer limit')

  if (options.maxConcurrency !== undefined)
    config.maxConcurrency = maxConcurrency.value
  if (options.maxQueue !== undefined)
    config.maxQueue = maxQueue.value
  if (options.queueTimeoutMs !== undefined)
    config.queueTimeoutMs = queueTimeoutMs.value

  resolveConcurrencyLimitConfig(config)
  return config
}

export function resolveNativeServiceInstallLocations(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  userHome: string = getUserHomeDir(env),
): { serviceDefinitionPath?: string, xdgConfigHome?: string } {
  const configuredXdgHome = env.XDG_CONFIG_HOME?.trim()
  const xdgConfigHome = platform === 'linux'
    ? configuredXdgHome && path.isAbsolute(configuredXdgHome)
      ? configuredXdgHome
      : path.join(userHome, '.config')
    : undefined
  const persistedDefinitionPath = env[NATIVE_SERVICE_DEFINITION_PATH_ENV]
  const serviceDefinitionPath = persistedDefinitionPath && path.isAbsolute(persistedDefinitionPath)
    ? persistedDefinitionPath
    : platform === 'linux'
      ? path.join(xdgConfigHome!, 'systemd', 'user', 'copilot-proxy.service')
      : platform === 'darwin'
        ? path.join(userHome, 'Library', 'LaunchAgents', 'com.copilot-proxy.plist')
        : undefined
  return {
    ...(serviceDefinitionPath && { serviceDefinitionPath }),
    ...(xdgConfigHome && { xdgConfigHome }),
  }
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
  args: {
    'max-concurrency': {
      type: 'string',
      description: 'Maximum concurrent Copilot upstream requests',
    },
    'max-queue': {
      type: 'string',
      description: 'Maximum requests waiting for a concurrency slot',
    },
    'queue-timeout-ms': {
      type: 'string',
      description: 'Maximum time to wait for a concurrency slot',
    },
    'clear-concurrency-limit': {
      type: 'boolean',
      default: false,
      description: 'Remove persisted concurrency and queue limits',
    },
  },
  async run({ args }) {
    const previousInstallState = loadNativeServiceInstallState()
    const savedConfig = loadDaemonConfig()
    let config: DaemonConfig
    try {
      config = resolveNativeServiceEnableConfig({
        savedConfig: savedConfig ?? undefined,
        installedConfig: previousInstallState?.config,
        maxConcurrency: args['max-concurrency'],
        maxQueue: args['max-queue'],
        queueTimeoutMs: args['queue-timeout-ms'],
        clearConcurrencyLimit: args['clear-concurrency-limit'],
      })
    }
    catch (error) {
      consola.error(error instanceof Error ? error.message : error)
      process.exit(1)
    }
    if (previousInstallState?.config)
      consola.info('Reusing the previously installed native service config.')
    else if (!savedConfig)
      consola.info('No legacy daemon config found. Using default native service config.')
    else
      consola.info('Migrating the legacy daemon config to the native service config.')
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
    const platformCommands = await loadNativeServiceCommands()
    if (!platformCommands) {
      consola.error(`Unsupported platform: ${platform}`)
      process.exit(1)
    }

    let previousAutoStartState: NativeServiceActivationState
    try {
      previousAutoStartState = platformCommands.captureAutoStartState()
    }
    catch (error) {
      consola.error('Cannot inspect the existing native service before replacing it:', error instanceof Error ? error.message : error)
      process.exit(1)
    }

    const instanceToken = randomUUID()
    const serviceArgs = buildServiceStartArgs(scriptPath, config, instanceToken)
    if (platform === 'darwin' || platform === 'win32')
      serviceArgs.push('--_log-file')

    const previousServiceEnvironment = readExistingServiceEnvironment()
    let replacementServiceEnvironment: ExistingServiceEnvironment | undefined
    let replacementInstallState: ReturnType<typeof loadNativeServiceInstallState>
    try {
      // Re-running enable snapshots the current shell exactly. Missing values
      // intentionally clear stale service settings, including lower/uppercase
      // proxy aliases that proxy-from-env resolves with different precedence.
      saveNativeServiceEnvironment({ proxyEnv: config.proxyEnv, sourceEnv: process.env })
      const { serviceDefinitionPath, xdgConfigHome } = resolveNativeServiceInstallLocations(platform, process.env)
      saveNativeServiceInstallState({
        dataDir: PATHS.APP_DIR,
        proxyEnv: config.proxyEnv,
        instanceToken,
        config: toNativeServiceConfig(config),
        ...(serviceDefinitionPath && { serviceDefinitionPath }),
        ...(xdgConfigHome && { xdgConfigHome }),
      })
      replacementServiceEnvironment = readExistingServiceEnvironment()
      replacementInstallState = loadNativeServiceInstallState()
    }
    catch (error) {
      consola.error('Cannot persist native service environment:', error instanceof Error ? error.message : error)
      tryRestorePersistedState(previousServiceEnvironment, previousInstallState, 'previous native service state')
      process.exit(1)
    }

    try {
      if (platform === 'linux') {
        const { installAutoStart } = await import('~/daemon/platform/linux')
        success = await installAutoStart(execPath, serviceArgs)
      }
      else if (platform === 'darwin') {
        const { installAutoStart } = await import('~/daemon/platform/darwin')
        success = await installAutoStart(execPath, serviceArgs)
      }
      else if (platform === 'win32') {
        const { installAutoStart } = await import('~/daemon/platform/win32')
        success = await installAutoStart(execPath, serviceArgs)
      }
      else {
        throw new Error(`Unsupported platform: ${platform}`)
      }
    }
    catch (error) {
      consola.error('Native service installation failed unexpectedly:', error instanceof Error ? error.message : error)
      await rollbackEnableInstallation(
        platform,
        previousServiceEnvironment,
        previousInstallState,
        replacementServiceEnvironment,
        replacementInstallState,
        previousAutoStartState,
        platformCommands,
      )
      process.exit(1)
    }

    if (!success) {
      await rollbackEnableInstallation(
        platform,
        previousServiceEnvironment,
        previousInstallState,
        replacementServiceEnvironment,
        replacementInstallState,
        previousAutoStartState,
        platformCommands,
      )
      process.exit(1)
    }

    let nativeService: NativeServiceCommands | null
    try {
      nativeService = await loadInstalledNativeServiceCommands()
    }
    catch (error) {
      consola.error('Failed to verify the installed native service:', error instanceof Error ? error.message : error)
      await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands)
      process.exit(1)
    }
    if (!nativeService) {
      consola.error('Auto-start installation did not produce a detectable native service.')
      await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands)
      process.exit(1)
    }

    const daemon = isDaemonRunning()
    const legacyWasRunning = daemon.running
    if (daemon.running) {
      consola.info('Stopping existing app-managed daemon before starting the native service...')
      if (!stopDaemon()) {
        consola.error('Cannot start native service: failed to stop existing app-managed daemon')
        await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands)
        process.exit(1)
      }
    }

    let serviceStarted = false
    try {
      serviceStarted = nativeService.restartAutoStartService()
    }
    catch (error) {
      consola.error('Failed to activate native service:', error instanceof Error ? error.message : error)
    }
    if (!serviceStarted) {
      if (await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands)) {
        if (legacyWasRunning)
          await restoreLegacyDaemon(config)
      }
      process.exit(1)
    }

    if (!await waitForNativeServiceReadiness(config, { expectedInstanceToken: instanceToken })) {
      consola.error(`Native service did not become ready on ${config.host}:${config.port} within the startup deadline.`)
      if (await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands)) {
        if (legacyWasRunning)
          await restoreLegacyDaemon(config)
      }
      process.exit(1)
    }

    try {
      await commitAutoStartInstall(platform)
    }
    catch (error) {
      consola.error('Failed to commit native service installation:', error instanceof Error ? error.message : error)
      if (await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands)) {
        if (legacyWasRunning)
          await restoreLegacyDaemon(config)
      }
      process.exit(1)
    }

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

interface RollbackEnableTransactionOperations {
  restorePreviousPersistedState: () => boolean
  restoreReplacementPersistedState: () => boolean
  rollbackPlatformDefinition: () => boolean | Promise<boolean>
  restorePreviousAutoStartState: (state: NativeServiceActivationState) => boolean | Promise<boolean>
}

export async function rollbackEnableTransaction(
  previousAutoStartState: NativeServiceActivationState,
  operations: RollbackEnableTransactionOperations,
): Promise<boolean> {
  // Platform definition rollback does not activate the previous service. Keep
  // replacement metadata in place until the definition is known to be restored.
  if (!await operations.rollbackPlatformDefinition()) {
    operations.restoreReplacementPersistedState()
    return false
  }

  // The previous definition is now back on disk/registered but still stopped.
  // Restore its environment/control metadata before reactivating it.
  if (!operations.restorePreviousPersistedState())
    return false

  try {
    return await operations.restorePreviousAutoStartState(previousAutoStartState)
  }
  catch {
    return false
  }
}

async function rollbackEnableInstallation(
  platform: NodeJS.Platform,
  previousServiceEnvironment: ExistingServiceEnvironment | undefined,
  previousInstallState: ReturnType<typeof loadNativeServiceInstallState>,
  replacementServiceEnvironment: ExistingServiceEnvironment | undefined,
  replacementInstallState: ReturnType<typeof loadNativeServiceInstallState>,
  previousAutoStartState: NativeServiceActivationState,
  platformCommands: NativeServiceCommands,
): Promise<boolean> {
  const restored = await rollbackEnableTransaction(previousAutoStartState, {
    restorePreviousPersistedState: () => tryRestorePersistedState(
      previousServiceEnvironment,
      previousInstallState,
      'previous native service state',
    ),
    restoreReplacementPersistedState: () => tryRestorePersistedState(
      replacementServiceEnvironment,
      replacementInstallState,
      'replacement native service state',
    ),
    rollbackPlatformDefinition: () => rollbackAutoStartInstall(platform),
    restorePreviousAutoStartState: state => platformCommands.restoreAutoStartState(state),
  })
  if (!restored) {
    consola.error('Native service definition rollback did not fully restore its previous enabled/running state.')
  }
  return restored
}

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
  if (previous)
    writeOwnerOnlyFileAtomically(PATHS.NATIVE_SERVICE_ENV, previous.content)
  else
    fs.rmSync(PATHS.NATIVE_SERVICE_ENV, { force: true })
}

function restoreInstallState(previous: ReturnType<typeof loadNativeServiceInstallState>): void {
  if (previous)
    saveNativeServiceInstallState(previous)
  else
    removeNativeServiceInstallState()
}

function tryRestorePersistedState(
  serviceEnvironment: ExistingServiceEnvironment | undefined,
  installState: ReturnType<typeof loadNativeServiceInstallState>,
  label: string,
): boolean {
  try {
    restoreServiceEnvironment(serviceEnvironment)
    restoreInstallState(installState)
    return true
  }
  catch (error) {
    consola.error(`Failed to restore ${label}:`, error instanceof Error ? error.message : error)
    return false
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
  try {
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
  catch (error) {
    consola.error('Failed to roll back native service installation:', error instanceof Error ? error.message : error)
    return false
  }
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
