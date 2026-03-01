import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { loadDaemonConfig } from '~/daemon/config'
import { isProcessRunning, readPid, removePidFile } from '~/daemon/pid'
import { daemonStart } from '~/daemon/start'

export const restart = defineCommand({
  meta: {
    name: 'restart',
    description: 'Restart the background daemon',
  },
  run() {
    const config = loadDaemonConfig()
    if (!config) {
      consola.error('No daemon config found. Start the daemon first with `start -d`')
      process.exit(1)
    }

    // Stop existing daemon if running
    const info = readPid()
    if (info !== null && isProcessRunning(info.pid)) {
      consola.info(`Stopping daemon (PID: ${info.pid})...`)
      try {
        process.kill(info.pid, 'SIGTERM')
      }
      catch {}

      const deadline = Date.now() + 10_000
      while (isProcessRunning(info.pid) && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
      }

      if (isProcessRunning(info.pid)) {
        try {
          process.kill(info.pid, 'SIGKILL')
        }
        catch {}
      }
      removePidFile()
    }

    // Start with saved config
    daemonStart(config)
  },
})
