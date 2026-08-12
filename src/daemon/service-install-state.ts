import type { ServiceConfig } from '~/daemon/config'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'
import { findCittyRootCommand, hasCittyRootHelpFlag } from '~/lib/citty-argv'
import { resolveConcurrencyLimitConfig } from '~/lib/concurrency-limiter'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'

const CONTROL_STATE_FILE = '.copilot-proxy-native-service.json'
const NATIVE_CONTROL_COMMANDS = new Set([
  'disable',
  'enable',
  'logs',
  'restart',
  'status',
  'stop',
])
const INSTALLED_DATA_DIR_DEFAULT_COMMANDS = new Set([
  'accounts',
  'auth',
  'check-usage',
  'models',
])

export interface NativeServiceInstallState {
  dataDir: string
  proxyEnv?: boolean
  instanceToken?: string
  config?: NativeServiceConfig
  serviceDefinitionPath?: string
  xdgConfigHome?: string
}

export type NativeServiceConfig = ServiceConfig

export interface ApplyInstalledNativeServiceDataDirResult {
  ignoredInvalidStatePath?: string
}

export const INVALID_NATIVE_SERVICE_CONTROL_STATE_ENV = 'COPILOT_PROXY_INVALID_NATIVE_SERVICE_CONTROL_STATE'
export const APPLIED_NATIVE_SERVICE_DATA_DIR_ENV = 'COPILOT_PROXY_APPLIED_NATIVE_SERVICE_DATA_DIR'
export const NATIVE_SERVICE_DEFINITION_PATH_ENV = 'COPILOT_PROXY_NATIVE_SERVICE_DEFINITION_PATH'
const INSTANCE_TOKEN_PATTERN = /^[\w-]{16,128}$/

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
    return validateNativeServiceInstallState(parsed, filePath)
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
  const validated = validateNativeServiceInstallState(state, filePath)
  writeOwnerOnlyFileAtomically(filePath, `${JSON.stringify(validated, null, 2)}\n`)
}

export function removeNativeServiceInstallState(
  filePath = getNativeServiceControlStatePath(),
): void {
  fs.rmSync(filePath, { force: true })
}

export function toNativeServiceConfig(config: ServiceConfig): NativeServiceConfig {
  return {
    port: config.port,
    host: config.host,
    verbose: config.verbose,
    accountType: config.accountType,
    manual: config.manual,
    ...(config.rateLimit !== undefined && { rateLimit: config.rateLimit }),
    rateLimitWait: config.rateLimitWait,
    ...(config.maxConcurrency !== undefined && { maxConcurrency: config.maxConcurrency }),
    ...(config.maxQueue !== undefined && { maxQueue: config.maxQueue }),
    ...(config.queueTimeoutMs !== undefined && { queueTimeoutMs: config.queueTimeoutMs }),
    ...(config.headersTimeoutMs !== undefined && { headersTimeoutMs: config.headersTimeoutMs }),
    ...(config.bodyTimeoutMs !== undefined && { bodyTimeoutMs: config.bodyTimeoutMs }),
    ...(config.connectTimeoutMs !== undefined && { connectTimeoutMs: config.connectTimeoutMs }),
    showToken: config.showToken,
    proxyEnv: config.proxyEnv,
  }
}

function validateNativeServiceInstallState(
  value: unknown,
  filePath: string,
): NativeServiceInstallState {
  const invalid = () => new Error(`Native service control state is invalid: ${filePath}`)
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid()

  const state = value as Record<string, unknown>
  if (typeof state.dataDir !== 'string' || !path.isAbsolute(state.dataDir))
    throw invalid()
  if (state.proxyEnv !== undefined && typeof state.proxyEnv !== 'boolean')
    throw invalid()
  if (state.instanceToken !== undefined
    && (typeof state.instanceToken !== 'string' || !INSTANCE_TOKEN_PATTERN.test(state.instanceToken))) {
    throw invalid()
  }
  if (state.serviceDefinitionPath !== undefined
    && (typeof state.serviceDefinitionPath !== 'string' || !path.isAbsolute(state.serviceDefinitionPath))) {
    throw invalid()
  }
  if (state.xdgConfigHome !== undefined
    && (typeof state.xdgConfigHome !== 'string' || !path.isAbsolute(state.xdgConfigHome))) {
    throw invalid()
  }

  let config: NativeServiceConfig | undefined
  if (state.config !== undefined) {
    if (!state.config || typeof state.config !== 'object' || Array.isArray(state.config)
      || 'githubToken' in state.config) {
      throw invalid()
    }
    const validatedConfig = validateNativeServiceConfig(state.config as Record<string, unknown>)
    if (!validatedConfig)
      throw invalid()
    config = validatedConfig
    if (state.proxyEnv !== undefined && state.proxyEnv !== config.proxyEnv)
      throw invalid()
  }

  return {
    dataDir: state.dataDir,
    ...(state.proxyEnv !== undefined && { proxyEnv: state.proxyEnv }),
    ...(state.instanceToken !== undefined && { instanceToken: state.instanceToken }),
    ...(config && { config }),
    ...(state.serviceDefinitionPath !== undefined && { serviceDefinitionPath: state.serviceDefinitionPath as string }),
    ...(state.xdgConfigHome !== undefined && { xdgConfigHome: state.xdgConfigHome as string }),
  }
}

function validateNativeServiceConfig(data: Record<string, unknown>): NativeServiceConfig | undefined {
  if (typeof data.port !== 'number' || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535)
    return undefined
  if (typeof data.host !== 'string' || !data.host.trim() || /[\s/]/.test(data.host))
    return undefined
  if (typeof data.verbose !== 'boolean')
    return undefined
  if (typeof data.accountType !== 'string' || !['individual', 'business', 'enterprise'].includes(data.accountType))
    return undefined
  if (typeof data.manual !== 'boolean'
    || typeof data.rateLimitWait !== 'boolean'
    || typeof data.showToken !== 'boolean'
    || typeof data.proxyEnv !== 'boolean') {
    return undefined
  }
  if (data.rateLimit !== undefined
    && (typeof data.rateLimit !== 'number' || !Number.isInteger(data.rateLimit) || data.rateLimit <= 0 || data.rateLimit > 86400)) {
    return undefined
  }
  try {
    resolveConcurrencyLimitConfig({
      maxConcurrency: data.maxConcurrency as number | undefined,
      maxQueue: data.maxQueue as number | undefined,
      queueTimeoutMs: data.queueTimeoutMs as number | undefined,
    })
  }
  catch {
    return undefined
  }
  for (const key of ['headersTimeoutMs', 'bodyTimeoutMs', 'connectTimeoutMs'] as const) {
    const value = data[key]
    if (value !== undefined
      && (typeof value !== 'number'
        || !Number.isInteger(value)
        || value < 0
        || value > MAX_TIMER_DELAY_MS)) {
      return undefined
    }
  }

  return {
    port: data.port,
    host: data.host,
    verbose: data.verbose,
    accountType: data.accountType,
    manual: data.manual,
    ...(typeof data.rateLimit === 'number' && { rateLimit: data.rateLimit }),
    rateLimitWait: data.rateLimitWait,
    ...(typeof data.maxConcurrency === 'number' && { maxConcurrency: data.maxConcurrency }),
    ...(typeof data.maxQueue === 'number' && { maxQueue: data.maxQueue }),
    ...(typeof data.queueTimeoutMs === 'number' && { queueTimeoutMs: data.queueTimeoutMs }),
    ...(typeof data.headersTimeoutMs === 'number' && { headersTimeoutMs: data.headersTimeoutMs }),
    ...(typeof data.bodyTimeoutMs === 'number' && { bodyTimeoutMs: data.bodyTimeoutMs }),
    ...(typeof data.connectTimeoutMs === 'number' && { connectTimeoutMs: data.connectTimeoutMs }),
    showToken: data.showToken,
    proxyEnv: data.proxyEnv,
  }
}

export function applyInstalledNativeServiceDataDir(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  filePath = getNativeServiceControlStatePath(env),
): ApplyInstalledNativeServiceDataDirResult {
  if (hasCittyRootHelpFlag(args))
    return {}
  const command = findCittyRootCommand(args)?.command ?? ''
  const nativeControlCommand = NATIVE_CONTROL_COMMANDS.has(command)
  const installedDataDirDefaultCommand = INSTALLED_DATA_DIR_DEFAULT_COMMANDS.has(command)
  if (!nativeControlCommand && !installedDataDirDefaultCommand)
    return {}
  const explicitDataDir = installedDataDirDefaultCommand
    ? env.COPILOT_PROXY_DATA_DIR?.trim()
    : undefined
  if (explicitDataDir) {
    const appliedDataDir = env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]?.trim()
    if (appliedDataDir && sameDataDirectory(appliedDataDir, explicitDataDir))
      return {}

    let explicitState: NativeServiceInstallState | undefined
    try {
      explicitState = loadNativeServiceInstallState(filePath)
    }
    catch {
      delete env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]
      return {}
    }
    if (!explicitState || !sameDataDirectory(explicitState.dataDir, explicitDataDir)) {
      delete env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]
      return {}
    }
    applyNativeServiceInstallState(explicitState, env, false)
    return {}
  }

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
  if (state)
    applyNativeServiceInstallState(state, env, true)
  return {}
}

export function sameDataDirectory(left: string, right: string): boolean {
  const normalizedLeft = canonicalDataDirectory(left)
  const normalizedRight = canonicalDataDirectory(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function applyNativeServiceInstallState(
  state: NativeServiceInstallState,
  env: NodeJS.ProcessEnv,
  applyDataDir: boolean,
): void {
  if (applyDataDir)
    env.COPILOT_PROXY_DATA_DIR = state.dataDir
  env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV] = canonicalDataDirectory(state.dataDir)
  if (state.serviceDefinitionPath)
    env[NATIVE_SERVICE_DEFINITION_PATH_ENV] = state.serviceDefinitionPath
  else
    delete env[NATIVE_SERVICE_DEFINITION_PATH_ENV]
  if (state.xdgConfigHome)
    env.XDG_CONFIG_HOME = state.xdgConfigHome
  else if (process.platform === 'linux')
    delete env.XDG_CONFIG_HOME
}

function canonicalDataDirectory(dataDir: string): string {
  const resolved = path.resolve(dataDir)
  try {
    return fs.realpathSync.native(resolved)
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
      return resolved
    throw error
  }
}
