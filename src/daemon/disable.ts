import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

export const disable = defineCommand({
  meta: {
    name: 'disable',
    description: 'Remove auto-start service',
  },
  async run() {
    const { platform } = process
    let success = true
    if (platform === 'linux') {
      const { uninstallAutoStart } = await import('~/daemon/platform/linux')
      success = await uninstallAutoStart()
    }
    else if (platform === 'darwin') {
      const { uninstallAutoStart } = await import('~/daemon/platform/darwin')
      success = await uninstallAutoStart()
    }
    else if (platform === 'win32') {
      const { uninstallAutoStart } = await import('~/daemon/platform/win32')
      success = await uninstallAutoStart()
    }
    else {
      consola.error(`Unsupported platform: ${platform}`)
      process.exit(1)
    }

    if (!success) {
      process.exit(1)
    }
  },
})
