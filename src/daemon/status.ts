import { defineCommand } from 'citty'
import consola from 'consola'

import { loadInstalledNativeServiceCommands } from '~/daemon/native-service'

export const status = defineCommand({
  meta: {
    name: 'status',
    description: 'Show native background service status',
  },
  async run() {
    const nativeService = await loadInstalledNativeServiceCommands()
    if (!nativeService) {
      consola.info('Native service is not installed')
      return
    }

    if (!nativeService.showAutoStartStatus())
      consola.warn('Native service is installed, but its status command failed.')
  },
})
