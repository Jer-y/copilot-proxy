import type { NativeServiceActivationState } from '~/daemon/native-service'

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'

import { writeFileAtomically } from '~/daemon/atomic-file'
import { ensureDaemonLogFile, rotateDaemonLogIfNeeded } from '~/daemon/log-file'
import { NATIVE_SERVICE_DEFINITION_PATH_ENV } from '~/daemon/service-install-state'
import { getUserHomeDir, PATHS } from '~/lib/paths'

const PLIST_NAME = 'com.copilot-proxy.plist'
const LABEL = 'com.copilot-proxy'
const LAUNCH_AGENTS_DIR = path.join(getUserHomeDir(), 'Library', 'LaunchAgents')
const PLIST_PATH = process.env[NATIVE_SERVICE_DEFINITION_PATH_ENV]
  || path.join(LAUNCH_AGENTS_DIR, PLIST_NAME)
const LAUNCHD_STOP_TIMEOUT_MS = 5_000
let pendingInstall: { previous: ExistingPlist | undefined } | undefined

export interface UninstallAutoStartOptions {
  isInstalled?: () => boolean
  isLoaded?: () => boolean
  stop?: () => boolean
  unload?: () => void
  removeDefinition?: () => void
}

export interface LaunchdAutoStartStateOptions {
  isInstalled?: () => boolean
  inspect?: () => { loaded: boolean, running: boolean }
  isEnabled?: () => boolean
  isLoaded?: () => boolean
  isRunning?: () => boolean
  enable?: () => boolean
  disable?: () => boolean
  load?: () => void
  unload?: () => void
  stop?: () => boolean
  restart?: () => boolean
}

export function captureAutoStartState(
  options: Pick<LaunchdAutoStartStateOptions, 'inspect' | 'isEnabled' | 'isInstalled'> = {},
): NativeServiceActivationState {
  const isInstalled = options.isInstalled ?? isAutoStartInstalled
  if (!isInstalled())
    return { installed: false, enabled: false, running: false }

  const state = (options.inspect ?? inspectLaunchdJob)()
  return {
    installed: true,
    enabled: (options.isEnabled ?? isLaunchdJobEnabled)(),
    loaded: state.loaded,
    running: state.running,
  }
}

export function restoreAutoStartState(
  state: NativeServiceActivationState,
  options: Omit<LaunchdAutoStartStateOptions, 'inspect' | 'isEnabled' | 'isInstalled'> = {},
): boolean {
  if (!state.installed)
    return true

  const isLoaded = options.isLoaded ?? isLaunchdJobLoaded
  const isRunning = options.isRunning ?? (() => inspectLaunchdJob().running)
  const enable = options.enable ?? (() => runLaunchctlStateCommand(buildLaunchctlEnableArgs(process.getuid?.())))
  const disable = options.disable ?? (() => runLaunchctlStateCommand(buildLaunchctlDisableArgs(process.getuid?.())))
  const load = options.load ?? (() => {
    execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'pipe' })
  })
  const unload = options.unload ?? (() => {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' })
  })
  const stop = options.stop ?? stopAutoStartService
  const restart = options.restart ?? restartAutoStartService
  const shouldBeLoaded = state.loaded ?? state.running

  try {
    if (!shouldBeLoaded) {
      if (!isLoaded())
        return state.enabled ? enable() : disable()
      if (isRunning() && !stop())
        return false
      unload()
      return state.enabled ? enable() : disable()
    }

    if (!isLoaded()) {
      // A persistently disabled job cannot be loaded. Enable it temporarily,
      // then restore the previous disabled override after activation state.
      if (!enable())
        return false
      load()
    }
    if (state.running && !restart())
      return false
    if (!state.running && isRunning() && !stop())
      return false
    return state.enabled ? enable() : disable()
  }
  catch (error) {
    consola.error('Failed to restore previous launchd enabled/running state:', error instanceof Error ? error.message : error)
    return false
  }
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function installAutoStart(execPath: string, args: string[]): Promise<boolean> {
  rotateDaemonLogIfNeeded()
  ensureDaemonLogFile()

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

  const previousPlist = readExistingPlist()
  const previousWasLoaded = previousPlist !== undefined && isLaunchdJobLoaded()
  pendingInstall = { previous: previousPlist }

  if (previousWasLoaded) {
    if (!stopAutoStartService()) {
      consola.error('Failed to stop the previous launchd service before updating it')
      pendingInstall = undefined
      return false
    }
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' })
    }
    catch (error) {
      consola.error('Failed to unload the previous launchd service before updating it:', error instanceof Error ? error.message : error)
      if (!rollbackAutoStartInstall())
        throw new Error('Failed to unload launchd service and restore the previous definition', { cause: error })
      return false
    }
  }

  try {
    writeFileAtomically(PLIST_PATH, plist, previousPlist?.mode ?? 0o600)
  }
  catch (error) {
    consola.error('Failed to write launchd plist:', error instanceof Error ? error.message : error)
    if (!rollbackAutoStartInstall())
      throw new Error('Failed to write launchd plist and roll back the previous definition', { cause: error })
    return false
  }

  try {
    execFileSync('launchctl', ['load', PLIST_PATH])
  }
  catch {
    consola.error('launchctl load failed. You may need to load it manually.')
    consola.info(`Plist written to: ${PLIST_PATH}`)
    if (!rollbackAutoStartInstall())
      throw new Error('launchctl load failed and the previous definition could not be restored')
    return false
  }

  consola.success('Auto-start enabled via launchd')
  return true
}

interface ExistingPlist {
  content: Uint8Array
  mode: number
}

function readExistingPlist(): ExistingPlist | undefined {
  try {
    const stat = fs.statSync(PLIST_PATH)
    return {
      content: fs.readFileSync(PLIST_PATH),
      mode: stat.mode & 0o777,
    }
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

function rollbackPlist(previous: ExistingPlist | undefined): boolean {
  try {
    if (previous) {
      writeFileAtomically(PLIST_PATH, previous.content, previous.mode)
    }
    else {
      fs.rmSync(PLIST_PATH, { force: true })
    }
    return true
  }
  catch (error) {
    consola.error('Failed to roll back launchd plist installation:', error instanceof Error ? error.message : error)
    return false
  }
}

export function commitAutoStartInstall(): void {
  pendingInstall = undefined
}

export function rollbackAutoStartInstall(): boolean {
  const install = pendingInstall
  if (!install)
    return true

  if (isLaunchdJobLoaded()) {
    if (!stopAutoStartService())
      return false
    try {
      execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' })
    }
    catch (error) {
      consola.error('Failed to unload replacement launchd service during rollback:', error instanceof Error ? error.message : error)
      return false
    }
  }
  if (!rollbackPlist(install.previous))
    return false
  pendingInstall = undefined
  return true
}

export function isAutoStartInstalled(): boolean {
  try {
    fs.statSync(PLIST_PATH)
    return true
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}

export function stopAutoStartService(): boolean {
  if (!isAutoStartInstalled())
    return false

  try {
    execFileSync('launchctl', ['stop', LABEL], { stdio: 'inherit' })
    if (waitForLaunchdStop())
      return true

    consola.warn('launchd service did not stop after the graceful deadline; forcing it down')
    execFileSync('launchctl', ['kill', 'SIGKILL', launchdTarget(process.getuid?.())], { stdio: 'inherit' })
    return waitForLaunchdStop()
  }
  catch (error) {
    if (waitForLaunchdStop())
      return true
    consola.error('Failed to stop launchd service:', error instanceof Error ? error.message : error)
    return false
  }
}

export function restartAutoStartService(): boolean {
  if (!isAutoStartInstalled())
    return false

  if (!stopAutoStartService())
    return false

  rotateDaemonLogIfNeeded()
  ensureDaemonLogFile()

  const uid = process.getuid?.()
  const target = launchdTarget(uid)
  try {
    // A previously disabled job stays disabled across load/bootstrap. Re-enable
    // the exact GUI-domain target before kickstarting it.
    execFileSync('launchctl', buildLaunchctlEnableArgs(uid), { stdio: 'inherit' })
    execFileSync('launchctl', buildLaunchctlKickstartArgs(uid), { stdio: 'inherit' })
    return true
  }
  catch (kickstartError) {
    // The plist may exist while the job is not currently loaded. Load it and
    // retry the same domain-qualified kickstart once.
    try {
      execFileSync('launchctl', ['load', PLIST_PATH], { stdio: 'inherit' })
      execFileSync('launchctl', ['enable', target], { stdio: 'inherit' })
      execFileSync('launchctl', buildLaunchctlKickstartArgs(uid), { stdio: 'inherit' })
      return true
    }
    catch (error) {
      consola.error('Failed to kickstart launchd service:', error instanceof Error ? error.message : error)
      consola.debug('Initial launchd kickstart failure:', kickstartError)
      return false
    }
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
  return ['kickstart', '-k', launchdTarget(uid)]
}

export function buildLaunchctlEnableArgs(uid?: number): string[] {
  return ['enable', launchdTarget(uid)]
}

export function buildLaunchctlDisableArgs(uid?: number): string[] {
  return ['disable', launchdTarget(uid)]
}

export function isLaunchdJobEnabledOutput(output: string): boolean {
  const escapedLabel = LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`"?${escapedLabel}"?\\s*=>\\s*(true|false)`, 'i').exec(output)
  // launchd lists only explicit overrides. An absent label uses the plist's
  // default enabled state.
  return match?.[1].toLowerCase() !== 'true'
}

function launchdTarget(uid?: number): string {
  return typeof uid === 'number' ? `gui/${uid}/${LABEL}` : LABEL
}

export function isLaunchdJobRunningOutput(output: string): boolean {
  return /^\s*state\s*=\s*running\s*$/m.test(output)
}

function waitForLaunchdStop(): boolean {
  const deadline = Date.now() + LAUNCHD_STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const query = queryLaunchdJob()
    if (query.state === 'not_loaded')
      return true
    if (query.state === 'unknown')
      return false
    if (!isLaunchdJobRunningOutput(query.output))
      return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  return false
}

function isLaunchdJobLoaded(): boolean {
  const query = queryLaunchdJob()
  if (query.state === 'unknown')
    throw new Error(`Cannot determine launchd job state: ${query.detail}`)
  return query.state === 'loaded'
}

function inspectLaunchdJob(): { loaded: boolean, running: boolean } {
  const query = queryLaunchdJob()
  if (query.state === 'unknown')
    throw new Error(`Cannot determine launchd job state: ${query.detail}`)
  return {
    loaded: query.state === 'loaded',
    running: query.state === 'loaded' && isLaunchdJobRunningOutput(query.output),
  }
}

function isLaunchdJobEnabled(): boolean {
  const uid = process.getuid?.()
  if (typeof uid !== 'number')
    throw new Error('Cannot determine the launchd GUI domain without a user id')
  const output = execFileSync(
    'launchctl',
    ['print-disabled', `gui/${uid}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return isLaunchdJobEnabledOutput(output)
}

function runLaunchctlStateCommand(args: string[]): boolean {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' })
    return true
  }
  catch (error) {
    consola.error('Failed to restore previous launchd enabled state:', error instanceof Error ? error.message : error)
    return false
  }
}

function queryLaunchdJob():
  | { state: 'loaded', output: string }
  | { state: 'not_loaded' }
  | { state: 'unknown', detail: string } {
  const result = spawnSync('launchctl', ['print', launchdTarget(process.getuid?.())], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error)
    return { state: 'unknown', detail: result.error.message }
  if (result.status === 0)
    return { state: 'loaded', output: result.stdout }

  const detail = `${result.stdout}\n${result.stderr}`.trim()
  if (/could not find service|service not found|no such process/i.test(detail)) {
    return { state: 'not_loaded' }
  }
  return {
    state: 'unknown',
    detail: detail || `launchctl exited with status ${result.status ?? 'unknown'}`,
  }
}

export async function uninstallAutoStart(options: UninstallAutoStartOptions = {}): Promise<boolean> {
  const isInstalled = options.isInstalled ?? isAutoStartInstalled
  const isLoaded = options.isLoaded ?? isLaunchdJobLoaded
  const stop = options.stop ?? stopAutoStartService
  const unload = options.unload ?? (() => {
    execFileSync('launchctl', ['unload', PLIST_PATH], { stdio: 'pipe' })
  })
  const removeDefinition = options.removeDefinition ?? (() => fs.unlinkSync(PLIST_PATH))

  if (!isInstalled()) {
    consola.info('Auto-start service is not installed')
    return true
  }

  if (isLoaded()) {
    if (!stop()) {
      consola.error('Failed to stop launchd service; keeping its plist installed')
      return false
    }
    try {
      unload()
    }
    catch (error) {
      consola.error('Failed to unload service; keeping its plist installed:', error instanceof Error ? error.message : error)
      return false
    }
  }

  try {
    removeDefinition()
  }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      consola.error('Failed to remove plist file:', error.message)
      return false
    }
  }

  if (isInstalled()) {
    consola.error('Failed to remove plist file: file still exists after deletion')
    return false
  }

  consola.success('Auto-start disabled')
  return true
}
