import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll } from 'bun:test'

const originalHome = os.homedir()
const originalAppDir = process.env.COPILOT_PROXY_DATA_DIR
  ?? (process.platform === 'win32'
    ? path.win32.join(
        process.env.LOCALAPPDATA || path.win32.join(originalHome, 'AppData', 'Local'),
        'copilot-proxy',
      )
    : path.posix.join(
        process.env.XDG_DATA_HOME || path.posix.join(originalHome, '.local', 'share'),
        'copilot-proxy',
      ))
const originalTokenPath = path.join(originalAppDir, 'github_token')
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-test-home-'))
const testAppDir = path.join(testHome, 'copilot-proxy-data')

process.env.COPILOT_PROXY_TEST_HOME = testHome
process.env.HOME = testHome
process.env.USERPROFILE = testHome
process.env.XDG_DATA_HOME = path.join(testHome, '.local', 'share')
process.env.XDG_CONFIG_HOME = path.join(testHome, '.config')
process.env.XDG_STATE_HOME = path.join(testHome, '.local', 'state')
process.env.LOCALAPPDATA = path.join(testHome, 'AppData', 'Local')
process.env.APPDATA = path.join(testHome, 'AppData', 'Roaming')
process.env.COPILOT_PROXY_DATA_DIR = testAppDir

if (process.env.COPILOT_LIVE_TEST === '1' && fs.existsSync(originalTokenPath)) {
  const testTokenPath = path.join(testAppDir, 'github_token')
  fs.mkdirSync(path.dirname(testTokenPath), { recursive: true })
  fs.copyFileSync(originalTokenPath, testTokenPath)
  try {
    fs.chmodSync(testTokenPath, 0o600)
  }
  catch {}
}

afterAll(() => {
  fs.rmSync(testHome, { force: true, recursive: true })
})
