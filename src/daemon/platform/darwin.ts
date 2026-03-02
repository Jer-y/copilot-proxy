import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import consola from 'consola'

import { PATHS } from '~/lib/paths'

const PLIST_NAME = 'com.copilot-proxy.plist'
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME)

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function installAutoStart(execPath: string, args: string[]): Promise<boolean> {
  const programArgs = [execPath, ...args]
    .map(arg => `        <string>${xmlEscape(arg)}</string>`)
    .join('\n')

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.copilot-proxy</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(PATHS.DAEMON_LOG)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(PATHS.DAEMON_LOG)}</string>
</dict>
</plist>
`

  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true })
  fs.writeFileSync(PLIST_PATH, plist)

  try {
    execFileSync('launchctl', ['load', PLIST_PATH])
  }
  catch {
    consola.error('launchctl load failed. You may need to load it manually.')
    consola.info(`Plist written to: ${PLIST_PATH}`)
    return false
  }

  consola.success('Auto-start enabled via launchd')
  return true
}

export async function uninstallAutoStart(): Promise<boolean> {
  try {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' })
  }
  catch (error) {
    consola.warn('Failed to unload service:', error instanceof Error ? error.message : error)
  }

  try {
    fs.unlinkSync(PLIST_PATH)
  }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      consola.error('Failed to remove plist file:', error.message)
      return false
    }
  }

  consola.success('Auto-start disabled')
  return true
}
