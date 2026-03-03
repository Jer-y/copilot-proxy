import process from 'node:process'
import consola from 'consola'

import { readPid, removePidFile, writePid } from '~/daemon/pid'
import { isPortInUseError } from '~/lib/port'

const MAX_BACKOFF_MS = 60_000
const STABLE_THRESHOLD_MS = 60_000

export async function runAsSupervisor(runFn: () => Promise<void>): Promise<void> {
  let backoffMs = 1000
  let lastStartTime = Date.now()

  // Capture a fixed start time once. All subsequent writePid calls
  // reuse this value so it stays close to the OS process start time,
  // preventing isDaemonRunning() from rejecting us after crash-restarts
  // or PID file self-healing.
  const supervisorStartTime = Date.now()

  // Write PID file so status/stop/restart can find us.
  // This covers both the start -d path (where parent already wrote it)
  // and the enable path (where _supervisor is launched directly by the OS).
  writePid(process.pid, supervisorStartTime)

  const cleanup = () => {
    removePidFile()
    process.exit(0)
  }

  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  // On Windows, SIGTERM doesn't fire - use 'exit' as fallback to clean up PID file
  if (process.platform === 'win32') {
    process.on('exit', () => {
      removePidFile()
    })
  }

  while (true) {
    // Self-heal: restore PID file if it was deleted externally.
    // Uses the fixed supervisorStartTime so the timestamp stays consistent
    // with the OS process start time.
    const existing = readPid()
    if (existing === null || existing.pid !== process.pid) {
      writePid(process.pid, supervisorStartTime)
    }
    lastStartTime = Date.now()
    try {
      await runFn()
      // runFn resolved normally — shouldn't happen for a long-running server,
      // but if it does, break the loop
      break
    }
    catch (error) {
      if (isPortInUseError(error)) {
        consola.error('Port is already in use, not retrying')
        removePidFile()
        process.exit(1)
      }

      const uptime = Date.now() - lastStartTime
      consola.error('Server crashed:', error)

      if (uptime > STABLE_THRESHOLD_MS) {
        backoffMs = 1000
      }

      consola.info(`Restarting in ${backoffMs / 1000}s...`)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    }
  }
}
