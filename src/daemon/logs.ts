import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

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
      // Use tail -f on Unix, fs.watchFile fallback on Windows
      if (process.platform === 'win32') {
        followLogsWatch()
      }
      else {
        const tail = spawn('tail', ['-f', '-n', args.lines, PATHS.DAEMON_LOG], {
          stdio: 'inherit',
        })
        tail.on('error', () => {
          followLogsWatch()
        })
      }
    }
    else {
      const content = fs.readFileSync(PATHS.DAEMON_LOG, 'utf8')
      const lines = content.split('\n')
      const count = Number.parseInt(args.lines, 10)
      const output = lines.slice(-count).join('\n')
      // eslint-disable-next-line no-console
      console.log(output)
    }
  },
})

function followLogsWatch(): void {
  const content = fs.readFileSync(PATHS.DAEMON_LOG, 'utf8')
  process.stdout.write(content)

  let position = Buffer.byteLength(content)
  fs.watchFile(PATHS.DAEMON_LOG, { interval: 500 }, () => {
    const fd = fs.openSync(PATHS.DAEMON_LOG, 'r')
    const stat = fs.fstatSync(fd)
    if (stat.size < position) {
      // File was truncated, reset
      position = 0
    }
    if (stat.size > position) {
      const buffer = Buffer.alloc(stat.size - position)
      fs.readSync(fd, buffer, 0, buffer.length, position)
      process.stdout.write(buffer)
      position = stat.size
    }
    fs.closeSync(fd)
  })
}
