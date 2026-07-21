import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { DEFAULT_SERVICE_CONFIG, loadDaemonConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands, resolveNativeServiceReadinessHost, waitForNativeServiceReadiness } from '~/daemon/native-service'
import { isDaemonRunning } from '~/daemon/pid'
import { loadNativeServiceEnvironment } from '~/daemon/service-env'
import { loadNativeServiceInstallState } from '~/daemon/service-install-state'
import { daemonStart, prepareDaemonEnvironment } from '~/daemon/start'
import { stopDaemon } from '~/daemon/stop'
import { PATHS } from '~/lib/paths'

export const restart = defineCommand({
  meta: {
    name: 'restart',
    description: 'Restart the native background service or legacy daemon',
  },
  async run() {
    const config = loadDaemonConfig()
    const nativeService = await loadInstalledNativeServiceCommands()
    if (nativeService) {
      let installState: ReturnType<typeof loadNativeServiceInstallState>
      let readinessRequestHost: string
      try {
        installState = loadNativeServiceInstallState()
        const persistedEnvironment = loadNativeServiceEnvironment({
          proxyEnv: installState?.config?.proxyEnv
            ?? installState?.proxyEnv
            ?? (config ?? DEFAULT_SERVICE_CONFIG).proxyEnv,
          targetEnv: { ...process.env },
          filePath: PATHS.NATIVE_SERVICE_ENV,
        })
        const readinessConfig = installState?.config ?? config ?? DEFAULT_SERVICE_CONFIG
        const resolvedReadinessHost = resolveNativeServiceReadinessHost(
          readinessConfig.host,
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
      const readinessConfig = installState?.config ?? config ?? DEFAULT_SERVICE_CONFIG
      if (!await waitForNativeServiceReadiness(readinessConfig, {
        expectedInstanceToken: installState?.instanceToken,
        requestHost: readinessRequestHost,
      })) {
        consola.error(`Native service did not become ready on ${readinessConfig.host}:${readinessConfig.port} within the startup deadline.`)
        process.exit(1)
      }
      return
    }

    if (!config) {
      consola.error('No daemon config found. Start the daemon first with `start -d`')
      process.exit(1)
    }

    let preparedEnvironment: NodeJS.ProcessEnv
    try {
      preparedEnvironment = prepareDaemonEnvironment(config, { usePersistedEnvironment: true })
    }
    catch (error) {
      consola.error('Cannot restart daemon because its persisted environment is invalid:', error instanceof Error ? error.message : error)
      consola.info('Run `start -d` with the intended environment to repair it; the existing daemon was left running.')
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
    await daemonStart(config, {
      usePersistedEnvironment: true,
      preparedEnvironment,
    })
  },
})
