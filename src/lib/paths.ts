import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

interface AppDirOptions {
  env?: NodeJS.ProcessEnv
  homedir?: string
  platform?: NodeJS.Platform
}

export function getAppDir(options: AppDirOptions = {}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const homedir = options.homedir ?? os.homedir()

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

export const PATHS = {
  APP_DIR,
  GITHUB_TOKEN_PATH,
  DAEMON_PID,
  DAEMON_LOG,
  DAEMON_JSON,
  DAEMON_STOP,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  }
  catch {
    await fs.writeFile(filePath, '', { mode: 0o600 })
    await fs.chmod(filePath, 0o600)
  }
}
