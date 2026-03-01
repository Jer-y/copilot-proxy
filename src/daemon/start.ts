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
  const existingPid = readPid()
  if (existingPid !== null && isProcessRunning(existingPid)) {
    consola.error(`Daemon is already running (PID: ${existingPid})`)
    process.exit(1)
  }

  // Save config for restart/enable
  saveDaemonConfig(config)

  // Resolve the executable path
  const execPath = process.argv[0]
  const scriptPath = process.argv[1]

  const logStream = fs.openSync(PATHS.DAEMON_LOG, 'a')

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
