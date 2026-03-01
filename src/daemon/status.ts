import { defineCommand } from 'citty'
import consola from 'consola'

import { loadDaemonConfig } from '~/daemon/config'
import { isProcessRunning, readPid } from '~/daemon/pid'

export const status = defineCommand({
  meta: {
    name: 'status',
    description: 'Show daemon status',
  },
  run() {
    const info = readPid()
    if (info === null || !isProcessRunning(info.pid)) {
      consola.info('Daemon is not running')
      return
    }

    const config = loadDaemonConfig()
    const startedAt = info.startTime > 0
      ? new Date(info.startTime).toLocaleString()
      : 'unknown'

    consola.info(`Daemon is running`)
    consola.info(`  PID:     ${info.pid}`)
    consola.info(`  Port:    ${config?.port ?? 'unknown'}`)
    consola.info(`  Started: ${startedAt}`)
  },
})
