import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'

const CONTROL_STATE_FILE = '.copilot-proxy-native-service.json'
const NATIVE_CONTROL_COMMANDS = new Set(['enable', 'stop', 'restart', 'status', 'logs', 'disable'])

export interface NativeServiceInstallState {
  dataDir: string
  proxyEnv?: boolean
  serviceDefinitionPath?: string
  xdgConfigHome?: string
}

export interface ApplyInstalledNativeServiceDataDirResult {
  ignoredInvalidStatePath?: string
}

export const INVALID_NATIVE_SERVICE_CONTROL_STATE_ENV = 'COPILOT_PROXY_INVALID_NATIVE_SERVICE_CONTROL_STATE'
export const NATIVE_SERVICE_DEFINITION_PATH_ENV = 'COPILOT_PROXY_NATIVE_SERVICE_DEFINITION_PATH'

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
      || !(parsed as { dataDir: string }).dataDir.trim()
      || ('proxyEnv' in parsed && typeof (parsed as { proxyEnv?: unknown }).proxyEnv !== 'boolean')
      || ('serviceDefinitionPath' in parsed
        && (typeof (parsed as { serviceDefinitionPath?: unknown }).serviceDefinitionPath !== 'string'
          || !path.isAbsolute((parsed as { serviceDefinitionPath: string }).serviceDefinitionPath)))
        || ('xdgConfigHome' in parsed
          && (typeof (parsed as { xdgConfigHome?: unknown }).xdgConfigHome !== 'string'
            || !path.isAbsolute((parsed as { xdgConfigHome: string }).xdgConfigHome)))) {
      throw new Error(`Native service control state is invalid: ${filePath}`)
    }
    const state = parsed as { dataDir: string, proxyEnv?: boolean, serviceDefinitionPath?: string, xdgConfigHome?: string }
    return {
      dataDir: state.dataDir,
      ...(state.proxyEnv !== undefined && { proxyEnv: state.proxyEnv }),
      ...(state.serviceDefinitionPath !== undefined && { serviceDefinitionPath: state.serviceDefinitionPath }),
      ...(state.xdgConfigHome !== undefined && { xdgConfigHome: state.xdgConfigHome }),
    }
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
  writeOwnerOnlyFileAtomically(filePath, `${JSON.stringify(state, null, 2)}\n`)
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
): ApplyInstalledNativeServiceDataDirResult {
  const command = args[0] ?? ''
  if (!NATIVE_CONTROL_COMMANDS.has(command))
    return {}

  let state: NativeServiceInstallState | undefined
  try {
    state = loadNativeServiceInstallState(filePath)
  }
  catch (error) {
    if (command === 'disable')
      return { ignoredInvalidStatePath: filePath }

    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${detail}. Repair or remove ${filePath}, or run \`copilot-proxy disable\` to remove the broken native-service registration safely.`,
      { cause: error },
    )
  }
  if (state) {
    env.COPILOT_PROXY_DATA_DIR = state.dataDir
    if (state.serviceDefinitionPath)
      env[NATIVE_SERVICE_DEFINITION_PATH_ENV] = state.serviceDefinitionPath
    else
      delete env[NATIVE_SERVICE_DEFINITION_PATH_ENV]
    if (state.xdgConfigHome)
      env.XDG_CONFIG_HOME = state.xdgConfigHome
    else if (process.platform === 'linux')
      delete env.XDG_CONFIG_HOME
  }
  return {}
}
