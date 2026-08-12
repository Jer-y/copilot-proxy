import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { hardenOwnerOnlyPath, hardenOwnerOnlyPaths } from './owner-only'

interface AppDirOptions {
  env?: NodeJS.ProcessEnv
  homedir?: string
  platform?: NodeJS.Platform
}

export const APP_DIR_ENV = 'COPILOT_PROXY_DATA_DIR'

export function getUserHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  fallback = os.homedir(),
): string {
  return env.COPILOT_PROXY_TEST_HOME || env.HOME || env.USERPROFILE || fallback
}

export function getAppDir(options: AppDirOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const homedir = options.homedir ?? getUserHomeDir(env)

  if (env[APP_DIR_ENV]) {
    return platform === 'win32'
      ? path.win32.resolve(env[APP_DIR_ENV])
      : path.posix.resolve(env[APP_DIR_ENV])
  }

  if (platform === 'win32') {
    const dataHome = env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local')
    return path.win32.join(dataHome, 'copilot-proxy')
  }

  const configuredDataHome = env.XDG_DATA_HOME?.trim()
  const dataHome = configuredDataHome && path.posix.isAbsolute(configuredDataHome)
    ? configuredDataHome
    : path.posix.join(homedir, '.local', 'share')
  return path.posix.join(dataHome, 'copilot-proxy')
}

const APP_DIR = getAppDir()

const GITHUB_TOKEN_PATH = path.join(APP_DIR, 'github_token')
const DAEMON_LOG = path.join(APP_DIR, 'daemon.log')
const DAEMON_STOP = path.join(APP_DIR, 'daemon.stop')
const NATIVE_SERVICE_ENV = path.join(APP_DIR, 'service-env.json')
const ACCOUNTS_CONFIG = path.join(APP_DIR, 'accounts.json')
const ACCOUNTS_LOCK = path.join(APP_DIR, 'accounts.lock')
const RUNTIME_LOCK = path.join(APP_DIR, 'runtime.lock')
const TOKENS_DIR = path.join(APP_DIR, 'tokens')

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  DAEMON_LOG,
  DAEMON_STOP,
  NATIVE_SERVICE_ENV,
  ACCOUNTS_CONFIG,
  ACCOUNTS_LOCK,
  RUNTIME_LOCK,
  TOKENS_DIR,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true, mode: 0o700 })
  await ensureFileExists(PATHS.GITHUB_TOKEN_PATH)
  const targets = [
    { path: PATHS.APP_DIR, directory: true },
    { path: PATHS.GITHUB_TOKEN_PATH },
  ]
  if (await fileExists(PATHS.ACCOUNTS_CONFIG))
    targets.push({ path: PATHS.ACCOUNTS_CONFIG })
  hardenOwnerOnlyPaths(targets)
}

export async function ensureOwnerOnlyFile(filePath: string): Promise<void> {
  await ensureFileExists(filePath)

  // chmod existing files too. Earlier versions only corrected permissions for
  // newly-created files, leaving an existing 0644 token readable by others.
  hardenOwnerOnlyPath(filePath)
}

async function ensureFileExists(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.F_OK)
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error

    try {
      await fs.writeFile(filePath, '', { flag: 'wx', mode: 0o600 })
    }
    catch (writeError) {
      // Another initializer may have created the file after the access check.
      if (!(writeError instanceof Error && 'code' in writeError && writeError.code === 'EEXIST'))
        throw writeError
    }
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.F_OK)
    return true
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}
