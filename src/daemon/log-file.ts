import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { PATHS } from '~/lib/paths'

export const DAEMON_LOG_MAX_BYTES = 10 * 1024 * 1024
export const DAEMON_LOG_ROTATED_FILES = 3

let rotatingProcessLogInstalled = false

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

export function appendToRotatingLog(
  chunk: string | Uint8Array,
  options?: {
    encoding?: BufferEncoding
    logPath?: string
    maxBytes?: number
    rotatedFiles?: number
  },
): void {
  const logPath = options?.logPath ?? PATHS.DAEMON_LOG
  const maxBytes = options?.maxBytes ?? DAEMON_LOG_MAX_BYTES
  const rotatedFiles = options?.rotatedFiles ?? DAEMON_LOG_ROTATED_FILES
  const data = typeof chunk === 'string'
    ? Buffer.from(chunk, options?.encoding)
    : Buffer.from(chunk)

  if (!Number.isInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError('maxBytes must be a positive integer')

  ensureDaemonLogFile(logPath)
  const size = fs.statSync(logPath).size
  if (data.byteLength > maxBytes) {
    if (size > 0) {
      rotateDaemonLogIfNeeded(logPath, { maxBytes: size, rotatedFiles })
      ensureDaemonLogFile(logPath)
    }

    for (let offset = 0; offset < data.byteLength; offset += maxBytes) {
      if (offset > 0) {
        rotateDaemonLogIfNeeded(logPath, { maxBytes, rotatedFiles })
        ensureDaemonLogFile(logPath)
      }
      fs.appendFileSync(logPath, data.subarray(offset, offset + maxBytes), { mode: 0o600 })
    }
    return
  }

  if (size > 0 && size + data.byteLength > maxBytes) {
    rotateDaemonLogIfNeeded(logPath, { maxBytes: size, rotatedFiles })
    ensureDaemonLogFile(logPath)
  }

  fs.appendFileSync(logPath, data, { mode: 0o600 })
}

export function installRotatingProcessLog(logPath: string = PATHS.DAEMON_LOG): () => void {
  if (rotatingProcessLogInstalled)
    return () => {}

  rotateDaemonLogIfNeeded(logPath)
  ensureDaemonLogFile(logPath)

  const stdoutWrite = process.stdout.write
  const stderrWrite = process.stderr.write
  const fallbackWrite = stderrWrite.bind(process.stderr)
  const write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback

    try {
      appendToRotatingLog(chunk, { encoding, logPath })
      done?.()
      return true
    }
    catch (error) {
      const logError = error instanceof Error ? error : new Error(String(error))
      done?.(logError)
      try {
        fallbackWrite(`[copilot-proxy] Failed to write daemon log: ${logError.message}\n`)
      }
      catch {}
      return false
    }
  }

  process.stdout.write = write as typeof process.stdout.write
  process.stderr.write = write as typeof process.stderr.write
  rotatingProcessLogInstalled = true

  return () => {
    if (!rotatingProcessLogInstalled)
      return
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
    rotatingProcessLogInstalled = false
  }
}

export function readLastLogLines(logPath: string, lineCount: number): string {
  const count = Math.max(1, lineCount)
  const chunkSize = 64 * 1024
  const chunks: Buffer[] = []
  let bufferedBytes = 0
  let newlineCount = 0
  let endsWithNewline = false
  const fd = fs.openSync(logPath, 'r')

  try {
    let position = fs.fstatSync(fd).size
    while (position > 0 && countBufferedLines(bufferedBytes, newlineCount, endsWithNewline) <= count) {
      const readSize = Math.min(chunkSize, position)
      position -= readSize
      const buffer = Buffer.alloc(readSize)
      const bytesRead = fs.readSync(fd, buffer, 0, readSize, position)
      const chunk = bytesRead === readSize ? buffer : buffer.subarray(0, bytesRead)

      if (bufferedBytes === 0 && chunk.length > 0)
        endsWithNewline = chunk.at(-1) === 0x0A
      for (const byte of chunk) {
        if (byte === 0x0A)
          newlineCount++
      }

      chunks.push(chunk)
      bufferedBytes += chunk.length
    }
  }
  finally {
    fs.closeSync(fd)
  }

  // Decode only after the reverse-read chunks have been reassembled. Decoding
  // each chunk independently corrupts a multi-byte UTF-8 character when its
  // bytes straddle the 64 KiB read boundary.
  const content = Buffer.concat(chunks.reverse(), bufferedBytes).toString('utf8')

  const lines = content.split('\n')
  if (lines.at(-1) === '')
    lines.pop()
  return lines.slice(-count).join('\n')
}

function countBufferedLines(
  bufferedBytes: number,
  newlineCount: number,
  endsWithNewline: boolean,
): number {
  if (bufferedBytes === 0)
    return 0
  return newlineCount + (endsWithNewline ? 0 : 1)
}

function renameIfExists(from: string, to: string): void {
  if (!fs.existsSync(from))
    return

  try {
    // Windows rename does not replace an existing target. Removing the oldest
    // destination first also makes the retention bound explicit everywhere.
    fs.rmSync(to, { force: true })
    fs.renameSync(from, to)
  }
  catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
}
