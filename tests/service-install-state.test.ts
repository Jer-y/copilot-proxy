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
} from '~/daemon/service-install-state'

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
