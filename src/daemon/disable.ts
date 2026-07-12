import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'
import { removeNativeServiceEnvironment } from '~/daemon/service-env'
import { INVALID_NATIVE_SERVICE_CONTROL_STATE_ENV, removeNativeServiceInstallState } from '~/daemon/service-install-state'

export const disable = defineCommand({
  meta: {
    name: 'disable',
    description: 'Remove auto-start service',
  },
  async run() {
    const { platform } = process
    let success = true
    let installedDefinitionFound = false
    if (platform === 'linux') {
      const { isAutoStartInstalled, uninstallAutoStart } = await import('~/daemon/platform/linux')
      installedDefinitionFound = isAutoStartInstalled()
      success = await uninstallAutoStart()
    }
    else if (platform === 'darwin') {
      const { isAutoStartInstalled, uninstallAutoStart } = await import('~/daemon/platform/darwin')
      installedDefinitionFound = isAutoStartInstalled()
      success = await uninstallAutoStart()
    }
    else if (platform === 'win32') {
      const { isAutoStartInstalled, uninstallAutoStart } = await import('~/daemon/platform/win32')
      installedDefinitionFound = isAutoStartInstalled()
      success = await uninstallAutoStart()
    }
    else {
      consola.error(`Unsupported platform: ${platform}`)
      process.exit(1)
    }

    if (!success) {
      process.exit(1)
    }

    if (process.env[INVALID_NATIVE_SERVICE_CONTROL_STATE_ENV] === '1' && !installedDefinitionFound) {
      consola.error('Native service control state is invalid and no service definition was found at the recoverable platform path. The control-state file was preserved; repair its dataDir/XDG path or remove the actual service definition explicitly before retrying disable.')
      process.exit(1)
    }

    removeNativeServiceEnvironment()
    removeNativeServiceInstallState()
  },
})
