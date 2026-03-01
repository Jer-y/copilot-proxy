import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { isProcessRunning, readPid, removePidFile } from '~/daemon/pid'

function stopDaemon(): void {
  const pid = readPid()
  if (pid === null || !isProcessRunning(pid)) {
    consola.info('Daemon is not running')
    removePidFile()
    return
  }

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
  const poll = () => {
    if (!isProcessRunning(pid)) {
      removePidFile()
      consola.success('Daemon stopped')
      return
    }
    if (Date.now() > deadline) {
      consola.warn('Process did not exit in time, sending SIGKILL')
      try {
        process.kill(pid, 'SIGKILL')
      }
      catch {}
      removePidFile()
      consola.success('Daemon killed')
      return
    }
    setTimeout(poll, 200)
  }
  poll()
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
