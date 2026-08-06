import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { loadInstalledNativeServiceCommands } from '~/daemon/native-service'

export const stop = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the native background service',
  },
  async run() {
    const nativeService = await loadInstalledNativeServiceCommands()
    if (!nativeService) {
      consola.error('Native service is not installed. Run `copilot-proxy enable` first.')
      process.exit(1)
    }

    if (!nativeService.stopAutoStartService()) {
      process.exit(1)
    }
  },
})
