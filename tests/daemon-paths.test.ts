import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'bun:test'

import { getAppDir, PATHS } from '../src/lib/paths'

test('PATHS includes DAEMON_PID path', () => {
  expect(PATHS.DAEMON_PID).toBe(path.join(PATHS.APP_DIR, 'daemon.pid'))
})

test('PATHS includes DAEMON_LOG path', () => {
  expect(PATHS.DAEMON_LOG).toBe(path.join(PATHS.APP_DIR, 'daemon.log'))
})

test('PATHS includes DAEMON_JSON path', () => {
  expect(PATHS.DAEMON_JSON).toBe(path.join(PATHS.APP_DIR, 'daemon.json'))
})

test('getAppDir uses LOCALAPPDATA on Windows', () => {
  expect(getAppDir({
    env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
    homedir: 'C:\\Users\\alice',
    platform: 'win32',
  })).toBe(path.win32.join('C:\\Users\\alice\\AppData\\Local', 'copilot-proxy'))
})

test('getAppDir falls back to AppData Local on Windows', () => {
  expect(getAppDir({
    env: {},
    homedir: 'C:\\Users\\alice',
    platform: 'win32',
  })).toBe(path.win32.join('C:\\Users\\alice', 'AppData', 'Local', 'copilot-proxy'))
})

test('getAppDir uses XDG_DATA_HOME on non-Windows', () => {
  expect(getAppDir({
    env: { XDG_DATA_HOME: '/tmp/xdg-data' },
    homedir: os.homedir(),
    platform: 'linux',
  })).toBe(path.posix.join('/tmp/xdg-data', 'copilot-proxy'))
})
