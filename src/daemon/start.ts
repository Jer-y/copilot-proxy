import type { ChildProcess } from 'node:child_process'
import type { DaemonConfig } from '~/daemon/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

import consola from 'consola'
import { readFileSnapshot, restoreFileSnapshot, writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'
import { saveDaemonConfig } from '~/daemon/config'
import { ensureDaemonLogFile, rotateDaemonLogIfNeeded } from '~/daemon/log-file'
import { probeCopilotProxyServer, resolveNativeServiceReadinessHost } from '~/daemon/native-service'
import { isDaemonRunning, readPid, removePidFile } from '~/daemon/pid'
import { buildNativeServiceEnvironment, loadNativeServiceEnvironment, saveNativeServiceEnvironment } from '~/daemon/service-env'
import { PATHS } from '~/lib/paths'
import { checkPortAvailable, isPortInUseError } from '~/lib/port'

const DAEMON_ENV_ALLOWLIST = [
  // System essentials
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Node/Bun runtime
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'BUN_INSTALL',
  // XDG directories
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'COPILOT_PROXY_DATA_DIR',
  // Proxy local security configuration
  'COPILOT_PROXY_CORS_ORIGINS',
  'COPILOT_PROXY_ALLOWED_HOSTS',
  'COPILOT_PROXY_EXPOSE_TOKEN',
  'COPILOT_PROXY_MAX_JSON_BODY_BYTES',
  'COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH',
  // Platform-specific (Windows)
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]

const DAEMON_PROXY_ENV_ALLOWLIST = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
]

export function filterEnvForDaemon(
  env: Record<string, string | undefined>,
  options: { proxyEnv: boolean } = { proxyEnv: false },
): Record<string, string> {
  const filtered: Record<string, string> = {}
  const allowlist = options.proxyEnv
    ? [...DAEMON_ENV_ALLOWLIST, ...DAEMON_PROXY_ENV_ALLOWLIST]
    : DAEMON_ENV_ALLOWLIST
  const caseInsensitiveEnvironment = process.platform === 'win32'
    ? indexEnvironmentCaseInsensitively(env)
    : undefined
  for (const key of allowlist) {
    const value = env[key] ?? caseInsensitiveEnvironment?.get(key.toUpperCase())
    if (value !== undefined)
      filtered[key] = value
  }
  return filtered
}

function indexEnvironmentCaseInsensitively(
  env: Record<string, string | undefined>,
): ReadonlyMap<string, string> {
  const indexed = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !indexed.has(key.toUpperCase()))
      indexed.set(key.toUpperCase(), value)
  }
  return indexed
}

export function buildLegacySupervisorArgs(
  scriptPath: string,
  dataDir: string = PATHS.APP_DIR,
  proxyEnv = false,
): string[] {
  const args = [
    scriptPath,
    'start',
    '--_supervisor',
    '--_log-file',
    '--_data-dir',
    dataDir,
  ]
  if (proxyEnv)
    args.push('--proxy-env')
  return args
}

const LOCK_PATH = `${PATHS.DAEMON_PID}.lock`

function acquireLock(): boolean {
  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    // O_CREAT | O_EXCL — fails if file already exists (atomic)
    const fd = fs.openSync(LOCK_PATH, 'wx')
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  }
  catch {
    return false
  }
}

function releaseLock(): void {
  try {
    fs.unlinkSync(LOCK_PATH)
  }
  catch {}
}

function ensureLock(): void {
  if (acquireLock())
    return

  // Check if the lock is stale (owner process dead)
  try {
    const lockPid = Number.parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10)
    if (!Number.isNaN(lockPid) && lockPid > 0) {
      try {
        process.kill(lockPid, 0)
        // Lock holder is alive — genuine concurrent start
        consola.error('Another start operation is in progress')
        process.exit(1)
      }
      catch {
        // Lock holder is dead — stale lock, remove and retry
        releaseLock()
        if (!acquireLock()) {
          consola.error('Failed to acquire start lock')
          process.exit(1)
        }
      }
    }
    else {
      releaseLock()
      if (!acquireLock()) {
        consola.error('Failed to acquire start lock')
        process.exit(1)
      }
    }
  }
  catch {
    consola.error('Failed to acquire start lock')
    process.exit(1)
  }
}

export async function daemonStart(
  config: DaemonConfig,
  options: {
    usePersistedEnvironment?: boolean
    preparedEnvironment?: NodeJS.ProcessEnv
  } = {},
): Promise<void> {
  // Environment credentials are a one-shot launcher input. Consume them in
  // the short-lived parent before prepareDaemonEnvironment builds the
  // deliberately credential-free supervisor snapshot. This preserves the
  // foreground precedence (explicit, GH_TOKEN, then GITHUB_TOKEN) without
  // putting either provider-secret alias back into the child environment.
  const githubToken = consumeLegacyDaemonGithubToken(config.githubToken)
  const daemonConfig: DaemonConfig = {
    ...config,
    githubToken,
  }

  // Acquire lock to prevent concurrent starts.
  // ensureLock() calls process.exit() before lock is held,
  // so no cleanup needed in that path.
  ensureLock()

  // From here on, we hold the lock. Always release before exiting.
  const exitWithLock = (code: number): never => {
    releaseLock()
    process.exit(code)
    throw new Error('unreachable')
  }

  if (daemonConfig.showToken) {
    consola.error('Cannot use --show-token with daemon mode because tokens would be written to daemon logs.')
    exitWithLock(1)
  }

  let daemonEnv: NodeJS.ProcessEnv
  try {
    daemonEnv = options.preparedEnvironment
      ? { ...options.preparedEnvironment }
      : prepareDaemonEnvironment(daemonConfig, {
          usePersistedEnvironment: options.usePersistedEnvironment,
        })
    // Validate a caller-provided snapshot too. This is intentionally
    // side-effect free; persistence happens only after all preflight checks.
    buildNativeServiceEnvironment({ proxyEnv: daemonConfig.proxyEnv, sourceEnv: daemonEnv })
  }
  catch (error) {
    consola.error('Cannot prepare daemon environment:', error instanceof Error ? error.message : error)
    return exitWithLock(1)
  }

  // Check if already running
  const daemon = isDaemonRunning()
  if (daemon.running) {
    consola.error(`Daemon is already running (PID: ${daemon.pid})`)
    exitWithLock(1)
  }

  // Pre-check port availability so the user gets immediate feedback
  try {
    await checkPortAvailable(daemonConfig.port, daemonConfig.host)
  }
  catch (error) {
    if (isPortInUseError(error)) {
      consola.error(`Port ${daemonConfig.port} is already in use`)
      exitWithLock(1)
    }
    consola.error('Cannot verify daemon port availability:', error instanceof Error ? error.message : error)
    exitWithLock(1)
  }

  let tokenSnapshot: ReturnType<typeof readFileSnapshot>
  try {
    tokenSnapshot = githubToken === undefined
      ? undefined
      : readFileSnapshot(PATHS.GITHUB_TOKEN_PATH)
    persistLegacyDaemonState(daemonConfig, daemonEnv)
  }
  catch (error) {
    consola.error('Cannot persist daemon configuration:', error instanceof Error ? error.message : error)
    exitWithLock(1)
  }

  // Resolve the executable path
  let pid: number
  try {
    pid = await spawnLegacySupervisor(daemonConfig, daemonEnv)
  }
  catch (error) {
    let reportedError = error
    if (githubToken !== undefined) {
      try {
        restoreFileSnapshot(PATHS.GITHUB_TOKEN_PATH, tokenSnapshot)
      }
      catch (restoreError) {
        reportedError = new AggregateError(
          [error, restoreError],
          'Failed to start daemon process and could not restore the previous GitHub token',
        )
      }
    }
    consola.error('Failed to start daemon process:', reportedError)
    return exitWithLock(1)
  }

  consola.success(`Daemon started (PID: ${pid})`)
  consola.info(`Logs: ${PATHS.DAEMON_LOG}`)
  exitWithLock(0)
}

function consumeLegacyDaemonGithubToken(explicitToken: string | undefined): string | undefined {
  try {
    for (const candidate of [explicitToken, process.env.GH_TOKEN, process.env.GITHUB_TOKEN]) {
      const token = candidate?.trim()
      if (token)
        return token
    }
    return undefined
  }
  finally {
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
  }
}

export async function spawnLegacySupervisor(
  config: DaemonConfig,
  daemonEnv: NodeJS.ProcessEnv,
): Promise<number> {
  const execPath = process.argv[0]
  const scriptPath = process.argv[1]

  rotateDaemonLogIfNeeded()
  ensureDaemonLogFile()

  const child = spawn(execPath, buildLegacySupervisorArgs(scriptPath, PATHS.APP_DIR, config.proxyEnv), {
    detached: true,
    stdio: 'ignore',
    env: filterEnvForDaemon(daemonEnv, { proxyEnv: config.proxyEnv }),
  })
  if (child.pid === undefined)
    throw new Error('Supervisor process did not return a PID')

  let spawnError: Error | undefined
  const onSpawnError = (error: Error) => {
    spawnError = error
  }
  child.on('error', onSpawnError)

  try {
    await waitForSupervisorReadiness(
      child,
      child.pid,
      () => isSupervisorReady(config, child.pid!, daemonEnv),
      { getSpawnError: () => spawnError },
    )
    child.unref()
    return child.pid
  }
  catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM')
      }
      catch {}
    }
    removePidFileIfOwned(child.pid)
    child.unref()
    throw error
  }
  finally {
    child.off('error', onSpawnError)
  }
}

export async function waitForSupervisorReadiness(
  child: Pick<ChildProcess, 'exitCode' | 'signalCode'>,
  pid: number,
  isReady: () => boolean | Promise<boolean>,
  options: {
    timeoutMs?: number
    pollIntervalMs?: number
    requiredReadyChecks?: number
    getSpawnError?: () => Error | undefined
    delay?: (milliseconds: number) => Promise<void>
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 50
  const requiredReadyChecks = options.requiredReadyChecks ?? 2
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const deadline = Date.now() + timeoutMs
  let consecutiveReadyChecks = 0

  while (Date.now() < deadline) {
    const spawnError = options.getSpawnError?.()
    if (spawnError)
      throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Supervisor process ${pid} exited before becoming ready`)
    }

    if (await isReady()) {
      consecutiveReadyChecks++
      if (consecutiveReadyChecks >= requiredReadyChecks)
        return
    }
    else {
      consecutiveReadyChecks = 0
    }

    await delay(pollIntervalMs)
  }

  const spawnError = options.getSpawnError?.()
  if (spawnError)
    throw spawnError
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(`Supervisor process ${pid} exited before becoming ready`)
  throw new Error(`Supervisor process ${pid} did not become ready within ${timeoutMs}ms`)
}

export function prepareDaemonEnvironment(
  config: Pick<DaemonConfig, 'proxyEnv'>,
  options: { usePersistedEnvironment?: boolean } = {},
): NodeJS.ProcessEnv {
  // Build the exact child snapshot up front instead of spreading process.env.
  // On Windows, Bun can enumerate the executable search path as `Path` while
  // exposing it through process.env.PATH case-insensitively. Once spread into
  // a plain object that alias is lost. filterEnvForDaemon both canonicalizes
  // those Windows keys and prevents credentials/provider secrets from entering
  // the long-lived supervisor environment.
  const daemonEnv: NodeJS.ProcessEnv = filterEnvForDaemon(process.env, {
    proxyEnv: config.proxyEnv,
  })
  if (!options.usePersistedEnvironment) {
    buildNativeServiceEnvironment({ proxyEnv: config.proxyEnv, sourceEnv: daemonEnv })
    return daemonEnv
  }

  try {
    loadNativeServiceEnvironment({
      proxyEnv: config.proxyEnv,
      targetEnv: daemonEnv,
      filePath: PATHS.DAEMON_ENV,
    })
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error

    // Upgrade path for daemon.json files created before daemon-env.json.
    // Validate the current shell snapshot now, but persist it only after
    // daemon/port preflight succeeds.
    buildNativeServiceEnvironment({ proxyEnv: config.proxyEnv, sourceEnv: daemonEnv })
  }
  return daemonEnv
}

export function persistLegacyDaemonState(
  config: DaemonConfig,
  daemonEnv: NodeJS.ProcessEnv,
  operations: {
    saveEnvironment?: () => void
    saveConfig?: () => void
    saveToken?: (token: string) => void
  } = {},
): void {
  const configSnapshot = readFileSnapshot(PATHS.DAEMON_JSON)
  const environmentSnapshot = readFileSnapshot(PATHS.DAEMON_ENV)
  const tokenSnapshot = config.githubToken
    ? readFileSnapshot(PATHS.GITHUB_TOKEN_PATH)
    : undefined

  try {
    const saveEnvironment = operations.saveEnvironment ?? (() => {
      saveNativeServiceEnvironment({
        proxyEnv: config.proxyEnv,
        sourceEnv: daemonEnv,
        filePath: PATHS.DAEMON_ENV,
      })
    })
    const saveConfig = operations.saveConfig ?? (() => saveDaemonConfig(config))
    const saveToken = operations.saveToken
      ?? (token => writeOwnerOnlyFileAtomically(PATHS.GITHUB_TOKEN_PATH, token))
    saveEnvironment()
    saveConfig()
    if (config.githubToken)
      saveToken(config.githubToken)
  }
  catch (error) {
    const restoreErrors: unknown[] = []
    for (const [filePath, snapshot] of [
      [PATHS.DAEMON_ENV, environmentSnapshot],
      [PATHS.DAEMON_JSON, configSnapshot],
      ...(config.githubToken ? [[PATHS.GITHUB_TOKEN_PATH, tokenSnapshot] as const] : []),
    ] as const) {
      try {
        restoreFileSnapshot(filePath, snapshot)
      }
      catch (restoreError) {
        restoreErrors.push(restoreError)
      }
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError(
        [error, ...restoreErrors],
        'Failed to persist daemon state and could not fully restore the previous files',
      )
    }
    throw error
  }
}

async function isSupervisorReady(
  config: DaemonConfig,
  pid: number,
  daemonEnv: NodeJS.ProcessEnv,
): Promise<boolean> {
  const daemon = isDaemonRunning()
  if (!daemon.running || daemon.pid !== pid)
    return false

  const requestHost = resolveNativeServiceReadinessHost(config.host, daemonEnv)
  if (!requestHost)
    return false
  return await probeCopilotProxyServer(config.host, config.port, undefined, requestHost)
}

function removePidFileIfOwned(pid: number): void {
  if (readPid()?.pid === pid)
    removePidFile()
}
