import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'

import { loadLegacyServiceConfig, UNBOUNDED_NATIVE_SERVICE_CONFIG } from '~/daemon/config'
import {
  APPLIED_NATIVE_SERVICE_DATA_DIR_ENV,
  applyInstalledNativeServiceDataDir,
  getNativeServiceControlStatePath,
  loadNativeServiceInstallState,
  removeNativeServiceInstallState,
  saveNativeServiceInstallState,
  toNativeServiceConfig,
} from '~/daemon/service-install-state'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'

const tempDirs: string[] = []

if (process.platform === 'win32')
  setDefaultTimeout(15_000)

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { force: true, recursive: true })
})

describe('native service install control state', () => {
  test.each([undefined, false, true])('normalizes retired showToken=%s without rewriting either input', (showToken) => {
    const root = makeTempDir()
    const config = { ...UNBOUNDED_NATIVE_SERVICE_CONFIG, showToken }
    const legacyPath = path.join(root, 'daemon.json')
    const nativePath = path.join(root, 'control.json')
    const legacyText = JSON.stringify(config)
    const nativeText = JSON.stringify({ dataDir: root, config })
    fs.writeFileSync(legacyPath, legacyText)
    fs.writeFileSync(nativePath, nativeText)
    expect(loadLegacyServiceConfig(legacyPath)).toEqual(UNBOUNDED_NATIVE_SERVICE_CONFIG)
    const loaded = loadNativeServiceInstallState(nativePath)!
    expect(loaded.config).toEqual(UNBOUNDED_NATIVE_SERVICE_CONFIG)
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyText)
    expect(fs.readFileSync(nativePath, 'utf8')).toBe(nativeText)
    saveNativeServiceInstallState(loaded, nativePath)
    expect(fs.readFileSync(nativePath, 'utf8')).not.toContain('showToken')
  })

  test.each([
    { port: 0 },
    { port: 65536 },
    { host: '' },
    { host: 'bad/host' },
    { accountType: 'invalid' },
    { verbose: 'false' },
    { proxyEnv: 'false' },
    { rateLimitWait: 'false' },
    { rateLimit: 0 },
    { rateLimit: 86401 },
    { maxConcurrency: -1 },
    { maxQueue: -1 },
    { queueTimeoutMs: -1 },
    { headersTimeoutMs: -1 },
    { bodyTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
    { connectTimeoutMs: 1.5 },
    { showToken: 'false' },
    { showToken: null },
  ])('preserves shared rejection rules for %j', (overrides) => {
    const root = makeTempDir()
    const config = { ...UNBOUNDED_NATIVE_SERVICE_CONFIG, ...overrides }
    const legacyPath = path.join(root, 'daemon.json')
    const nativePath = path.join(root, 'control.json')
    fs.writeFileSync(legacyPath, JSON.stringify(config))
    fs.writeFileSync(nativePath, JSON.stringify({ dataDir: root, config }))
    expect(() => loadLegacyServiceConfig(legacyPath)).toThrow('service config is invalid')
    expect(() => loadNativeServiceInstallState(nativePath)).toThrow('control state is invalid')
  })

  test('defaults only the legacy host and preserves native envelope checks', () => {
    const root = makeTempDir()
    const { host: _host, ...config } = UNBOUNDED_NATIVE_SERVICE_CONFIG
    const legacyPath = path.join(root, 'daemon.json')
    fs.writeFileSync(legacyPath, JSON.stringify(config))
    expect(loadLegacyServiceConfig(legacyPath)?.host).toBe('127.0.0.1')
    const nativePath = path.join(root, 'control.json')
    for (const entry of [
      { dataDir: root, config },
      { dataDir: root, config: { ...UNBOUNDED_NATIVE_SERVICE_CONFIG, githubToken: 'sentinel' } },
      { dataDir: root, proxyEnv: true, config: UNBOUNDED_NATIVE_SERVICE_CONFIG },
    ]) {
      fs.writeFileSync(nativePath, JSON.stringify(entry))
      expect(() => loadNativeServiceInstallState(nativePath)).toThrow('control state is invalid')
    }
  })

  test('accepts legacy manual:false but omits it from newly saved state', () => {
    const root = makeTempDir()
    const filePath = path.join(root, 'control.json')
    fs.writeFileSync(filePath, JSON.stringify({
      dataDir: root,
      config: { ...UNBOUNDED_NATIVE_SERVICE_CONFIG, manual: false },
    }))

    const loaded = loadNativeServiceInstallState(filePath)!
    expect(loaded.config).toEqual(UNBOUNDED_NATIVE_SERVICE_CONFIG)
    expect(Object.hasOwn(loaded.config!, 'manual')).toBe(false)
    saveNativeServiceInstallState(loaded, filePath)
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('manual')
  })

  test.each([true, 'false', null])('rejects enabled or malformed approval in installed state (manual=%s)', (manual) => {
    const root = makeTempDir()
    const filePath = path.join(root, 'control.json')
    const contents = JSON.stringify({
      dataDir: root,
      config: { ...UNBOUNDED_NATIVE_SERVICE_CONFIG, manual },
    })
    fs.writeFileSync(filePath, contents)

    expect(() => loadNativeServiceInstallState(filePath)).toThrow(manual === true
      ? 'Manual request approval has been removed'
      : 'Native service control state is invalid')
    expect(fs.readFileSync(filePath, 'utf8')).toBe(contents)
    expect(applyInstalledNativeServiceDataDir(['disable'], {}, filePath)).toEqual({ ignoredInvalidStatePath: filePath })
  })

  test('uses a stable control path and pins control commands to the installed data dir', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    saveNativeServiceInstallState({ dataDir: '/installed/data' }, filePath)

    expect(loadNativeServiceInstallState(filePath)).toEqual({ dataDir: '/installed/data' })
    const env: NodeJS.ProcessEnv = { COPILOT_PROXY_DATA_DIR: '/different/shell/data' }
    applyInstalledNativeServiceDataDir(['disable'], env, filePath)
    expect(env.COPILOT_PROXY_DATA_DIR).toBe('/installed/data')

    removeNativeServiceInstallState(filePath)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  test('does not change unrelated commands', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    saveNativeServiceInstallState({ dataDir: '/installed/data' }, filePath)
    const env: NodeJS.ProcessEnv = { COPILOT_PROXY_DATA_DIR: '/current/data' }

    applyInstalledNativeServiceDataDir(['start'], env, filePath)
    expect(env.COPILOT_PROXY_DATA_DIR).toBe('/current/data')
  })

  test('defaults account management and auth commands to the installed service data dir', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    saveNativeServiceInstallState({ dataDir: '/installed/data' }, filePath)

    for (const args of [
      ['accounts', 'list'],
      ['accounts', 'route', 'list'],
      ['auth', '--account', 'work'],
      ['auth', '--_if-needed'],
      ['check-usage', '--account', 'work'],
      ['models', '--account', 'work'],
    ]) {
      const env: NodeJS.ProcessEnv = {}
      applyInstalledNativeServiceDataDir(args, env, filePath)
      expect(env.COPILOT_PROXY_DATA_DIR).toBe('/installed/data')
      expect(env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]).toBe(path.resolve('/installed/data'))
    }
  })

  test('preserves the applied marker across the sanitized account-command child', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    saveNativeServiceInstallState({ dataDir: '/installed/data' }, filePath)
    const env: NodeJS.ProcessEnv = {}

    applyInstalledNativeServiceDataDir(['accounts', 'list'], env, filePath)
    fs.writeFileSync(filePath, '{invalid after parent bootstrap', { mode: 0o600 })

    expect(() => applyInstalledNativeServiceDataDir(['accounts', 'list'], env, filePath)).not.toThrow()
    expect(env.COPILOT_PROXY_DATA_DIR).toBe('/installed/data')
    expect(env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]).toBe(path.resolve('/installed/data'))
  })

  test('preserves an explicit account or auth data-dir override', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    saveNativeServiceInstallState({ dataDir: '/installed/data' }, filePath)

    for (const args of [
      ['accounts', 'list'],
      ['auth', '--account', 'work'],
      ['check-usage', '--account', 'work'],
      ['models', '--account', 'work'],
    ]) {
      const env: NodeJS.ProcessEnv = {
        COPILOT_PROXY_DATA_DIR: '/explicit/data',
        [APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]: '/stale/installed/data',
      }
      applyInstalledNativeServiceDataDir(args, env, filePath)
      expect(env.COPILOT_PROXY_DATA_DIR).toBe('/explicit/data')
      expect(env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]).toBeUndefined()
    }
  })

  test('marks an explicit installed data-dir alias for legacy native-service detection', () => {
    const root = makeTempDir()
    const installedDataDir = path.join(root, 'installed')
    const aliasDataDir = path.join(root, 'installed-alias')
    const filePath = getNativeServiceControlStatePath({}, root)
    fs.mkdirSync(installedDataDir)
    fs.symlinkSync(
      installedDataDir,
      aliasDataDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    saveNativeServiceInstallState({
      dataDir: installedDataDir,
      serviceDefinitionPath: path.join(root, 'copilot-proxy.service'),
    }, filePath)
    const env: NodeJS.ProcessEnv = { COPILOT_PROXY_DATA_DIR: aliasDataDir }

    applyInstalledNativeServiceDataDir(['accounts', 'list'], env, filePath)

    expect(env.COPILOT_PROXY_DATA_DIR).toBe(aliasDataDir)
    expect(env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]).toBe(fs.realpathSync.native(installedDataDir))
    expect(env.COPILOT_PROXY_NATIVE_SERVICE_DEFINITION_PATH)
      .toBe(path.join(root, 'copilot-proxy.service'))
  })

  test('does not inspect broken installed state when account commands have an explicit override', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, '{invalid json', { mode: 0o600 })
    const env: NodeJS.ProcessEnv = {
      COPILOT_PROXY_DATA_DIR: '/explicit/data',
      [APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]: '/stale/installed/data',
    }

    expect(applyInstalledNativeServiceDataDir(['accounts', 'list'], env, filePath)).toEqual({})
    expect(env.COPILOT_PROXY_DATA_DIR).toBe('/explicit/data')
    expect(env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]).toBeUndefined()
  })

  test('pins prefixed control commands using Citty root dispatch semantics', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    saveNativeServiceInstallState({ dataDir: '/installed/data' }, filePath)

    const prefixedEnv: NodeJS.ProcessEnv = { COPILOT_PROXY_DATA_DIR: '/current/data' }
    applyInstalledNativeServiceDataDir(['-x', '--unknown=value', 'status'], prefixedEnv, filePath)
    expect(prefixedEnv.COPILOT_PROXY_DATA_DIR).toBe('/installed/data')

    const positionalEnv: NodeJS.ProcessEnv = { COPILOT_PROXY_DATA_DIR: '/current/data' }
    applyInstalledNativeServiceDataDir(['--unknown', 'value', 'status'], positionalEnv, filePath)
    expect(positionalEnv.COPILOT_PROXY_DATA_DIR).toBe('/current/data')

    const terminatedEnv: NodeJS.ProcessEnv = { COPILOT_PROXY_DATA_DIR: '/current/data' }
    applyInstalledNativeServiceDataDir(['--', 'status'], terminatedEnv, filePath)
    expect(terminatedEnv.COPILOT_PROXY_DATA_DIR).toBe('/current/data')
  })

  test('does not read installed control state for root help', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, '{invalid json', { mode: 0o600 })
    const env: NodeJS.ProcessEnv = { COPILOT_PROXY_DATA_DIR: '/current/data' }

    expect(applyInstalledNativeServiceDataDir(['--help', 'status'], env, filePath)).toEqual({})
    expect(applyInstalledNativeServiceDataDir(['status', '-h'], env, filePath)).toEqual({})
    expect(env.COPILOT_PROXY_DATA_DIR).toBe('/current/data')
  })

  test('persists the proxy-mode needed to validate native restart state', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)

    saveNativeServiceInstallState({
      dataDir: '/installed/data',
      proxyEnv: true,
    }, filePath)

    expect(loadNativeServiceInstallState(filePath)).toEqual({
      dataDir: '/installed/data',
      proxyEnv: true,
    })
  })

  test('persists a safe complete config and instance identity for restart', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    const config = toNativeServiceConfig({
      port: 4411,
      host: '127.0.0.1',
      verbose: true,
      accountType: 'enterprise',
      rateLimit: 9,
      rateLimitWait: true,
      maxConcurrency: 12,
      maxQueue: 50,
      queueTimeoutMs: 30_000,
      headersTimeoutMs: 600_000,
      bodyTimeoutMs: 900_000,
      connectTimeoutMs: 15_000,
      proxyEnv: true,
    })

    saveNativeServiceInstallState({
      dataDir: '/installed/data',
      proxyEnv: true,
      instanceToken: 'instance_token_20260713',
      config,
    }, filePath)

    expect(loadNativeServiceInstallState(filePath)).toEqual({
      dataDir: '/installed/data',
      proxyEnv: true,
      instanceToken: 'instance_token_20260713',
      config,
    })
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('githubToken')
  })

  test('rejects native service state containing a GitHub token', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, JSON.stringify({
      dataDir: '/installed/data',
      config: {
        port: 4399,
        host: '127.0.0.1',
        verbose: false,
        accountType: 'individual',
        rateLimitWait: false,
        githubToken: 'must-not-be-persisted',
        proxyEnv: false,
      },
    }))

    expect(() => loadNativeServiceInstallState(filePath)).toThrow('control state is invalid')
  })

  test('rejects native service config with queue settings but no concurrency limit', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, JSON.stringify({
      dataDir: '/installed/data',
      config: {
        port: 4399,
        host: '127.0.0.1',
        verbose: false,
        accountType: 'individual',
        rateLimitWait: false,
        maxQueue: 10,
        proxyEnv: false,
      },
    }))

    expect(() => loadNativeServiceInstallState(filePath)).toThrow('control state is invalid')
  })

  test('rejects native service timeout values above the runtime timer limit', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, JSON.stringify({
      dataDir: '/installed/data',
      config: {
        port: 4399,
        host: '127.0.0.1',
        verbose: false,
        accountType: 'individual',
        rateLimitWait: false,
        headersTimeoutMs: MAX_TIMER_DELAY_MS + 1,
        proxyEnv: false,
      },
    }))

    expect(() => loadNativeServiceInstallState(filePath)).toThrow('control state is invalid')
  })

  test('pins Linux control commands to the recorded XDG and definition paths', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    saveNativeServiceInstallState({
      dataDir: '/installed/data',
      xdgConfigHome: '/installed/config',
      serviceDefinitionPath: '/installed/config/systemd/user/copilot-proxy.service',
    }, filePath)
    const env: NodeJS.ProcessEnv = {
      XDG_CONFIG_HOME: '/different/config',
    }

    applyInstalledNativeServiceDataDir(['enable'], env, filePath)

    expect(env).toMatchObject({
      COPILOT_PROXY_DATA_DIR: '/installed/data',
      XDG_CONFIG_HOME: '/installed/config',
      COPILOT_PROXY_NATIVE_SERVICE_DEFINITION_PATH: '/installed/config/systemd/user/copilot-proxy.service',
    })
  })

  test('old Linux control state clears an ambient XDG override', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    saveNativeServiceInstallState({ dataDir: '/installed/data' }, filePath)
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: '/ambient/config' }

    applyInstalledNativeServiceDataDir(['disable'], env, filePath)

    if (process.platform === 'linux')
      expect(env.XDG_CONFIG_HOME).toBeUndefined()
  })

  test('rejects relative persisted service-definition paths', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, JSON.stringify({
      dataDir: '/installed/data',
      serviceDefinitionPath: 'relative/unit.service',
    }))

    expect(() => loadNativeServiceInstallState(filePath)).toThrow('control state is invalid')
  })

  test('rejects a relative persisted data directory', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, JSON.stringify({ dataDir: 'relative/data' }))

    expect(() => loadNativeServiceInstallState(filePath)).toThrow('control state is invalid')
  })

  test('allows disable to self-heal an invalid control-state file', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, '{invalid json', { mode: 0o600 })
    const env: NodeJS.ProcessEnv = { COPILOT_PROXY_DATA_DIR: '/current/data' }

    expect(applyInstalledNativeServiceDataDir(['disable'], env, filePath)).toEqual({
      ignoredInvalidStatePath: filePath,
    })
    expect(env.COPILOT_PROXY_DATA_DIR).toBe('/current/data')

    removeNativeServiceInstallState(filePath)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  test('gives other control commands an actionable recovery error', () => {
    const home = makeTempDir()
    const filePath = getNativeServiceControlStatePath({}, home)
    fs.writeFileSync(filePath, '{invalid json', { mode: 0o600 })

    expect(() => applyInstalledNativeServiceDataDir(['restart'], {}, filePath))
      .toThrow(/copilot-proxy disable/)
  })
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-service-state-test-'))
  tempDirs.push(dir)
  return dir
}
