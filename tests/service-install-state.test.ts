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
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-service-state-test-'))
  tempDirs.push(dir)
  return dir
}
