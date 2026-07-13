import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'bun:test'

import { getAppDir, getUserHomeDir, PATHS } from '../src/lib/paths'

test('PATHS includes DAEMON_PID path', () => {
  expect(PATHS.DAEMON_PID).toBe(path.join(PATHS.APP_DIR, 'daemon.pid'))
})

test('PATHS includes DAEMON_LOG path', () => {
  expect(PATHS.DAEMON_LOG).toBe(path.join(PATHS.APP_DIR, 'daemon.log'))
})

test('PATHS includes DAEMON_JSON path', () => {
  expect(PATHS.DAEMON_JSON).toBe(path.join(PATHS.APP_DIR, 'daemon.json'))
})

test('PATHS includes the owner-only service environment path', () => {
  expect(PATHS.NATIVE_SERVICE_ENV).toBe(path.join(PATHS.APP_DIR, 'service-env.json'))
})

test('PATHS keeps legacy and native service environments separate', () => {
  expect(PATHS.DAEMON_ENV).toBe(path.join(PATHS.APP_DIR, 'daemon-env.json'))
  expect(PATHS.DAEMON_ENV).not.toBe(PATHS.NATIVE_SERVICE_ENV)
})

test('getAppDir honors the native-service data directory before platform defaults', () => {
  expect(getAppDir({
    env: {
      COPILOT_PROXY_DATA_DIR: '/persisted/copilot-proxy',
      XDG_DATA_HOME: '/ignored',
    },
    homedir: '/ignored-home',
    platform: 'linux',
  })).toBe('/persisted/copilot-proxy')
})

test('getUserHomeDir honors an explicit isolated home before the runtime-cached home', () => {
  expect(getUserHomeDir({
    COPILOT_PROXY_TEST_HOME: '/isolated-test-home',
    HOME: '/shell-home',
  }, '/cached-home')).toBe('/isolated-test-home')
  expect(getUserHomeDir({ HOME: '/shell-home' }, '/cached-home')).toBe('/shell-home')
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

test('getAppDir ignores a relative XDG_DATA_HOME', () => {
  expect(getAppDir({
    env: { XDG_DATA_HOME: 'relative-data' },
    homedir: '/home/alice',
    platform: 'linux',
  })).toBe('/home/alice/.local/share/copilot-proxy')
})
