import type { DaemonConfig } from '../src/daemon/config'

import { describe, expect, test } from 'bun:test'
import { buildServiceStartArgs, isEphemeralPackageRunnerPath, resolveNativeServiceInstallLocations, rollbackEnableStateAfterFailure } from '../src/daemon/enable'
import { readinessProbeHostname, waitForNativeServiceReadiness } from '../src/daemon/native-service'
import { PATHS } from '../src/lib/paths'

const baseConfig: DaemonConfig = {
  port: 4399,
  host: '127.0.0.1',
  verbose: false,
  accountType: 'individual',
  manual: false,
  rateLimitWait: false,
  showToken: false,
  proxyEnv: false,
  normalizeOpenAIResponsesItemIds: false,
}

describe('buildServiceStartArgs', () => {
  test('builds minimal foreground start args', () => {
    expect(buildServiceStartArgs('/tmp/main.js', baseConfig)).toEqual([
      '/tmp/main.js',
      'start',
      '--port',
      '4399',
      '--host',
      '127.0.0.1',
      '--account-type',
      'individual',
      '--_service',
      '--_data-dir',
      PATHS.APP_DIR,
    ])
  })

  test('includes optional switches and never includes github token or show-token', () => {
    const config: DaemonConfig = {
      ...baseConfig,
      port: 4411,
      host: '0.0.0.0',
      accountType: 'enterprise',
      verbose: true,
      manual: true,
      rateLimit: 9,
      rateLimitWait: true,
      headersTimeoutMs: 600000,
      bodyTimeoutMs: 900000,
      connectTimeoutMs: 15000,
      showToken: true,
      proxyEnv: true,
      githubToken: 'ghu_secret_should_not_be_in_args',
    }

    const args = buildServiceStartArgs('/tmp/main.js', config)
    expect(args).toEqual([
      '/tmp/main.js',
      'start',
      '--port',
      '4411',
      '--host',
      '0.0.0.0',
      '--account-type',
      'enterprise',
      '--_service',
      '--_data-dir',
      PATHS.APP_DIR,
      '--verbose',
      '--manual',
      '--rate-limit',
      '9',
      '--wait',
      '--headers-timeout-ms',
      '600000',
      '--body-timeout-ms',
      '900000',
      '--connect-timeout-ms',
      '15000',
      '--proxy-env',
    ])
    expect(args).not.toContain('--github-token')
    expect(args).not.toContain(config.githubToken!)
    expect(args).not.toContain('--show-token')
    expect(args).not.toContain('--_supervisor')
  })

  test('emits --normalize-openai-responses-item-ids when enabled', () => {
    const args = buildServiceStartArgs('/tmp/main.js', {
      ...baseConfig,
      normalizeOpenAIResponsesItemIds: true,
    })
    expect(args).toContain('--normalize-openai-responses-item-ids')
  })

  test('omits --normalize-openai-responses-item-ids when disabled', () => {
    const args = buildServiceStartArgs('/tmp/main.js', baseConfig)
    expect(args).not.toContain('--normalize-openai-responses-item-ids')
  })
})

describe('isEphemeralPackageRunnerPath', () => {
  test('detects common npx and dlx cache paths', () => {
    expect(isEphemeralPackageRunnerPath('/home/alice/.npm/_npx/abc/node_modules/@jer-y/copilot-proxy/dist/main.js')).toBe(true)
    expect(isEphemeralPackageRunnerPath('C:\\Users\\alice\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\@jer-y\\copilot-proxy\\dist\\main.js')).toBe(true)
    expect(isEphemeralPackageRunnerPath('/home/alice/.cache/pnpm/dlx/abc/node_modules/@jer-y/copilot-proxy/dist/main.js')).toBe(true)
    expect(isEphemeralPackageRunnerPath('/tmp/xfs-123/dlx-456/node_modules/@jer-y/copilot-proxy/dist/main.js')).toBe(true)
    expect(isEphemeralPackageRunnerPath('/tmp/bunx-123/node_modules/@jer-y/copilot-proxy/dist/main.js')).toBe(true)
    expect(isEphemeralPackageRunnerPath('/home/alice/.bun/install/cache/@jer-y/copilot-proxy@latest/node_modules/@jer-y/copilot-proxy/dist/main.js')).toBe(true)
  })

  test('allows stable global and source-checkout paths', () => {
    expect(isEphemeralPackageRunnerPath('/usr/local/lib/node_modules/@jer-y/copilot-proxy/dist/main.js')).toBe(false)
    expect(isEphemeralPackageRunnerPath('/home/alice/src/copilot-proxy/src/main.ts')).toBe(false)
  })
})

describe('native service install locations', () => {
  test('resolves Linux default and explicit XDG paths', () => {
    expect(resolveNativeServiceInstallLocations('linux', {}, '/home/alice')).toEqual({
      xdgConfigHome: '/home/alice/.config',
      serviceDefinitionPath: '/home/alice/.config/systemd/user/copilot-proxy.service',
    })
    expect(resolveNativeServiceInstallLocations('linux', {
      XDG_CONFIG_HOME: '/srv/config',
    }, '/home/alice')).toEqual({
      xdgConfigHome: '/srv/config',
      serviceDefinitionPath: '/srv/config/systemd/user/copilot-proxy.service',
    })
  })

  test('preserves a recorded definition path across shell home changes', () => {
    expect(resolveNativeServiceInstallLocations('darwin', {
      COPILOT_PROXY_NATIVE_SERVICE_DEFINITION_PATH: '/old/LaunchAgents/com.copilot-proxy.plist',
    }, '/new/home')).toEqual({
      serviceDefinitionPath: '/old/LaunchAgents/com.copilot-proxy.plist',
    })
  })
})

describe('enable transaction rollback', () => {
  test('restores persisted state only after the platform rollback succeeds', async () => {
    const calls: string[] = []

    expect(await rollbackEnableStateAfterFailure(
      () => {
        calls.push('platform')
        return true
      },
      () => { calls.push('persisted') },
    )).toBe(true)
    expect(calls).toEqual(['platform', 'persisted'])
  })

  test('keeps control state when the platform rollback fails', async () => {
    let restoreCalls = 0

    expect(await rollbackEnableStateAfterFailure(
      () => false,
      () => { restoreCalls++ },
    )).toBe(false)
    expect(restoreCalls).toBe(0)
  })
})

describe('native service readiness', () => {
  test('requires consecutive identity probes before reporting ready', async () => {
    let now = 0
    const outcomes = [true, false, true, true]

    expect(await waitForNativeServiceReadiness(baseConfig, {
      timeoutMs: 100,
      pollIntervalMs: 1,
      probe: () => outcomes.shift() ?? false,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds },
    })).toBe(true)
  })

  test('fails when the proxy identity never becomes ready', async () => {
    let now = 0
    expect(await waitForNativeServiceReadiness(baseConfig, {
      timeoutMs: 3,
      pollIntervalMs: 1,
      probe: () => false,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds },
    })).toBe(false)
  })

  test('maps wildcard listeners to loopback probe hosts', () => {
    expect(readinessProbeHostname('0.0.0.0')).toBe('127.0.0.1')
    expect(readinessProbeHostname('[::]')).toBe('::1')
    expect(readinessProbeHostname('192.0.2.10')).toBe('192.0.2.10')
  })
})
