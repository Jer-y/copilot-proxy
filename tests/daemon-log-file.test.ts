import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { ensureDaemonLogFile, readLastLogLines, rotateDaemonLogIfNeeded } from '~/daemon/log-file'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

describe('daemon log file helpers', () => {
  test('rotates oversized daemon logs', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')
    fs.writeFileSync(logPath, 'abcdef')

    rotateDaemonLogIfNeeded(logPath, { maxBytes: 3, rotatedFiles: 2 })

    expect(fs.existsSync(logPath)).toBe(false)
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('abcdef')
    if (process.platform !== 'win32')
      expect(fs.statSync(`${logPath}.1`).mode & 0o777).toBe(0o600)
  })

  test('pre-creates the native-service log with owner-only permissions', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'nested', 'daemon.log')

    ensureDaemonLogFile(logPath)

    expect(fs.existsSync(logPath)).toBe(true)
    if (process.platform !== 'win32')
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600)
  })

  test('repairs an existing native-service log permission', () => {
    if (process.platform === 'win32')
      return

    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')
    fs.writeFileSync(logPath, 'existing', { mode: 0o644 })
    fs.chmodSync(logPath, 0o644)

    ensureDaemonLogFile(logPath)

    expect(fs.statSync(logPath).mode & 0o777).toBe(0o600)
  })

  test('reads only the requested tail lines', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')
    fs.writeFileSync(logPath, ['one', 'two', 'three', 'four'].join('\n'))

    expect(readLastLogLines(logPath, 2)).toBe('three\nfour')
  })
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-log-test-'))
  tempDirs.push(dir)
  return dir
}
