import type { DaemonConfig } from '~/daemon/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

import consola from 'consola'
import { saveDaemonConfig } from '~/daemon/config'
import { isDaemonRunning, removePidFile, writePid } from '~/daemon/pid'
import { PATHS } from '~/lib/paths'

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

export function daemonStart(config: DaemonConfig): void {
  // Acquire lock to prevent concurrent starts
  if (!acquireLock()) {
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

  try {
    // Check if already running
    const daemon = isDaemonRunning()
    if (daemon.running) {
      consola.error(`Daemon is already running (PID: ${daemon.pid})`)
      process.exit(1)
    }

    // Save config for restart/enable
    saveDaemonConfig(config)

    // If a github token was provided, persist it to the token file
    // so the supervisor can use it (we don't store tokens in daemon.json)
    if (config.githubToken) {
      fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
      fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, config.githubToken, { mode: 0o600 })
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
      env: process.env,
    })

    if (child.pid === undefined) {
      consola.error('Failed to start daemon process')
      removePidFile()
      process.exit(1)
    }

    writePid(child.pid)
    child.unref()

    consola.success(`Daemon started (PID: ${child.pid})`)
    consola.info(`Logs: ${PATHS.DAEMON_LOG}`)
  }
  finally {
    releaseLock()
  }

  process.exit(0)
}
