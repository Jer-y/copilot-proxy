import type { ServiceConfig } from '~/daemon/config'

import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { loadLegacyServiceConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands, resolveNativeServiceReadinessHost, waitForNativeServiceReadiness } from '~/daemon/native-service'
import { loadNativeServiceEnvironment } from '~/daemon/service-env'
import { loadNativeServiceInstallState } from '~/daemon/service-install-state'
import { PATHS } from '~/lib/paths'

export const restart = defineCommand({
  meta: {
    name: 'restart',
    description: 'Restart the native background service',
  },
  async run() {
    const nativeService = await loadInstalledNativeServiceCommands()
    if (!nativeService) {
      consola.error('Native service is not installed. Run `copilot-proxy enable` first.')
      process.exit(1)
    }

    const installState = loadNativeServiceInstallState()
    let config: ServiceConfig | undefined
    try {
      config = installState?.config ?? loadLegacyServiceConfig()
    }
    catch (error) {
      consola.error('Cannot restart native service because its pre-v0.10.0 config is invalid or unreadable:', error instanceof Error ? error.message : error)
      consola.info('Run `copilot-proxy enable` from the intended environment to repair it before retrying restart.')
      process.exit(1)
    }
    if (!config) {
      consola.error('Native service control state is missing. Run `copilot-proxy enable` from the intended environment to repair it.')
      process.exit(1)
    }

    let readinessRequestHost: string
    try {
      const persistedEnvironment = loadNativeServiceEnvironment({
        proxyEnv: config.proxyEnv,
        targetEnv: { ...process.env },
        filePath: PATHS.NATIVE_SERVICE_ENV,
      })
      const resolvedReadinessHost = resolveNativeServiceReadinessHost(
        config.host,
        persistedEnvironment,
      )
      if (!resolvedReadinessHost)
        throw new Error('The persisted native-service environment has no non-loopback Host available for readiness verification.')
      readinessRequestHost = resolvedReadinessHost
    }
    catch (error) {
      consola.error('Cannot restart native service because its persisted environment is invalid:', error instanceof Error ? error.message : error)
      consola.info('Run `copilot-proxy enable` from the intended environment to repair it before retrying restart.')
      process.exit(1)
    }

    if (!nativeService.restartAutoStartService()) {
      process.exit(1)
    }

    if (!await waitForNativeServiceReadiness(config, {
      expectedInstanceToken: installState?.instanceToken,
      requestHost: readinessRequestHost,
    })) {
      consola.error(`Native service did not become ready on ${config.host}:${config.port} within the startup deadline.`)
      process.exit(1)
    }
  },
})
