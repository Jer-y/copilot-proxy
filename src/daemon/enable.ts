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
import { DEFAULT_SERVICE_CONFIG, LEGACY_UNBOUNDED_SERVICE_CONFIG, loadDaemonConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands, loadNativeServiceCommands, resolveNativeServiceReadinessHost, waitForNativeServiceReadiness } from '~/daemon/native-service'
import { isDaemonRunning } from '~/daemon/pid'
import { loadNativeServiceEnvironment, saveNativeServiceEnvironment } from '~/daemon/service-env'
import { loadNativeServiceInstallState, NATIVE_SERVICE_DEFINITION_PATH_ENV, removeNativeServiceInstallState, saveNativeServiceInstallState, toNativeServiceConfig } from '~/daemon/service-install-state'
import { stopDaemon } from '~/daemon/stop'
import { validateAccountType, validateHost, validateMaxConcurrency, validateMaxQueue, validatePort, validateQueueTimeoutMs, validateRateLimit, validateTimeoutMs } from '~/lib/cli-validators'
import { resolveConcurrencyLimitConfig } from '~/lib/concurrency-limiter'
import { getUserHomeDir, PATHS } from '~/lib/paths'
import { resolveCittyBooleanOption } from '~/lib/proxy-environment'
import { isRunPresetName, resolveRunPreset, RUN_PRESET_NAMES } from '~/lib/run-presets'
import { ALLOWED_HOSTS_ENV, hasValidNonLoopbackAllowedHost, isLoopbackHostname } from '~/lib/security'

const ENABLE_STRING_OPTIONS = [
  { name: 'account-type', shortName: 'a' },
  { name: 'port', shortName: 'p' },
  { name: 'host', shortName: 'H' },
  { name: 'rate-limit', shortName: 'r' },
  { name: 'preset' },
  { name: 'max-concurrency' },
  { name: 'max-queue' },
  { name: 'queue-timeout-ms' },
  { name: 'headers-timeout-ms' },
  { name: 'body-timeout-ms' },
  { name: 'connect-timeout-ms' },
] as const

export function buildServiceStartArgs(
  scriptPath: string,
  config: DaemonConfig,
  instanceToken?: string,
): string[] {
  const args = [
    scriptPath,
    'start',
    '--preset',
    'custom',
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
  accountType?: string
  bodyTimeoutMs?: string
  clearRateLimit?: boolean
  clearTimeoutOverrides?: boolean
  connectTimeoutMs?: string
  existingNativeService?: boolean
  headersTimeoutMs?: string
  host?: string
  savedConfig?: DaemonConfig
  installedConfig?: NativeServiceConfig
  maxConcurrency?: string
  maxQueue?: string
  port?: string
  proxyEnv?: boolean
  queueTimeoutMs?: string
  rateLimit?: string
  rateLimitWait?: boolean
  clearConcurrencyLimit?: boolean
  preset?: string
  verbose?: boolean
}

export function resolveNativeServiceEnableConfig(
  options: NativeServiceEnableConfigOptions,
): DaemonConfig {
  const config: DaemonConfig = {
    ...(options.installedConfig
      ?? options.savedConfig
      ?? (options.existingNativeService ? LEGACY_UNBOUNDED_SERVICE_CONFIG : DEFAULT_SERVICE_CONFIG)),
  }

  if (options.preset !== undefined) {
    if (!isRunPresetName(options.preset))
      throw new TypeError(`--preset must be one of: ${RUN_PRESET_NAMES.join(', ')}`)
    const preset = resolveRunPreset(options.preset)
    config.host = preset.host
    if (preset.maxConcurrency === undefined)
      delete config.maxConcurrency
    else
      config.maxConcurrency = preset.maxConcurrency
    if (preset.maxQueue === undefined)
      delete config.maxQueue
    else
      config.maxQueue = preset.maxQueue
    if (preset.queueTimeoutMs === undefined)
      delete config.queueTimeoutMs
    else
      config.queueTimeoutMs = preset.queueTimeoutMs
  }

  if (options.port !== undefined) {
    const port = validatePort(options.port)
    if (port === null)
      throw new TypeError('--port must be an integer between 1 and 65535')
    config.port = port
  }
  if (options.host !== undefined) {
    const host = validateHost(options.host)
    if (host === null)
      throw new TypeError('--host must be a non-empty hostname or IP address without whitespace or paths')
    config.host = host
  }
  if (options.accountType !== undefined) {
    if (!validateAccountType(options.accountType))
      throw new TypeError('--account-type must be one of: individual, business, enterprise')
    config.accountType = options.accountType
  }
  if (options.proxyEnv !== undefined)
    config.proxyEnv = options.proxyEnv
  if (options.verbose !== undefined)
    config.verbose = options.verbose

  if (options.clearRateLimit && (options.rateLimit !== undefined || options.rateLimitWait !== undefined))
    throw new TypeError('--clear-rate-limit cannot be combined with --rate-limit, --wait, or --no-wait')
  if (options.clearRateLimit) {
    delete config.rateLimit
    config.rateLimitWait = false
  }
  else {
    const rateLimit = validateRateLimit(options.rateLimit)
    if (!rateLimit.valid)
      throw new TypeError('--rate-limit must be an integer between 1 and 86400')
    if (options.rateLimit !== undefined)
      config.rateLimit = rateLimit.value
    if (options.rateLimitWait !== undefined)
      config.rateLimitWait = options.rateLimitWait
  }

  const hasTimeoutOverride = options.headersTimeoutMs !== undefined
    || options.bodyTimeoutMs !== undefined
    || options.connectTimeoutMs !== undefined
  if (options.clearTimeoutOverrides && hasTimeoutOverride)
    throw new TypeError('--clear-timeout-overrides cannot be combined with timeout override options')
  if (options.clearTimeoutOverrides) {
    delete config.headersTimeoutMs
    delete config.bodyTimeoutMs
    delete config.connectTimeoutMs
  }
  else {
    const headersTimeoutMs = validateTimeoutMs(options.headersTimeoutMs)
    const bodyTimeoutMs = validateTimeoutMs(options.bodyTimeoutMs)
    const connectTimeoutMs = validateTimeoutMs(options.connectTimeoutMs)
    if (!headersTimeoutMs.valid)
      throw new TypeError('--headers-timeout-ms must be an integer between 0 and the platform timer limit')
    if (!bodyTimeoutMs.valid)
      throw new TypeError('--body-timeout-ms must be an integer between 0 and the platform timer limit')
    if (!connectTimeoutMs.valid)
      throw new TypeError('--connect-timeout-ms must be an integer between 0 and the platform timer limit')
    if (options.headersTimeoutMs !== undefined)
      config.headersTimeoutMs = headersTimeoutMs.value
    if (options.bodyTimeoutMs !== undefined)
      config.bodyTimeoutMs = bodyTimeoutMs.value
    if (options.connectTimeoutMs !== undefined)
      config.connectTimeoutMs = connectTimeoutMs.value
  }

  const hasConcurrencyOverride = options.maxConcurrency !== undefined
    || options.maxQueue !== undefined
    || options.queueTimeoutMs !== undefined
  if (options.clearConcurrencyLimit && (hasConcurrencyOverride || options.preset !== undefined)) {
    throw new TypeError('--clear-concurrency-limit cannot be combined with a preset or concurrency limit options')
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

export function resolveLegacyDaemonRestoreConfig(
  legacyRunning: boolean,
  savedConfig: DaemonConfig | null,
): DaemonConfig | undefined {
  if (!legacyRunning)
    return undefined
  if (!savedConfig) {
    throw new Error('Cannot replace the running app-managed daemon because its persisted daemon config is missing or invalid. Restore it, or stop the daemon and rerun `start -d` with the intended options, before retrying `enable`.')
  }
  return { ...savedConfig }
}

export function nativeServiceHostEnvironmentError(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (isLoopbackHostname(host) || hasValidNonLoopbackAllowedHost(env[ALLOWED_HOSTS_ENV]))
    return undefined
  return 'A non-loopback native service requires COPILOT_PROXY_ALLOWED_HOSTS to be a valid exact Host allowlist containing at least one non-loopback hostname or IP address. Schemes, ports, paths, wildcards, empty entries, and a loopback-only allowlist are not accepted.'
}

export function resolveNativeServiceInstallLocations(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  userHome: string = getUserHomeDir(env),
): { serviceDefinitionPath?: string, xdgConfigHome?: string } {
  const platformPath = platform === 'win32' ? path.win32 : path.posix
  const configuredXdgHome = env.XDG_CONFIG_HOME?.trim()
  const xdgConfigHome = platform === 'linux'
    ? configuredXdgHome && platformPath.isAbsolute(configuredXdgHome)
      ? configuredXdgHome
      : platformPath.join(userHome, '.config')
    : undefined
  const persistedDefinitionPath = env[NATIVE_SERVICE_DEFINITION_PATH_ENV]
  const serviceDefinitionPath = persistedDefinitionPath && platformPath.isAbsolute(persistedDefinitionPath)
    ? persistedDefinitionPath
    : platform === 'linux'
      ? platformPath.join(xdgConfigHome!, 'systemd', 'user', 'copilot-proxy.service')
      : platform === 'darwin'
        ? platformPath.join(userHome, 'Library', 'LaunchAgents', 'com.copilot-proxy.plist')
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
    'account-type': {
      alias: 'a',
      type: 'string',
      description: 'Persist the Copilot account type (individual, business, or enterprise)',
    },
    'port': {
      alias: 'p',
      type: 'string',
      description: 'Persist the service listen port',
    },
    'host': {
      alias: 'H',
      type: 'string',
      description: 'Persist the service bind host/IP',
    },
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Persist and use configured HTTP(S)_PROXY/NO_PROXY variables; --no-proxy-env clears it',
    },
    'verbose': {
      alias: 'v',
      type: 'boolean',
      default: false,
      description: 'Persist verbose service logging; --no-verbose disables it',
    },
    'rate-limit': {
      alias: 'r',
      type: 'string',
      description: 'Persist the minimum seconds between requests',
    },
    'wait': {
      alias: 'w',
      type: 'boolean',
      default: false,
      description: 'Wait instead of rejecting when the persisted rate limit is reached; --no-wait disables it',
    },
    'clear-rate-limit': {
      type: 'boolean',
      default: false,
      description: 'Remove the persisted rate limit and wait policy',
    },
    'preset': {
      type: 'enum',
      options: [...RUN_PRESET_NAMES],
      description: 'Apply a safe persisted runtime preset before installing the service',
    },
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
    'headers-timeout-ms': {
      type: 'string',
      description: 'Persist the upstream response-headers timeout in milliseconds',
    },
    'body-timeout-ms': {
      type: 'string',
      description: 'Persist the upstream response-body inactivity timeout in milliseconds',
    },
    'connect-timeout-ms': {
      type: 'string',
      description: 'Persist the upstream connection timeout in milliseconds',
    },
    'clear-timeout-overrides': {
      type: 'boolean',
      default: false,
      description: 'Remove all persisted upstream timeout overrides',
    },
    'clear-concurrency-limit': {
      type: 'boolean',
      default: false,
      description: 'Remove persisted concurrency and queue limits',
    },
  },
  async run({ args, rawArgs }) {
    const previousInstallState = loadNativeServiceInstallState()
    const savedConfig = loadDaemonConfig()
    let existingNativeService = previousInstallState !== undefined
    try {
      if (!existingNativeService)
        existingNativeService = await loadInstalledNativeServiceCommands() !== null
    }
    catch (error) {
      consola.error('Cannot inspect the existing native service before resolving its configuration:', error instanceof Error ? error.message : error)
      process.exit(1)
    }
    let config: DaemonConfig
    try {
      const proxyEnv = resolveExplicitBooleanOption(
        rawArgs,
        'proxy-env',
      )
      const verbose = resolveExplicitBooleanOption(
        rawArgs,
        'verbose',
        'v',
      )
      const rateLimitWait = resolveExplicitBooleanOption(
        rawArgs,
        'wait',
        'w',
      )
      config = resolveNativeServiceEnableConfig({
        accountType: args['account-type'],
        bodyTimeoutMs: args['body-timeout-ms'],
        clearRateLimit: args['clear-rate-limit'],
        clearTimeoutOverrides: args['clear-timeout-overrides'],
        connectTimeoutMs: args['connect-timeout-ms'],
        existingNativeService,
        headersTimeoutMs: args['headers-timeout-ms'],
        host: args.host,
        savedConfig: savedConfig ?? undefined,
        installedConfig: previousInstallState?.config,
        maxConcurrency: args['max-concurrency'],
        maxQueue: args['max-queue'],
        port: args.port,
        proxyEnv,
        queueTimeoutMs: args['queue-timeout-ms'],
        rateLimit: args['rate-limit'],
        rateLimitWait,
        clearConcurrencyLimit: args['clear-concurrency-limit'],
        preset: args.preset,
        verbose,
      })
    }
    catch (error) {
      consola.error(error instanceof Error ? error.message : error)
      process.exit(1)
    }
    if (previousInstallState?.config)
      consola.info('Reusing the previously installed native service config.')
    else if (existingNativeService && !savedConfig)
      consola.info('The existing native service predates persisted config; preserving its legacy unbounded concurrency behavior.')
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
    const hostEnvironmentError = nativeServiceHostEnvironmentError(config.host)
    if (hostEnvironmentError) {
      consola.error(hostEnvironmentError)
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
    let readinessRequestHost: string
    try {
      // Re-running enable snapshots the supported service-runtime settings
      // from the current shell exactly. Missing values intentionally clear
      // stale settings, including proxy aliases with different precedence.
      const savedEnvironment = saveNativeServiceEnvironment({ proxyEnv: config.proxyEnv, sourceEnv: process.env })
      const resolvedReadinessHost = resolveNativeServiceReadinessHost(config.host, savedEnvironment)
      if (!resolvedReadinessHost)
        throw new Error('The persisted native-service environment has no non-loopback Host available for readiness verification.')
      readinessRequestHost = resolvedReadinessHost
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
    let legacyRestoreConfig: DaemonConfig | undefined
    try {
      // The replacement preset may change host or concurrency. The legacy
      // supervisor reloads daemon.json, so rollback readiness must use this
      // pre-migration snapshot rather than the replacement service config.
      legacyRestoreConfig = resolveLegacyDaemonRestoreConfig(daemon.running, savedConfig)
    }
    catch (error) {
      consola.error(error instanceof Error ? error.message : error)
      await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands)
      process.exit(1)
    }
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
      await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands, legacyRestoreConfig)
      process.exit(1)
    }

    if (!await waitForNativeServiceReadiness(config, {
      expectedInstanceToken: instanceToken,
      requestHost: readinessRequestHost,
    })) {
      consola.error(`Native service did not become ready on ${config.host}:${config.port} within the startup deadline.`)
      await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands, legacyRestoreConfig)
      process.exit(1)
    }

    try {
      await commitAutoStartInstall(platform)
    }
    catch (error) {
      consola.error('Failed to commit native service installation:', error instanceof Error ? error.message : error)
      await rollbackEnableInstallation(platform, previousServiceEnvironment, previousInstallState, replacementServiceEnvironment, replacementInstallState, previousAutoStartState, platformCommands, legacyRestoreConfig)
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

export function resolveExplicitBooleanOption(
  rawArgs: string[],
  name: string,
  shortName?: 'v' | 'w',
): boolean | undefined {
  const resolution = resolveCittyBooleanOption(rawArgs, name, {
    shortName,
    stringOptions: ENABLE_STRING_OPTIONS,
  })
  if (resolution.positiveValue === true && resolution.negated)
    throw new TypeError(`--${name} and --no-${name} cannot be combined`)
  return resolution.value
}

interface RollbackEnableTransactionOperations {
  restorePreviousPersistedState: () => boolean
  restoreReplacementPersistedState: () => boolean
  rollbackPlatformDefinition: () => boolean | Promise<boolean>
  restorePreviousAutoStartState: (state: NativeServiceActivationState) => boolean | Promise<boolean>
  restoreLegacyDaemon?: (config: DaemonConfig) => boolean | Promise<boolean>
}

export async function rollbackEnableTransaction(
  previousAutoStartState: NativeServiceActivationState,
  operations: RollbackEnableTransactionOperations,
  legacyRestoreConfig?: DaemonConfig,
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
    if (!await operations.restorePreviousAutoStartState(previousAutoStartState))
      return false
    if (legacyRestoreConfig) {
      if (!operations.restoreLegacyDaemon)
        return false
      return await operations.restoreLegacyDaemon(legacyRestoreConfig)
    }
    return true
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
  legacyRestoreConfig?: DaemonConfig,
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
    restoreLegacyDaemon,
  }, legacyRestoreConfig)
  if (!restored) {
    consola.error('Native service rollback did not fully restore its previous service state.')
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

async function restoreLegacyDaemon(config: DaemonConfig): Promise<boolean> {
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
    return true
  }
  catch (error) {
    consola.error('Native service activation failed and the previous legacy daemon could not be restored:', error instanceof Error ? error.message : error)
    return false
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
