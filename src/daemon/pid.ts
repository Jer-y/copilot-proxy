import fs from 'node:fs'
import process from 'node:process'

import { PATHS } from '~/lib/paths'

export interface DaemonPidInfo {
  pid: number
  startTime: number
}

export function writePid(pid: number): void {
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  fs.writeFileSync(PATHS.DAEMON_PID, `${pid}\n${Date.now()}`, { mode: 0o644 })
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
