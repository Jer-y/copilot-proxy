import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'

import { rotateDaemonLogIfNeeded } from '~/daemon/log-file'
import { PATHS } from '~/lib/paths'

const PLIST_NAME = 'com.copilot-proxy.plist'
const LABEL = 'com.copilot-proxy'
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME)

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function installAutoStart(execPath: string, args: string[]): Promise<boolean> {
  rotateDaemonLogIfNeeded()

  const programArgs = [execPath, ...args]
    .map(arg => `        <string>${xmlEscape(arg)}</string>`)
    .join('\n')

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
    </dict>
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

export function isAutoStartInstalled(): boolean {
  return fs.existsSync(PLIST_PATH)
}

export function stopAutoStartService(): boolean {
  if (!isAutoStartInstalled())
    return false

  try {
    execFileSync('launchctl', ['stop', LABEL], { stdio: 'inherit' })
    return true
  }
  catch (error) {
    consola.error('Failed to stop launchd service:', error instanceof Error ? error.message : error)
    return false
  }
}

export function restartAutoStartService(): boolean {
  if (!isAutoStartInstalled())
    return false

  rotateDaemonLogIfNeeded()

  try {
    execFileSync('launchctl', buildLaunchctlKickstartArgs(process.getuid?.()), { stdio: 'inherit' })
    return true
  }
  catch (error) {
    consola.warn('launchctl kickstart failed, falling back to stop/start:', error instanceof Error ? error.message : error)
  }

  try {
    execFileSync('launchctl', ['stop', LABEL], { stdio: 'pipe' })
  }
  catch {
    // It may already be stopped. Starting below is the important part.
  }

  try {
    execFileSync('launchctl', ['start', LABEL], { stdio: 'inherit' })
    return true
  }
  catch (error) {
    consola.error('Failed to start launchd service:', error instanceof Error ? error.message : error)
    return false
  }
}

export function showAutoStartStatus(): boolean {
  if (!isAutoStartInstalled())
    return false

  try {
    execFileSync('launchctl', ['list', LABEL], { stdio: 'inherit' })
  }
  catch {
    // `launchctl list <label>` exits non-zero when the job is installed but not
    // currently loaded. Treat the native status check as handled.
  }
  return true
}

export function showAutoStartLogs(): boolean {
  return false
}

export function buildLaunchctlKickstartArgs(uid?: number): string[] {
  const target = typeof uid === 'number' ? `gui/${uid}/${LABEL}` : LABEL
  return ['kickstart', '-k', target]
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
