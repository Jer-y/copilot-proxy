import { execSync } from 'node:child_process'
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
 * Check if a running process is actually our daemon supervisor.
 * Uses two checks:
 * 1. Command line must contain '_supervisor' flag
 * 2. Process start time must match the recorded startTime in PID file
 *    (within tolerance, to prevent spoofing with a fake process)
 */
function isOurDaemonProcess(pid: number, recordedStartTime: number): boolean {
  try {
    // Check command line
    let cmdline: string
    if (process.platform === 'win32') {
      cmdline = execSync(
        `wmic process where ProcessId=${pid} get CommandLine /format:list`,
        { stdio: 'pipe', encoding: 'utf8' },
      )
    }
    else {
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      }
      catch {
        cmdline = execSync(`ps -p ${pid} -o command=`, {
          stdio: 'pipe',
          encoding: 'utf8',
        })
      }
    }

    if (!cmdline.includes('_supervisor'))
      return false

    // If no recorded start time (legacy), command line check alone is sufficient
    if (recordedStartTime === 0)
      return true

    // Check process start time matches what we recorded
    const processStartMs = getProcessStartTime(pid)
    if (processStartMs === null)
      return false

    // Allow 5s tolerance between when we recorded the time and when the OS recorded process start
    return Math.abs(processStartMs - recordedStartTime) < 5000
  }
  catch {
    return false
  }
}

/**
 * Get the start time of a process in milliseconds since epoch.
 * Returns null if unavailable.
 */
function getProcessStartTime(pid: number): number | null {
  try {
    if (process.platform === 'win32') {
      const output = execSync(
        `wmic process where ProcessId=${pid} get CreationDate /format:list`,
        { stdio: 'pipe', encoding: 'utf8' },
      )
      // Format: CreationDate=20260302123456.123456+480
      const match = output.match(/CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)/)
      if (!match)
        return null
      const [, y, m, d, h, min, s] = match
      return new Date(`${y}-${m}-${d}T${h}:${min}:${s}Z`).getTime()
    }
    else {
      // Linux: read /proc/<pid>/stat, field 22 is starttime in clock ticks since boot
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        // Fields are space-separated, but field 2 (comm) can contain spaces/parens
        // Find the last ')' to skip past comm field
        const afterComm = stat.substring(stat.lastIndexOf(')') + 2)
        const fields = afterComm.split(' ')
        // starttime is field 22 overall, which is field 20 after comm (0-indexed: index 19)
        const startTicks = Number.parseInt(fields[19], 10)
        if (Number.isNaN(startTicks))
          return null

        // Get system boot time and clock ticks per second
        const uptimeStr = fs.readFileSync('/proc/uptime', 'utf8')
        const uptimeSec = Number.parseFloat(uptimeStr.split(' ')[0])
        // CLK_TCK is typically 100 on Linux
        const clkTck = 100
        const processUptimeSec = startTicks / clkTck
        const bootTimeMs = Date.now() - uptimeSec * 1000
        return bootTimeMs + processUptimeSec * 1000
      }
      catch {
        // macOS: use ps -p <pid> -o lstart=
        const output = execSync(`ps -p ${pid} -o lstart=`, {
          stdio: 'pipe',
          encoding: 'utf8',
        }).trim()
        if (!output)
          return null
        const parsed = Date.parse(output)
        return Number.isNaN(parsed) ? null : parsed
      }
    }
  }
  catch {
    return null
  }
}

/**
 * Check if the PID from the PID file is likely still our daemon process.
 * Verifies that the process is alive AND that its command line contains
 * the _supervisor flag AND that its start time matches what we recorded.
 */
export function isDaemonRunning(): { running: true, pid: number } | { running: false } {
  const info = readPid()
  if (info === null)
    return { running: false }
  if (!isProcessRunning(info.pid))
    return { running: false }

  // Verify the process is actually our daemon
  if (!isOurDaemonProcess(info.pid, info.startTime))
    return { running: false }

  return { running: true, pid: info.pid }
}
