import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { loadInstalledNativeServiceCommands } from '~/daemon/native-service'
import { isDaemonRunning, isProcessRunning, removePidFile } from '~/daemon/pid'
import { PATHS } from '~/lib/paths'

/**
 * Attempt to stop the daemon. Returns true if daemon was stopped or
 * was not running. Returns false if the process could not be stopped.
 */
export function stopDaemon(): boolean {
  const daemon = isDaemonRunning()
  if (!daemon.running) {
    consola.info('Daemon is not running')
    removePidFile()
    return true
  }

  const { pid } = daemon
  consola.info(`Stopping daemon (PID: ${pid})...`)

  if (process.platform === 'win32') {
    requestStopViaFile(pid)
  }
  else {
    try {
      process.kill(pid, 'SIGTERM')
    }
    catch {
      consola.error('Failed to send SIGTERM')
      return false
    }
  }

  // Wait for process to exit (poll up to 10s)
  const deadline = Date.now() + 10_000
  while (isProcessRunning(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  }

  if (isProcessRunning(pid)) {
    consola.warn('Process did not exit in time, sending SIGKILL')
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {}

    // Wait briefly for SIGKILL to take effect
    const killDeadline = Date.now() + 3_000
    while (isProcessRunning(pid) && Date.now() < killDeadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }

    if (isProcessRunning(pid)) {
      consola.error(`Failed to kill process ${pid}`)
      return false
    }
  }

  removePidFile()
  consola.success('Daemon stopped')
  return true
}

function requestStopViaFile(pid: number): void {
  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(PATHS.DAEMON_STOP, `${pid}\n${Date.now()}`, { mode: 0o600 })
  }
  catch (error) {
    consola.warn('Failed to write daemon stop request file, falling back to process termination if needed:', error)
  }
}

export const stop = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the native background service or legacy daemon',
  },
  async run() {
    const nativeService = await loadInstalledNativeServiceCommands()
    if (nativeService) {
      if (!nativeService.stopAutoStartService()) {
        process.exit(1)
      }
      return
    }

    if (!stopDaemon()) {
      process.exit(1)
    }
  },
})
