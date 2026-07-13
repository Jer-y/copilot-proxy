import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { appendToRotatingLog, ensureDaemonLogFile, installRotatingProcessLog, readLastLogLines, rotateDaemonLogIfNeeded } from '~/daemon/log-file'

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

  test('replaces the oldest retained log during rotation', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')
    fs.writeFileSync(logPath, 'current')
    fs.writeFileSync(`${logPath}.1`, 'previous')
    fs.writeFileSync(`${logPath}.2`, 'oldest')

    rotateDaemonLogIfNeeded(logPath, { maxBytes: 3, rotatedFiles: 2 })

    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('current')
    expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toBe('previous')
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

  test('does not treat a trailing newline as an empty final log line', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')
    fs.writeFileSync(logPath, 'one\ntwo\n')

    expect(readLastLogLines(logPath, 1)).toBe('two')
    expect(readLastLogLines(logPath, 2)).toBe('one\ntwo')
  })

  test('reads a final line larger than the reverse-read chunk', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')
    const longLine = 'x'.repeat(70 * 1024)
    fs.writeFileSync(logPath, `prefix\n${longLine}\n`)

    expect(readLastLogLines(logPath, 1)).toBe(longLine)
  })

  test('decodes a multi-byte character that straddles the reverse-read chunk boundary', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')
    const reverseReadChunkBytes = 64 * 1024
    const tail = 'x'.repeat(reverseReadChunkBytes - 3)
    const longLine = `before-😀${tail}`
    fs.writeFileSync(logPath, `prefix\n${longLine}\n`)

    // The final chunk starts after the first two bytes of the four-byte emoji:
    // two remaining emoji bytes + ASCII tail + newline = exactly 64 KiB.
    expect(readLastLogLines(logPath, 1)).toBe(longLine)
    expect(readLastLogLines(logPath, 2)).toBe(`prefix\n${longLine}`)
  })

  test('rotates while a daemon is still writing', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')

    appendToRotatingLog('first\n', { logPath, maxBytes: 10, rotatedFiles: 2 })
    appendToRotatingLog('second\n', { logPath, maxBytes: 10, rotatedFiles: 2 })
    appendToRotatingLog('third\n', { logPath, maxBytes: 10, rotatedFiles: 2 })

    expect(fs.readFileSync(logPath, 'utf8')).toBe('third\n')
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('second\n')
    expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toBe('first\n')
  })

  test('bounds a single oversized write across retained files', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')

    appendToRotatingLog('abcdefghijklmnopqrstuvw', { logPath, maxBytes: 10, rotatedFiles: 2 })

    expect(fs.readFileSync(logPath, 'utf8')).toBe('uvw')
    expect(fs.readFileSync(`${logPath}.1`, 'utf8')).toBe('klmnopqrst')
    expect(fs.readFileSync(`${logPath}.2`, 'utf8')).toBe('abcdefghij')
  })

  test('restores test-runner stdout and stderr after installing process logging', () => {
    const dir = makeTempDir()
    const logPath = path.join(dir, 'daemon.log')
    const stdoutWrite = process.stdout.write
    const stderrWrite = process.stderr.write
    const restore = installRotatingProcessLog(logPath)

    try {
      process.stdout.write('stdout entry\n')
      process.stderr.write('stderr entry\n')
    }
    finally {
      restore()
    }

    expect(process.stdout.write).toBe(stdoutWrite)
    expect(process.stderr.write).toBe(stderrWrite)
    expect(fs.readFileSync(logPath, 'utf8')).toBe('stdout entry\nstderr entry\n')
  })
})

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-log-test-'))
  tempDirs.push(dir)
  return dir
}
