import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import {
  applyInstalledNativeServiceDataDir,
  getNativeServiceControlStatePath,
  loadNativeServiceInstallState,
  removeNativeServiceInstallState,
  saveNativeServiceInstallState,
  toNativeServiceConfig,
} from '~/daemon/service-install-state'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0))
    fs.rmSync(dir, { force: true, recursive: true })
})

describe('native service install control state', () => {
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
      manual: false,
      rateLimit: 9,
      rateLimitWait: true,
      maxConcurrency: 12,
      maxQueue: 50,
      queueTimeoutMs: 30_000,
      headersTimeoutMs: 600_000,
      bodyTimeoutMs: 900_000,
      connectTimeoutMs: 15_000,
      githubToken: 'must-not-be-persisted',
      showToken: false,
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
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('must-not-be-persisted')
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
        manual: false,
        rateLimitWait: false,
        maxQueue: 10,
        showToken: false,
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
        manual: false,
        rateLimitWait: false,
        headersTimeoutMs: MAX_TIMER_DELAY_MS + 1,
        showToken: false,
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
