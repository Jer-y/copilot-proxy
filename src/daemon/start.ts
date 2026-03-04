import type { DaemonConfig } from '~/daemon/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

import consola from 'consola'
import { saveDaemonConfig } from '~/daemon/config'
import { isDaemonRunning, removePidFile, writePid } from '~/daemon/pid'
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
  'BUN_INSTALL',
  // Proxy configuration
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
  // XDG directories
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  // GitHub token (if user passes via env)
  'GH_TOKEN',
  'GITHUB_TOKEN',
  // Platform-specific (Windows)
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'SystemRoot',
  'COMSPEC',
]

export function filterEnvForDaemon(env: Record<string, string | undefined>): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const key of DAEMON_ENV_ALLOWLIST) {
    if (key in env && env[key] !== undefined) {
      filtered[key] = env[key]!
    }
  }
  return filtered
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

export async function daemonStart(config: DaemonConfig): Promise<void> {
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

  // Check if already running
  const daemon = isDaemonRunning()
  if (daemon.running) {
    consola.error(`Daemon is already running (PID: ${daemon.pid})`)
    exitWithLock(1)
  }

  // Pre-check port availability so the user gets immediate feedback
  try {
    await checkPortAvailable(config.port)
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
  const execPath = process.argv[0]
  const scriptPath = process.argv[1]

  const logStream = fs.openSync(PATHS.DAEMON_LOG, 'a', 0o600)
  // Ensure permissions are correct even if file already existed with wider perms
  try {
    fs.fchmodSync(logStream, 0o600)
  }
  catch {}

  const child = spawn(execPath, [scriptPath, 'start', '--_supervisor'], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: filterEnvForDaemon(process.env as Record<string, string | undefined>),
  })

  if (child.pid === undefined) {
    consola.error('Failed to start daemon process')
    removePidFile()
    return exitWithLock(1)
  }

  writePid(child.pid)
  child.unref()

  consola.success(`Daemon started (PID: ${child.pid})`)
  consola.info(`Logs: ${PATHS.DAEMON_LOG}`)
  exitWithLock(0)
}
