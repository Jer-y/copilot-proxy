import fs from 'node:fs'
import process from 'node:process'
import consola from 'consola'
import { readPid, removePidFile, writePid } from '~/daemon/pid'
import {
  SUPERVISOR_MAX_BACKOFF_MS as MAX_BACKOFF_MS,
  SUPERVISOR_MAX_CONSECUTIVE_FAILURES as MAX_CONSECUTIVE_FAILURES,
  SUPERVISOR_STABLE_THRESHOLD_MS as STABLE_THRESHOLD_MS,
  SUPERVISOR_INITIAL_BACKOFF_MS,
} from '~/lib/constants'
import { PATHS } from '~/lib/paths'

import { isPortInUseError } from '~/lib/port'

export async function runAsSupervisor(runFn: () => Promise<void>): Promise<void> {
  let backoffMs = SUPERVISOR_INITIAL_BACKOFF_MS
  let lastStartTime = Date.now()
  let consecutiveFailures = 0

  // Capture a fixed start time once. All subsequent writePid calls
  // reuse this value so it stays close to the OS process start time,
  // preventing isDaemonRunning() from rejecting us after crash-restarts
  // or PID file self-healing.
  const supervisorStartTime = Date.now()
  let stopRequestLogged = false

  // Write PID file so status/stop/restart can find us.
  // This covers both the start -d path (where parent already wrote it)
  // and the enable path (where _supervisor is launched directly by the OS).
  writePid(process.pid, supervisorStartTime)

  removeStopRequest()

  const cleanupFiles = () => {
    removeStopRequest()
    removePidFile()
  }

  // Deliberately do not register SIGTERM/SIGINT handlers here. Once the server
  // is active, runServer owns those signals and drains requests. Before that,
  // the runtime's default termination is safe because there are no requests to
  // drain, and it avoids a supervisor listener swallowing an early signal.
  process.once('exit', cleanupFiles)

  const stopPoll = setInterval(() => {
    if (fs.existsSync(PATHS.DAEMON_STOP)) {
      if (!stopRequestLogged) {
        consola.info('Stop request file detected, requesting graceful shutdown')
        stopRequestLogged = true
      }
      // Windows cannot receive SIGTERM from another process. Emitting it in
      // process lets the same runServer shutdown handler drain requests on all
      // platforms. Keep the stop file until exit so an early request is retried
      // after runServer has installed its handler.
      process.emit('SIGTERM', 'SIGTERM')
    }
  }, 500)
  stopPoll.unref?.()

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
        backoffMs = SUPERVISOR_INITIAL_BACKOFF_MS
        consecutiveFailures = 0
      }
      consecutiveFailures++
      if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
        consola.error(`Server crashed ${consecutiveFailures} consecutive time(s), giving up`)
        removePidFile()
        process.exit(1)
      }

      consola.info(`Restarting in ${backoffMs / 1000}s...`)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
    }
  }

  clearInterval(stopPoll)
  process.removeListener('exit', cleanupFiles)
  cleanupFiles()
}

function removeStopRequest(): void {
  try {
    fs.unlinkSync(PATHS.DAEMON_STOP)
  }
  catch {}
}
