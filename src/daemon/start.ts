import type { DaemonConfig } from '~/daemon/config'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'

import consola from 'consola'
import { saveDaemonConfig } from '~/daemon/config'
import { isProcessRunning, readPid, writePid } from '~/daemon/pid'
import { PATHS } from '~/lib/paths'

export function daemonStart(config: DaemonConfig): void {
  // Check if already running
  const existing = readPid()
  if (existing !== null && isProcessRunning(existing.pid)) {
    consola.error(`Daemon is already running (PID: ${existing.pid})`)
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

  const child = spawn(execPath, [scriptPath, 'start', '--_supervisor'], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: process.env,
  })

  if (child.pid === undefined) {
    consola.error('Failed to start daemon process')
    process.exit(1)
  }

  writePid(child.pid)
  child.unref()

  consola.success(`Daemon started (PID: ${child.pid})`)
  consola.info(`Logs: ${PATHS.DAEMON_LOG}`)
  process.exit(0)
}
