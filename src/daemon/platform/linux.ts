import type { NativeServiceActivationState } from '~/daemon/native-service'

import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'
import { writeFileAtomically } from '~/daemon/atomic-file'
import { NATIVE_SERVICE_DEFINITION_PATH_ENV } from '~/daemon/service-install-state'
import { getUserHomeDir } from '~/lib/paths'

const SERVICE_NAME = 'copilot-proxy'
const SERVICE_PATH = process.env[NATIVE_SERVICE_DEFINITION_PATH_ENV]
  || path.join(getSystemdUserServiceDir(), `${SERVICE_NAME}.service`)
const SERVICE_DIR = path.dirname(SERVICE_PATH)
let pendingInstall: { previous: ExistingServiceFile | undefined } | undefined

export interface UninstallAutoStartOptions {
  isInstalled?: () => boolean
  stop?: () => void
  disable?: () => void
  removeDefinition?: () => void
  reload?: () => void
}

export interface SystemdAutoStartStateOptions {
  isInstalled?: () => boolean
  readProperty?: (property: string) => string
  enable?: () => boolean
  disable?: () => boolean
  restart?: () => boolean
  reload?: () => boolean
  stop?: () => boolean
}

const SYSTEMD_ENABLED_STATES = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime', 'alias'])
const SYSTEMD_RUNNING_STATES = new Set(['active', 'activating', 'reloading'])

export function captureAutoStartState(
  options: Pick<SystemdAutoStartStateOptions, 'isInstalled' | 'readProperty'> = {},
): NativeServiceActivationState {
  const isInstalled = options.isInstalled ?? isAutoStartInstalled
  if (!isInstalled())
    return { installed: false, enabled: false, running: false }

  const readProperty = options.readProperty ?? readSystemdProperty
  const activeState = readProperty('ActiveState')
  const unitFileState = readProperty('UnitFileState')
  if (!activeState || !unitFileState)
    throw new Error('Cannot determine the existing systemd service state')

  return {
    installed: true,
    enabled: SYSTEMD_ENABLED_STATES.has(unitFileState),
    running: SYSTEMD_RUNNING_STATES.has(activeState),
  }
}

export function restoreAutoStartState(
  state: NativeServiceActivationState,
  options: Omit<SystemdAutoStartStateOptions, 'readProperty'> = {},
): boolean {
  const reload = options.reload ?? (() => runSystemctl(['daemon-reload'], 'Failed to reload the restored systemd definition'))
  if (!reload())
    return false
  if (!state.installed)
    return true

  const enable = options.enable ?? (() => runSystemctl(['enable', SERVICE_PATH], 'Failed to restore enabled systemd state'))
  const disable = options.disable ?? (() => runSystemctl(['disable', SERVICE_NAME], 'Failed to restore disabled systemd state'))
  const restart = options.restart ?? restartAutoStartService
  const stop = options.stop ?? stopAutoStartService
  const restoreEnablement = state.enabled ? enable : disable

  if (state.running) {
    if (!restoreEnablement())
      return false
    return restart()
  }

  if (!stop())
    return false
  return restoreEnablement()
}

export function shellQuote(s: string): string {
  if (/[\r\n]/.test(s))
    throw new Error('systemd unit arguments cannot contain newlines')

  // Escape systemd specifiers and environment expansion.
  const escaped = s.replace(/\\/g, '\\\\').replace(/%/g, '%%').replace(/\$/g, '$$$$')
  if (/^[\w/.:-]+$/.test(escaped))
    return escaped
  return `"${escaped.replace(/"/g, '\\"')}"`
}

export function getSystemdUserServiceDir(
  env: NodeJS.ProcessEnv = process.env,
  userHome = getUserHomeDir(env),
): string {
  const configuredHome = env.XDG_CONFIG_HOME?.trim()
  const configHome = configuredHome && path.isAbsolute(configuredHome)
    ? configuredHome
    : path.join(userHome, '.config')
  return path.join(configHome, 'systemd', 'user')
}

export function buildSystemdUnit(execPath: string, args: string[]): string {
  return `[Unit]
Description=Copilot API Proxy
After=network-online.target

[Service]
ExecStart=${shellQuote(execPath)} ${args.map(a => shellQuote(a)).join(' ')}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

export function shellQuoteForHelp(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export async function installAutoStart(execPath: string, args: string[]): Promise<boolean> {
  try {
    execSync('which systemctl', { stdio: 'pipe' })
  }
  catch {
    consola.error('systemctl not found. Cannot register systemd service.')
    consola.info('You may need to manually configure auto-start for your init system.')
    return false
  }

  let unit: string
  try {
    unit = buildSystemdUnit(execPath, args)
  }
  catch (error) {
    consola.error('Failed to build systemd service file:', error instanceof Error ? error.message : error)
    return false
  }

  const previousUnit = readExistingServiceFile()
  pendingInstall = { previous: previousUnit }
  const rollback = () => {
    const restored = rollbackServiceFile(previousUnit)
    if (restored)
      pendingInstall = undefined
    return restored
  }

  try {
    fs.mkdirSync(SERVICE_DIR, { recursive: true })
    writeFileAtomically(SERVICE_PATH, unit, 0o600)
  }
  catch (error) {
    consola.error('Failed to write systemd service file:', error instanceof Error ? error.message : error)
    if (!rollback())
      throw new Error('Failed to write systemd service file and roll back the previous definition', { cause: error })
    return false
  }

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
  }
  catch {
    consola.error('Failed to reload systemd. Is systemd running in user mode?')
    consola.info('On WSL2, you may need to enable systemd: https://learn.microsoft.com/en-us/windows/wsl/systemd')
    if (!rollback())
      throw new Error('Failed to reload systemd and roll back the previous definition')
    return false
  }

  const username = os.userInfo().username
  if (!ensureUserLingerEnabled(username)) {
    if (!rollback())
      throw new Error('Failed to enable user lingering and roll back the previous systemd definition')
    return false
  }

  try {
    // The user manager may have started before the caller's current
    // XDG_CONFIG_HOME existed, so enabling by unit name can miss a valid unit
    // at a persisted custom path. systemctl accepts an absolute unit path and
    // creates the manager-visible link needed for subsequent name-based
    // start/stop/status commands.
    execFileSync('systemctl', ['--user', 'enable', SERVICE_PATH], { stdio: 'pipe' })
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to enable service:', error instanceof Error ? error.message : error)
    consola.info(`Service file written to: ${SERVICE_PATH}`)
    consola.info('You can try manually: systemctl --user enable copilot-proxy')
    if (!rollback())
      throw new Error('Failed to enable systemd service and roll back the previous definition', { cause: error })
    return false
  }

  consola.success('Auto-start enabled via systemd')
  return true
}

interface ExistingServiceFile {
  content: Uint8Array
  mode: number
}

function readExistingServiceFile(): ExistingServiceFile | undefined {
  try {
    const stat = fs.statSync(SERVICE_PATH)
    return {
      content: fs.readFileSync(SERVICE_PATH),
      mode: stat.mode & 0o777,
    }
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw error
  }
}

function rollbackServiceFile(previous: ExistingServiceFile | undefined): boolean {
  try {
    if (previous) {
      fs.mkdirSync(SERVICE_DIR, { recursive: true })
      writeFileAtomically(SERVICE_PATH, previous.content, previous.mode)
    }
    else {
      // `systemctl enable` may create the wants/ symlink before returning a
      // non-zero exit. Stop and disable so a failed fresh install cannot leave
      // a process or ghost auto-start reference behind.
      if (!stopSystemdServiceForRollback())
        return false
      if (!disableSystemdServiceForRollback())
        return false
      fs.rmSync(SERVICE_PATH, { force: true })
    }
    return true
  }
  catch (error) {
    consola.error('Failed to roll back systemd service installation:', error instanceof Error ? error.message : error)
    return false
  }
}

function stopSystemdServiceForRollback(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'stop', SERVICE_NAME], { stdio: 'pipe' })
    return true
  }
  catch (error) {
    // A failure before daemon-reload/activation is safe only when systemd can
    // explicitly confirm that the unit is inactive or unknown.
    const activeState = querySystemdProperty('ActiveState', error)
    return activeState === 'inactive' || activeState === 'failed'
  }
}

function disableSystemdServiceForRollback(): boolean {
  try {
    execFileSync('systemctl', ['--user', 'disable', SERVICE_NAME], { stdio: 'pipe' })
    return true
  }
  catch (error) {
    const unitFileState = querySystemdProperty('UnitFileState', error)
    if (unitFileState === 'disabled')
      return true
    return querySystemdProperty('LoadState', error) === 'not-found'
  }
}

function querySystemdProperty(property: string, originalError: unknown): string | undefined {
  try {
    return readSystemdProperty(property)
  }
  catch {
    consola.error('Cannot confirm systemd rollback safety after a control failure:', originalError instanceof Error ? originalError.message : originalError)
    return undefined
  }
}

function readSystemdProperty(property: string): string {
  return execFileSync(
    'systemctl',
    ['--user', 'show', SERVICE_NAME, `--property=${property}`, '--value'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

export function commitAutoStartInstall(): void {
  pendingInstall = undefined
}

export function rollbackAutoStartInstall(): boolean {
  const install = pendingInstall
  if (!install)
    return true

  if (!rollbackServiceFile(install.previous))
    return false
  if (!install.previous) {
    pendingInstall = undefined
    return true
  }
  pendingInstall = undefined
  return true
}

function ensureUserLingerEnabled(username: string): boolean {
  if (isUserLingerEnabled(username))
    return true

  try {
    execFileSync('loginctl', ['enable-linger', username], { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to enable systemd user lingering:', error instanceof Error ? error.message : error)
    consola.info('Logged-out startup requires lingering for the target user.')
    consola.info(`Run manually, then retry: sudo loginctl enable-linger ${shellQuoteForHelp(username)}`)
    return false
  }

  if (isUserLingerEnabled(username))
    return true

  consola.error('systemd user lingering still appears disabled after loginctl enable-linger.')
  consola.info(`Run manually, then retry: sudo loginctl enable-linger ${shellQuoteForHelp(username)}`)
  return false
}

function isUserLingerEnabled(username: string): boolean {
  try {
    const value = execFileSync(
      'loginctl',
      ['show-user', username, '--property=Linger', '--value'],
      { stdio: 'pipe', encoding: 'utf8' },
    ).trim()
    return value === 'yes'
  }
  catch {
    return false
  }
}

export function isAutoStartInstalled(): boolean {
  try {
    fs.statSync(SERVICE_PATH)
    return true
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false
    throw error
  }
}

export function stopAutoStartService(): boolean {
  return runSystemctl(['stop', SERVICE_NAME], 'Failed to stop systemd service')
}

export function restartAutoStartService(): boolean {
  return runSystemctl(['restart', SERVICE_NAME], 'Failed to restart systemd service')
}

export function showAutoStartStatus(): boolean {
  if (!isAutoStartInstalled())
    return false

  try {
    execFileSync('systemctl', ['--user', 'status', SERVICE_NAME, '--no-pager', '-l'], { stdio: 'inherit' })
  }
  catch {
    // `systemctl status` exits non-zero for inactive/failed units after printing
    // the useful status output. Treat that as handled so we do not fall back to
    // the legacy PID-file daemon and report conflicting state.
  }
  return true
}

export function showAutoStartLogs(options: { follow: boolean, lines: number }): boolean {
  if (!isAutoStartInstalled())
    return false

  const args = ['--user', '-u', SERVICE_NAME, '-n', String(options.lines), '--no-pager']
  if (options.follow)
    args.push('-f')

  try {
    execFileSync('journalctl', args, { stdio: 'inherit' })
    return true
  }
  catch (error) {
    consola.warn('Failed to read systemd journal:', error instanceof Error ? error.message : error)
    return false
  }
}

function runSystemctl(args: string[], failureMessage: string): boolean {
  try {
    execFileSync('systemctl', ['--user', ...args], { stdio: 'inherit' })
    return true
  }
  catch (error) {
    consola.error(failureMessage, error instanceof Error ? error.message : error)
    return false
  }
}

export async function uninstallAutoStart(options: UninstallAutoStartOptions = {}): Promise<boolean> {
  const isInstalled = options.isInstalled ?? (() => fs.existsSync(SERVICE_PATH))
  const stop = options.stop ?? (() => {
    execFileSync('systemctl', ['--user', 'stop', SERVICE_NAME], { stdio: 'pipe' })
  })
  const disable = options.disable ?? (() => {
    execFileSync('systemctl', ['--user', 'disable', SERVICE_NAME], { stdio: 'pipe' })
  })
  const removeDefinition = options.removeDefinition ?? (() => fs.unlinkSync(SERVICE_PATH))
  const reload = options.reload ?? (() => {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
  })

  if (!isInstalled()) {
    consola.info('Auto-start service is not installed')
    return true
  }

  try {
    stop()
  }
  catch (error) {
    consola.error('Failed to stop systemd service; keeping its definition installed:', error instanceof Error ? error.message : error)
    return false
  }

  try {
    disable()
  }
  catch (error) {
    consola.error('Failed to disable systemd service; keeping its unit file installed:', error instanceof Error ? error.message : error)
    return false
  }

  try {
    removeDefinition()
  }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      consola.error('Failed to remove service file:', error.message)
      return false
    }
  }

  if (isInstalled()) {
    consola.error('Failed to remove systemd service file: file still exists after deletion')
    return false
  }

  try {
    reload()
  }
  catch (error) {
    consola.warn('Failed to reload systemd:', error instanceof Error ? error.message : error)
    return false
  }

  consola.success('Auto-start disabled')
  return true
}
