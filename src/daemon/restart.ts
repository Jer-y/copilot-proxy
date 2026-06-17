import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { loadDaemonConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands } from '~/daemon/native-service'
import { isDaemonRunning } from '~/daemon/pid'
import { daemonStart } from '~/daemon/start'
import { stopDaemon } from '~/daemon/stop'

export const restart = defineCommand({
  meta: {
    name: 'restart',
    description: 'Restart the native background service or legacy daemon',
  },
  async run() {
    const nativeService = await loadInstalledNativeServiceCommands()
    if (nativeService) {
      if (!nativeService.restartAutoStartService()) {
        process.exit(1)
      }
      return
    }

    const config = loadDaemonConfig()
    if (!config) {
      consola.error('No daemon config found. Start the daemon first with `start -d`')
      process.exit(1)
    }

    // Stop existing daemon if running
    const daemon = isDaemonRunning()
    if (daemon.running) {
      if (!stopDaemon()) {
        consola.error('Cannot restart: failed to stop existing daemon')
        process.exit(1)
      }
    }

    // Start with saved config
    await daemonStart(config)
  },
})
