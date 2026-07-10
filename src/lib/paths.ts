import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

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

  const dataHome = env.XDG_DATA_HOME || path.posix.join(homedir, '.local', 'share')
  return path.posix.join(dataHome, 'copilot-proxy')
}

const APP_DIR = getAppDir()

const GITHUB_TOKEN_PATH = path.join(APP_DIR, 'github_token')
const DAEMON_PID = path.join(APP_DIR, 'daemon.pid')
const DAEMON_LOG = path.join(APP_DIR, 'daemon.log')
const DAEMON_JSON = path.join(APP_DIR, 'daemon.json')
const DAEMON_STOP = path.join(APP_DIR, 'daemon.stop')
const DAEMON_ENV = path.join(APP_DIR, 'daemon-env.json')
const NATIVE_SERVICE_ENV = path.join(APP_DIR, 'service-env.json')

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  DAEMON_PID,
  DAEMON_LOG,
  DAEMON_JSON,
  DAEMON_STOP,
  DAEMON_ENV,
  NATIVE_SERVICE_ENV,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureOwnerOnlyFile(PATHS.GITHUB_TOKEN_PATH)
}

export async function ensureOwnerOnlyFile(filePath: string): Promise<void> {
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

  // chmod existing files too. Earlier versions only corrected permissions for
  // newly-created files, leaving an existing 0644 token readable by others.
  await fs.chmod(filePath, 0o600)
}
