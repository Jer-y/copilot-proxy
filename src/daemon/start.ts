import type { DaemonConfig } from '~/daemon/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

import consola from 'consola'
import { saveDaemonConfig } from '~/daemon/config'
import { ensureDaemonLogFile, rotateDaemonLogIfNeeded } from '~/daemon/log-file'
import { isDaemonRunning, removePidFile, writePid } from '~/daemon/pid'
import { loadNativeServiceEnvironment, saveNativeServiceEnvironment } from '~/daemon/service-env'
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
  // GitHub token (if user passes via env)
  'GH_TOKEN',
  'GITHUB_TOKEN',
  // Proxy local security configuration
  'COPILOT_PROXY_CORS_ORIGINS',
  'COPILOT_PROXY_ALLOWED_HOSTS',
  'COPILOT_PROXY_EXPOSE_TOKEN',
  'COPILOT_PROXY_MAX_JSON_BODY_BYTES',
  'COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH',
  // Platform-specific (Windows)
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SystemRoot',
  'COMSPEC',
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
  for (const key of allowlist) {
    if (key in env && env[key] !== undefined) {
      filtered[key] = env[key]!
    }
  }
  return filtered
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
  options: { usePersistedEnvironment?: boolean } = {},
): Promise<void> {
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

  if (config.showToken) {
    consola.error('Cannot use --show-token with daemon mode because tokens would be written to daemon logs.')
    exitWithLock(1)
  }

  const daemonEnv: NodeJS.ProcessEnv = { ...process.env }
  try {
    if (options.usePersistedEnvironment) {
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

        // Upgrade path for daemon.json files created before service-env.json
        // existed. Explicit proxy mode still fails closed if the current shell
        // cannot supply a proxy endpoint.
        saveNativeServiceEnvironment({
          proxyEnv: config.proxyEnv,
          sourceEnv: daemonEnv,
          filePath: PATHS.DAEMON_ENV,
        })
      }
    }
    else {
      saveNativeServiceEnvironment({
        proxyEnv: config.proxyEnv,
        sourceEnv: daemonEnv,
        filePath: PATHS.DAEMON_ENV,
      })
    }
  }
  catch (error) {
    consola.error('Cannot prepare daemon environment:', error instanceof Error ? error.message : error)
    exitWithLock(1)
  }

  // Check if already running
  const daemon = isDaemonRunning()
  if (daemon.running) {
    consola.error(`Daemon is already running (PID: ${daemon.pid})`)
    exitWithLock(1)
  }

  // Pre-check port availability so the user gets immediate feedback
  try {
    await checkPortAvailable(config.port, config.host)
  }
  catch (error) {
    if (isPortInUseError(error)) {
      consola.error(`Port ${config.port} is already in use`)
      exitWithLock(1)
    }
    throw error
  }

  // Save config for restart/enable
  saveDaemonConfig(config)

  // If a github token was provided, persist it to the token file
  // so the supervisor can use it (we don't store tokens in daemon.json)
  if (config.githubToken) {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, config.githubToken, { mode: 0o600 })
    try {
      fs.chmodSync(PATHS.GITHUB_TOKEN_PATH, 0o600)
    }
    catch {}
  }

  // Resolve the executable path
  let pid: number
  try {
    pid = await spawnLegacySupervisor(config, daemonEnv)
  }
  catch (error) {
    consola.error('Failed to start daemon process:', error)
    removePidFile()
    return exitWithLock(1)
  }

  consola.success(`Daemon started (PID: ${pid})`)
  consola.info(`Logs: ${PATHS.DAEMON_LOG}`)
  exitWithLock(0)
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

  await waitForSupervisorPid(child.pid, 2_000)
  child.unref()
  return child.pid
}

async function waitForSupervisorPid(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const daemon = isDaemonRunning()
    if (daemon.running && daemon.pid === pid) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  // Fallback for very slow starts; the supervisor will rewrite this with its
  // own stable timestamp as soon as it enters runAsSupervisor().
  writePid(pid)
}
