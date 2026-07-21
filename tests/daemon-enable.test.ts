import type { DaemonConfig } from '../src/daemon/config'

import { describe, expect, test } from 'bun:test'
import { parseArgs as parseCittyArgs } from 'citty'
import { buildServiceStartArgs, isEphemeralPackageRunnerPath, nativeServiceHostEnvironmentError, resolveExplicitBooleanOption, resolveLegacyDaemonRestoreConfig, resolveNativeServiceEnableConfig, resolveNativeServiceInstallLocations, rollbackEnableTransaction } from '../src/daemon/enable'
import { readinessProbeHostHeader, readinessProbeHostname, resolveNativeServiceReadinessHost, waitForNativeServiceReadiness } from '../src/daemon/native-service'
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
}

describe('buildServiceStartArgs', () => {
  test('builds minimal foreground start args', () => {
    expect(buildServiceStartArgs('/tmp/main.js', baseConfig)).toEqual([
      '/tmp/main.js',
      'start',
      '--preset',
      'custom',
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
      maxConcurrency: 12,
      maxQueue: 50,
      queueTimeoutMs: 30000,
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
      '--preset',
      'custom',
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
      '--max-concurrency',
      '12',
      '--max-queue',
      '50',
      '--queue-timeout-ms',
      '30000',
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

  test('includes the persisted service instance token', () => {
    expect(buildServiceStartArgs('/tmp/main.js', baseConfig, 'instance_token_20260713').slice(-2)).toEqual([
      '--_instance-token',
      'instance_token_20260713',
    ])
  })
})

describe('resolveNativeServiceEnableConfig', () => {
  test('uses the bounded service preset for a first native install', () => {
    expect(resolveNativeServiceEnableConfig({})).toMatchObject({
      host: '127.0.0.1',
      maxConcurrency: 4,
      maxQueue: 32,
      queueTimeoutMs: 30_000,
    })
  })

  test('preserves an older native service that has no persisted config', () => {
    expect(resolveNativeServiceEnableConfig({ existingNativeService: true })).toEqual(baseConfig)
    expect(resolveNativeServiceEnableConfig({
      existingNativeService: true,
      preset: 'service',
    })).toMatchObject({
      maxConcurrency: 4,
      maxQueue: 32,
      queueTimeoutMs: 30_000,
    })
  })

  test('prefers a recoverable v0.8 daemon config over the legacy service baseline', () => {
    const savedConfig = {
      ...baseConfig,
      maxConcurrency: 7,
      maxQueue: 9,
      queueTimeoutMs: 1234,
    }
    expect(resolveNativeServiceEnableConfig({
      existingNativeService: true,
      savedConfig,
    })).toEqual(savedConfig)
  })

  test('reuses the installed native config when no legacy config exists', () => {
    expect(resolveNativeServiceEnableConfig({
      installedConfig: {
        ...baseConfig,
        host: '172.17.0.1',
        accountType: 'enterprise',
        maxConcurrency: 12,
        maxQueue: 24,
        queueTimeoutMs: 5000,
      },
    })).toEqual({
      ...baseConfig,
      host: '172.17.0.1',
      accountType: 'enterprise',
      maxConcurrency: 12,
      maxQueue: 24,
      queueTimeoutMs: 5000,
    })
  })

  test('uses the installed native config ahead of stale legacy config after migration', () => {
    expect(resolveNativeServiceEnableConfig({
      savedConfig: { ...baseConfig, host: '127.0.0.2' },
      installedConfig: {
        ...baseConfig,
        host: '172.17.0.1',
        maxConcurrency: 12,
      },
    })).toEqual({
      ...baseConfig,
      host: '172.17.0.1',
      maxConcurrency: 12,
    })
  })

  test('applies explicit concurrency overrides and supports clearing them', () => {
    const installedConfig = {
      ...baseConfig,
      maxConcurrency: 12,
      maxQueue: 24,
      queueTimeoutMs: 5000,
    }
    expect(resolveNativeServiceEnableConfig({
      installedConfig,
      maxConcurrency: '8',
      maxQueue: '16',
      queueTimeoutMs: '2500',
    })).toMatchObject({
      maxConcurrency: 8,
      maxQueue: 16,
      queueTimeoutMs: 2500,
    })
    expect(resolveNativeServiceEnableConfig({
      installedConfig,
      clearConcurrencyLimit: true,
    })).toEqual(baseConfig)
  })

  test('does not restore stale legacy concurrency settings on a later enable', () => {
    const staleLegacyConfig = {
      ...baseConfig,
      maxConcurrency: 12,
      maxQueue: 24,
      queueTimeoutMs: 5000,
    }
    const clearedConfig = resolveNativeServiceEnableConfig({
      savedConfig: staleLegacyConfig,
      installedConfig: staleLegacyConfig,
      clearConcurrencyLimit: true,
    })
    expect(resolveNativeServiceEnableConfig({
      savedConfig: staleLegacyConfig,
      installedConfig: clearedConfig,
    })).toEqual(baseConfig)

    const overriddenConfig = resolveNativeServiceEnableConfig({
      savedConfig: staleLegacyConfig,
      installedConfig: baseConfig,
      maxConcurrency: '8',
      maxQueue: '16',
      queueTimeoutMs: '2500',
    })
    expect(resolveNativeServiceEnableConfig({
      savedConfig: staleLegacyConfig,
      installedConfig: overriddenConfig,
    })).toMatchObject({
      maxConcurrency: 8,
      maxQueue: 16,
      queueTimeoutMs: 2500,
    })
  })

  test('applies named safe presets before explicit overrides', () => {
    expect(resolveNativeServiceEnableConfig({ preset: 'gateway-upstream' })).toMatchObject({
      host: '0.0.0.0',
      maxConcurrency: 4,
      maxQueue: 50,
      queueTimeoutMs: 30_000,
    })
    expect(resolveNativeServiceEnableConfig({
      preset: 'personal',
      maxConcurrency: '3',
    })).toMatchObject({
      host: '127.0.0.1',
      maxConcurrency: 3,
      maxQueue: 8,
    })
    expect(resolveNativeServiceEnableConfig({ preset: 'custom' })).toEqual(baseConfig)
  })

  test('persists explicit fresh-install identity, listener, and proxy settings', () => {
    expect(resolveNativeServiceEnableConfig({
      accountType: 'enterprise',
      host: '10.0.0.8',
      port: '4411',
      proxyEnv: true,
      preset: 'service',
    })).toMatchObject({
      accountType: 'enterprise',
      host: '10.0.0.8',
      port: 4411,
      proxyEnv: true,
      maxConcurrency: 4,
      maxQueue: 32,
    })

    expect(resolveNativeServiceEnableConfig({
      installedConfig: {
        ...baseConfig,
        accountType: 'business',
        port: 4400,
        proxyEnv: true,
      },
      proxyEnv: false,
    })).toMatchObject({
      accountType: 'business',
      port: 4400,
      proxyEnv: false,
    })
  })

  test('persists every non-interactive service runtime option without a legacy daemon', () => {
    expect(resolveNativeServiceEnableConfig({
      bodyTimeoutMs: '910000',
      connectTimeoutMs: '45000',
      headersTimeoutMs: '920000',
      rateLimit: '7',
      rateLimitWait: true,
      verbose: true,
    })).toMatchObject({
      bodyTimeoutMs: 910000,
      connectTimeoutMs: 45000,
      headersTimeoutMs: 920000,
      rateLimit: 7,
      rateLimitWait: true,
      verbose: true,
    })

    expect(resolveNativeServiceEnableConfig({
      installedConfig: {
        ...baseConfig,
        bodyTimeoutMs: 910000,
        connectTimeoutMs: 45000,
        headersTimeoutMs: 920000,
        rateLimit: 7,
        rateLimitWait: true,
        verbose: true,
      },
      clearRateLimit: true,
      clearTimeoutOverrides: true,
      rateLimitWait: undefined,
      verbose: false,
    })).toEqual({
      ...baseConfig,
      verbose: false,
    })
  })

  test('rejects invalid and conflicting concurrency overrides', () => {
    expect(() => resolveNativeServiceEnableConfig({ maxConcurrency: '0' })).toThrow('--max-concurrency')
    expect(resolveNativeServiceEnableConfig({ maxQueue: '1' })).toMatchObject({
      maxConcurrency: 4,
      maxQueue: 1,
    })
    expect(() => resolveNativeServiceEnableConfig({ preset: 'custom', maxQueue: '1' })).toThrow('require maxConcurrency')
    expect(() => resolveNativeServiceEnableConfig({
      maxConcurrency: '4',
      clearConcurrencyLimit: true,
    })).toThrow('cannot be combined')
    expect(() => resolveNativeServiceEnableConfig({
      preset: 'service',
      clearConcurrencyLimit: true,
    })).toThrow('cannot be combined')
  })

  test('rejects invalid fresh-install identity and listener overrides', () => {
    expect(() => resolveNativeServiceEnableConfig({ accountType: 'organization' })).toThrow('--account-type')
    expect(() => resolveNativeServiceEnableConfig({ host: 'https://proxy.internal/path' })).toThrow('--host')
    expect(() => resolveNativeServiceEnableConfig({ port: '0' })).toThrow('--port')
    expect(() => resolveNativeServiceEnableConfig({ port: '04400' })).toThrow('--port')
    expect(() => resolveNativeServiceEnableConfig({ rateLimit: '0' })).toThrow('--rate-limit')
    expect(() => resolveNativeServiceEnableConfig({ headersTimeoutMs: '-1' })).toThrow('--headers-timeout-ms')
    expect(() => resolveNativeServiceEnableConfig({ bodyTimeoutMs: '1.5' })).toThrow('--body-timeout-ms')
    expect(() => resolveNativeServiceEnableConfig({ connectTimeoutMs: '999999999999' })).toThrow('--connect-timeout-ms')
    expect(() => resolveNativeServiceEnableConfig({
      clearRateLimit: true,
      rateLimitWait: false,
    })).toThrow('cannot be combined')
    expect(() => resolveNativeServiceEnableConfig({
      clearTimeoutOverrides: true,
      connectTimeoutMs: '1000',
    })).toThrow('cannot be combined')
  })
})

describe('enable boolean CLI overrides', () => {
  test('uses Citty values while preserving omission for installed config reuse', () => {
    expect(resolveExplicitBooleanOption([], 'proxy-env')).toBeUndefined()

    const cases: Array<{
      label: string
      name: 'proxy-env' | 'verbose' | 'wait'
      rawArgs: string[]
      shortName?: 'v' | 'w'
    }> = [
      { label: 'bare long', name: 'proxy-env', rawArgs: ['--proxy-env'] },
      { label: 'long true', name: 'proxy-env', rawArgs: ['--proxy-env=true'] },
      { label: 'long false', name: 'proxy-env', rawArgs: ['--proxy-env=false'] },
      { label: 'long numeric one', name: 'proxy-env', rawArgs: ['--proxy-env=1'] },
      { label: 'long numeric zero', name: 'proxy-env', rawArgs: ['--proxy-env=0'] },
      { label: 'camel-case long alias', name: 'proxy-env', rawArgs: ['--proxyEnv=1'] },
      { label: 'camel-case true overrides primary default value', name: 'proxy-env', rawArgs: ['--proxyEnv', '--proxy-env=false'] },
      { label: 'later long true wins', name: 'proxy-env', rawArgs: ['--proxy-env=false', '--proxy-env=true'] },
      { label: 'later long false wins', name: 'proxy-env', rawArgs: ['--proxy-env=true', '--proxy-env=false'] },
      { label: 'negative long', name: 'proxy-env', rawArgs: ['--no-proxy-env'] },
      { label: 'long wait false', name: 'wait', rawArgs: ['--wait=false'], shortName: 'w' },
      { label: 'long wait numeric one', name: 'wait', rawArgs: ['--wait=1'], shortName: 'w' },
      { label: 'long wait numeric zero', name: 'wait', rawArgs: ['--wait=0'], shortName: 'w' },
      { label: 'bare short', name: 'wait', rawArgs: ['-w'], shortName: 'w' },
      { label: 'short equals false remains true', name: 'wait', rawArgs: ['-w=false'], shortName: 'w' },
      { label: 'short boolean cluster', name: 'wait', rawArgs: ['-vw'], shortName: 'w' },
      { label: 'short target before string option', name: 'wait', rawArgs: ['-wp'], shortName: 'w' },
      { label: 'string option shields short target text', name: 'wait', rawArgs: ['-pw'], shortName: 'w' },
      { label: 'string option consumes long target', name: 'wait', rawArgs: ['--port', '--wait'], shortName: 'w' },
      { label: 'consumed delimiter leaves target active', name: 'wait', rawArgs: ['--port', '--', '--wait'], shortName: 'w' },
      { label: 'standalone delimiter stops target parsing', name: 'wait', rawArgs: ['--', '--wait'], shortName: 'w' },
    ]

    for (const { label, name, rawArgs, shortName } of cases) {
      const cittyArgs = parseCittyArgs(rawArgs, {
        'port': { type: 'string', alias: 'p' },
        'proxy-env': { type: 'boolean', default: false },
        'verbose': { type: 'boolean', alias: 'v', default: false },
        'wait': { type: 'boolean', alias: 'w', default: false },
      })
      expect({
        label,
        value: resolveExplicitBooleanOption(rawArgs, name, shortName) ?? false,
      }).toEqual({
        label,
        value: Boolean(cittyArgs[name]),
      })
    }
  })

  test('applies Citty equals values instead of silently preserving installed booleans', () => {
    const installedConfig = {
      ...baseConfig,
      proxyEnv: false,
      rateLimitWait: false,
    }
    expect(resolveNativeServiceEnableConfig({
      installedConfig,
      proxyEnv: resolveExplicitBooleanOption(['--proxy-env=1'], 'proxy-env'),
      rateLimitWait: resolveExplicitBooleanOption(['--wait=1'], 'wait', 'w'),
    })).toMatchObject({
      proxyEnv: true,
      rateLimitWait: true,
    })
  })

  test('rejects contradictory positive and negative forms', () => {
    expect(() => resolveExplicitBooleanOption([
      '--proxy-env',
      '--no-proxy-env',
    ], 'proxy-env')).toThrow('cannot be combined')
    expect(() => resolveExplicitBooleanOption([
      '-v',
      '--no-verbose',
    ], 'verbose', 'v')).toThrow('cannot be combined')
  })

  test('lets the later repeated positive value win without treating it as a negated flag conflict', () => {
    expect(resolveExplicitBooleanOption([
      '--proxy-env',
      '--proxy-env=false',
    ], 'proxy-env')).toBe(false)
    expect(resolveExplicitBooleanOption([
      '--proxy-env=false',
      '--proxy-env=1',
    ], 'proxy-env')).toBe(true)
    expect(resolveExplicitBooleanOption([
      '--proxy-env=false',
      '--no-proxy-env',
    ], 'proxy-env')).toBe(false)
  })
})

describe('nativeServiceHostEnvironmentError', () => {
  test('requires a valid exact non-loopback Host allowlist only for non-loopback listeners', () => {
    expect(nativeServiceHostEnvironmentError('127.0.0.1', {})).toBeUndefined()
    expect(nativeServiceHostEnvironmentError('::1', {
      COPILOT_PROXY_ALLOWED_HOSTS: 'localhost',
    })).toBeUndefined()
    expect(nativeServiceHostEnvironmentError('0.0.0.0', {
      COPILOT_PROXY_ALLOWED_HOSTS: 'localhost,proxy.internal,192.0.2.10,[2001:db8::1]',
    })).toBeUndefined()

    for (const loopbackOnlyOrMalformed of [
      'localhost',
      'foo.localhost',
      '127.0.0.1',
      '[::1]',
      ',',
      'https://proxy.internal',
      'proxy.internal:443',
      '*.internal',
    ]) {
      expect(nativeServiceHostEnvironmentError('0.0.0.0', {
        COPILOT_PROXY_ALLOWED_HOSTS: loopbackOnlyOrMalformed,
      })).toContain('at least one non-loopback hostname or IP address')
    }
  })
})

describe('resolveLegacyDaemonRestoreConfig', () => {
  test('snapshots the pre-migration config and refuses to stop an unconfigured daemon', () => {
    const savedConfig = {
      ...baseConfig,
      host: '192.168.1.10',
      maxConcurrency: 7,
    }
    const restoreConfig = resolveLegacyDaemonRestoreConfig(true, savedConfig)

    expect(restoreConfig).toEqual(savedConfig)
    expect(restoreConfig).not.toBe(savedConfig)
    expect(resolveLegacyDaemonRestoreConfig(false, savedConfig)).toBeUndefined()
    expect(() => resolveLegacyDaemonRestoreConfig(true, null)).toThrow('persisted daemon config is missing or invalid')
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
  test('restores the real previous activation state even without v0.8 install metadata', async () => {
    const calls: string[] = []
    const previousState = {
      installed: true,
      enabled: true,
      running: true,
    }

    expect(await rollbackEnableTransaction(previousState, {
      restorePreviousPersistedState: () => {
        calls.push('persisted:previous')
        return true
      },
      restoreReplacementPersistedState: () => {
        calls.push('persisted:replacement')
        return true
      },
      rollbackPlatformDefinition: () => {
        calls.push('platform')
        return true
      },
      restorePreviousAutoStartState: (state) => {
        calls.push(`activation:${state.enabled}:${state.running}`)
        return true
      },
    })).toBe(true)
    expect(calls).toEqual([
      'platform',
      'persisted:previous',
      'activation:true:true',
    ])
  })

  test('restores a stopped legacy daemon with its pre-migration host', async () => {
    const previousConfig = {
      ...baseConfig,
      host: '192.168.1.10',
      maxConcurrency: 7,
      maxQueue: 9,
      queueTimeoutMs: 1234,
    }
    const replacementConfig = resolveNativeServiceEnableConfig({
      savedConfig: previousConfig,
      preset: 'service',
    })
    const legacyRestoreConfig = resolveLegacyDaemonRestoreConfig(true, previousConfig)
    const restoredConfigs: DaemonConfig[] = []

    expect(replacementConfig.host).toBe('127.0.0.1')
    expect(await rollbackEnableTransaction({ installed: false, enabled: false, running: false }, {
      restorePreviousPersistedState: () => true,
      restoreReplacementPersistedState: () => true,
      rollbackPlatformDefinition: () => true,
      restorePreviousAutoStartState: () => true,
      restoreLegacyDaemon: (config) => {
        restoredConfigs.push(config)
        return true
      },
    }, legacyRestoreConfig)).toBe(true)
    expect(restoredConfigs).toEqual([previousConfig])
    expect(restoredConfigs[0]?.host).toBe('192.168.1.10')
  })

  test('restores replacement metadata when the platform definition rollback fails', async () => {
    const calls: string[] = []

    expect(await rollbackEnableTransaction({ installed: true, enabled: false, running: false }, {
      restorePreviousPersistedState: () => {
        calls.push('persisted:previous')
        return true
      },
      restoreReplacementPersistedState: () => {
        calls.push('persisted:replacement')
        return true
      },
      rollbackPlatformDefinition: () => {
        calls.push('platform')
        return false
      },
      restorePreviousAutoStartState: () => {
        calls.push('activation')
        return true
      },
    })).toBe(false)
    expect(calls).toEqual([
      'platform',
      'persisted:replacement',
    ])
  })

  test('keeps previous metadata ownership when its restore fails after definition rollback', async () => {
    const calls: string[] = []
    expect(await rollbackEnableTransaction({ installed: true, enabled: true, running: false }, {
      restorePreviousPersistedState: () => {
        calls.push('persisted:previous')
        return false
      },
      restoreReplacementPersistedState: () => {
        calls.push('persisted:replacement')
        return true
      },
      rollbackPlatformDefinition: () => {
        calls.push('platform')
        return true
      },
      restorePreviousAutoStartState: () => {
        calls.push('activation')
        return true
      },
    })).toBe(false)
    expect(calls).toEqual(['platform', 'persisted:previous'])
  })

  test('reports an incomplete rollback when previous activation cannot be restored', async () => {
    expect(await rollbackEnableTransaction({ installed: true, enabled: true, running: true }, {
      restorePreviousPersistedState: () => true,
      restoreReplacementPersistedState: () => true,
      rollbackPlatformDefinition: () => true,
      restorePreviousAutoStartState: () => false,
    })).toBe(false)
  })

  test('contains a thrown activation restore and reports the rollback incomplete', async () => {
    expect(await rollbackEnableTransaction({ installed: true, enabled: true, running: true }, {
      restorePreviousPersistedState: () => true,
      restoreReplacementPersistedState: () => true,
      rollbackPlatformDefinition: () => true,
      restorePreviousAutoStartState: () => { throw new Error('restore failed') },
    })).toBe(false)
  })
})

describe('native service readiness', () => {
  test('selects a persisted non-loopback Host for non-loopback listeners', () => {
    expect(resolveNativeServiceReadinessHost('127.0.0.1', {})).toBe('localhost')
    expect(resolveNativeServiceReadinessHost('0.0.0.0', {
      COPILOT_PROXY_ALLOWED_HOSTS: 'localhost,proxy.internal,192.0.2.10',
    })).toBe('proxy.internal')
    expect(resolveNativeServiceReadinessHost('172.17.0.1', {
      COPILOT_PROXY_ALLOWED_HOSTS: 'localhost',
    })).toBeUndefined()
  })

  test('formats IPv4, DNS, and IPv6 readiness Host authorities', () => {
    expect(readinessProbeHostHeader('proxy.internal', 4399)).toBe('proxy.internal:4399')
    expect(readinessProbeHostHeader('192.0.2.10', 4399)).toBe('192.0.2.10:4399')
    expect(readinessProbeHostHeader('2001:db8::1', 4399)).toBe('[2001:db8::1]:4399')
    expect(readinessProbeHostHeader('[2001:db8::1]', 4399)).toBe('[2001:db8::1]:4399')
  })

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
