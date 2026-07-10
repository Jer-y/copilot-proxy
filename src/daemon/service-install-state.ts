import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const CONTROL_STATE_FILE = '.copilot-proxy-native-service.json'
const NATIVE_CONTROL_COMMANDS = new Set(['stop', 'restart', 'status', 'logs', 'disable'])

export interface NativeServiceInstallState {
  dataDir: string
}

export function getNativeServiceControlStatePath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = os.userInfo().homedir,
): string {
  const controlHome = env.COPILOT_PROXY_TEST_HOME || userHome
  return path.join(controlHome, CONTROL_STATE_FILE)
}

export function loadNativeServiceInstallState(
  filePath = getNativeServiceControlStatePath(),
): NativeServiceInstallState | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof (parsed as { dataDir?: unknown }).dataDir !== 'string'
      || !(parsed as { dataDir: string }).dataDir.trim()) {
      throw new Error(`Native service control state is invalid: ${filePath}`)
    }
    return { dataDir: (parsed as { dataDir: string }).dataDir }
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

export function saveNativeServiceInstallState(
  state: NativeServiceInstallState,
  filePath = getNativeServiceControlStatePath(),
): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(temporaryPath, 0o600)
    if (process.platform === 'win32') {
      fs.copyFileSync(temporaryPath, filePath)
      fs.chmodSync(filePath, 0o600)
    }
    else {
      fs.renameSync(temporaryPath, filePath)
    }
  }
  finally {
    fs.rmSync(temporaryPath, { force: true })
  }
}

export function removeNativeServiceInstallState(
  filePath = getNativeServiceControlStatePath(),
): void {
  fs.rmSync(filePath, { force: true })
}

export function applyInstalledNativeServiceDataDir(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  filePath = getNativeServiceControlStatePath(env),
): void {
  if (!NATIVE_CONTROL_COMMANDS.has(args[0] ?? ''))
    return

  const state = loadNativeServiceInstallState(filePath)
  if (state)
    env.COPILOT_PROXY_DATA_DIR = state.dataDir
}
