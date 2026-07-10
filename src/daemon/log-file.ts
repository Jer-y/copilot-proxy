import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'

import { PATHS } from '~/lib/paths'

export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024
export const DAEMON_LOG_ROTATED_FILES = 3

export function ensureDaemonLogFile(logPath: string = PATHS.DAEMON_LOG): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const fd = fs.openSync(logPath, 'a', 0o600)
  try {
    fs.fchmodSync(fd, 0o600)
  }
  finally {
    fs.closeSync(fd)
  }
}

export function rotateDaemonLogIfNeeded(
  logPath: string = PATHS.DAEMON_LOG,
  options?: {
    maxBytes?: number
    rotatedFiles?: number
  },
): void {
  const maxBytes = options?.maxBytes ?? DAEMON_LOG_MAX_BYTES
  const rotatedFiles = options?.rotatedFiles ?? DAEMON_LOG_ROTATED_FILES

  let stat: fs.Stats
  try {
    stat = fs.statSync(logPath)
  }
  catch {
    return
  }

  fs.chmodSync(logPath, 0o600)

  if (stat.size < maxBytes) {
    return
  }

  for (let index = rotatedFiles - 1; index >= 1; index--) {
    renameIfExists(`${logPath}.${index}`, `${logPath}.${index + 1}`)
  }
  renameIfExists(logPath, `${logPath}.1`)

  for (let index = 1; index <= rotatedFiles; index++) {
    try {
      fs.chmodSync(`${logPath}.${index}`, 0o600)
    }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        throw error
    }
  }
}

export function readLastLogLines(logPath: string, lineCount: number): string {
  const count = Math.max(1, lineCount)
  const stat = fs.statSync(logPath)
  const chunkSize = 64 * 1024
  let position = stat.size
  let content = ''

  while (position > 0 && countLines(content) <= count) {
    const readSize = Math.min(chunkSize, position)
    position -= readSize
    const fd = fs.openSync(logPath, 'r')
    try {
      const buffer = Buffer.alloc(readSize)
      fs.readSync(fd, buffer, 0, readSize, position)
      content = `${buffer.toString('utf8')}${content}`
    }
    finally {
      fs.closeSync(fd)
    }
  }

  return content.split('\n').slice(-count).join('\n')
}

function countLines(value: string): number {
  return value.length === 0 ? 0 : value.split('\n').length
}

function renameIfExists(from: string, to: string): void {
  try {
    fs.renameSync(from, to)
  }
  catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
}
