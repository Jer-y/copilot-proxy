import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { isProcessRunning, readPid, removePidFile } from '~/daemon/pid'

function stopDaemon(): void {
  const info = readPid()
  if (info === null || !isProcessRunning(info.pid)) {
    consola.info('Daemon is not running')
    removePidFile()
    return
  }

  const pid = info.pid
  consola.info(`Stopping daemon (PID: ${pid})...`)

  try {
    process.kill(pid, 'SIGTERM')
  }
  catch {
    consola.error('Failed to send SIGTERM')
    return
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
  }

  removePidFile()
  consola.success('Daemon stopped')
}

export const stop = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the background daemon',
  },
  run() {
    stopDaemon()
  },
})
