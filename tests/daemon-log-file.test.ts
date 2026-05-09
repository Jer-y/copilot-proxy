import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { readLastLogLines, rotateDaemonLogIfNeeded } from '~/daemon/log-file'

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
