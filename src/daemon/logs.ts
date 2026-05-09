import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { readLastLogLines } from '~/daemon/log-file'
import { PATHS } from '~/lib/paths'

export const logs = defineCommand({
  meta: {
    name: 'logs',
    description: 'Show daemon logs',
  },
  args: {
    follow: {
      alias: 'f',
      type: 'boolean',
      default: false,
      description: 'Follow log output',
    },
    lines: {
      alias: 'n',
      type: 'string',
      default: '50',
      description: 'Number of lines to show',
    },
  },
  run({ args }) {
    if (!fs.existsSync(PATHS.DAEMON_LOG)) {
      consola.info('No log file found')
      return
    }

    if (args.follow) {
      followLogsWatch(Number.parseInt(args.lines, 10))
    }
    else {
      const count = Number.parseInt(args.lines, 10)
      const output = readLastLogLines(PATHS.DAEMON_LOG, Number.isFinite(count) ? count : 50)
      // eslint-disable-next-line no-console
      console.log(output)
    }
  },
})

function followLogsWatch(lineCount: number): void {
  const count = Number.isFinite(lineCount) ? lineCount : 50
  const content = readLastLogLines(PATHS.DAEMON_LOG, count)
  process.stdout.write(content)

  let position = fs.statSync(PATHS.DAEMON_LOG).size
  let currentIno: number | bigint = 0
  try {
    currentIno = fs.statSync(PATHS.DAEMON_LOG).ino
  }
  catch {}

  // Use polling interval to detect both content changes and file rotation
  setInterval(() => {
    try {
      const stat = fs.statSync(PATHS.DAEMON_LOG)

      // Detect file rotation (inode changed = new file)
      if (stat.ino !== currentIno) {
        currentIno = stat.ino
        position = 0
      }

      if (stat.size < position) {
        // File was truncated, reset
        position = 0
      }
      if (stat.size > position) {
        const fd = fs.openSync(PATHS.DAEMON_LOG, 'r')
        const buffer = Buffer.alloc(stat.size - position)
        fs.readSync(fd, buffer, 0, buffer.length, position)
        fs.closeSync(fd)
        process.stdout.write(buffer)
        position = stat.size
      }
    }
    catch {
      // File may have been removed temporarily during rotation
    }
  }, 500)
}
