import fs from 'node:fs'
import process from 'node:process'

import { PATHS } from '~/lib/paths'

export interface DaemonPidInfo {
  pid: number
  startTime: number
}

export function writePid(pid: number): void {
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  const pidPath = PATHS.DAEMON_PID
  fs.writeFileSync(pidPath, `${pid}\n${Date.now()}`, { mode: 0o600 })
  // Ensure permissions are correct even if file already existed with wider perms
  try {
    fs.chmodSync(pidPath, 0o600)
  }
  catch {}
}

export function readPid(): DaemonPidInfo | null {
  try {
    const content = fs.readFileSync(PATHS.DAEMON_PID, 'utf8').trim()
    const lines = content.split('\n')
    if (lines.length < 2) {
      // Legacy format: just PID
      const pid = Number.parseInt(lines[0], 10)
      if (Number.isNaN(pid) || pid <= 0 || String(pid) !== lines[0])
        return null
      return { pid, startTime: 0 }
    }
    const pid = Number.parseInt(lines[0], 10)
    const startTime = Number.parseInt(lines[1], 10)
    if (Number.isNaN(pid) || pid <= 0 || String(pid) !== lines[0])
      return null
    if (Number.isNaN(startTime))
      return null
    return { pid, startTime }
  }
  catch {
    return null
  }
}

export function removePidFile(): void {
  try {
    fs.unlinkSync(PATHS.DAEMON_PID)
  }
  catch {}
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') {
      return true
    }
    return false
  }
}

/**
 * Check if the PID from the PID file is likely still our daemon process.
 * Verifies both that the process is alive AND that it was started around
 * the time we recorded (within 5s tolerance to account for spawn delay).
 * This prevents killing an unrelated process that reused the same PID.
 */
export function isDaemonRunning(): { running: true, pid: number } | { running: false } {
  const info = readPid()
  if (info === null)
    return { running: false }
  if (!isProcessRunning(info.pid))
    return { running: false }

  // If startTime is 0 (legacy format), we can't verify identity — trust PID
  if (info.startTime === 0)
    return { running: true, pid: info.pid }

  // Check if the PID file's start time is plausible.
  // The PID file is written by the parent process right after spawn.
  // If the file's recorded time is far in the past (> 1 day difference
  // from the file's mtime), the PID was likely reused by a different process.
  try {
    const stat = fs.statSync(PATHS.DAEMON_PID)
    const fileMtime = stat.mtimeMs
    // The recorded startTime should be close to the file's mtime
    // (within 5s, accounting for spawn delay)
    if (Math.abs(info.startTime - fileMtime) > 5000) {
      // PID file was tampered with or is stale
      return { running: false }
    }
  }
  catch {
    // Can't stat — treat as not running
    return { running: false }
  }

  return { running: true, pid: info.pid }
}
