import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import consola from 'consola'
import { getUserHomeDir } from '~/lib/paths'

const SERVICE_NAME = 'copilot-proxy'
const SERVICE_DIR = path.join(getUserHomeDir(), '.config', 'systemd', 'user')
const SERVICE_PATH = path.join(SERVICE_DIR, `${SERVICE_NAME}.service`)
let pendingInstall: { previous: ExistingServiceFile | undefined } | undefined

export function shellQuote(s: string): string {
  if (/[\r\n]/.test(s))
    throw new Error('systemd unit arguments cannot contain newlines')

  // Escape systemd specifiers and environment expansion.
  const escaped = s.replace(/%/g, '%%').replace(/\$/g, '$$$$')
  if (/^[\w/.:-]+$/.test(escaped))
    return escaped
  return `"${escaped.replace(/"/g, '\\"')}"`
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
  const rollback = () => rollbackServiceFile(previousUnit)

  try {
    fs.mkdirSync(SERVICE_DIR, { recursive: true })
    fs.writeFileSync(SERVICE_PATH, unit)
  }
  catch (error) {
    consola.error('Failed to write systemd service file:', error instanceof Error ? error.message : error)
    rollback()
    return false
  }

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
  }
  catch {
    consola.error('Failed to reload systemd. Is systemd running in user mode?')
    consola.info('On WSL2, you may need to enable systemd: https://learn.microsoft.com/en-us/windows/wsl/systemd')
    rollback()
    return false
  }

  const username = os.userInfo().username
  if (!ensureUserLingerEnabled(username)) {
    rollback()
    return false
  }

  try {
    execSync(`systemctl --user enable ${SERVICE_NAME}`, { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to enable service:', error instanceof Error ? error.message : error)
    consola.info(`Service file written to: ${SERVICE_PATH}`)
    consola.info('You can try manually: systemctl --user enable copilot-proxy')
    rollback()
    return false
  }

  pendingInstall = { previous: previousUnit }
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
      fs.writeFileSync(SERVICE_PATH, previous.content, { mode: previous.mode })
      fs.chmodSync(SERVICE_PATH, previous.mode)
    }
    else {
      // `systemctl enable` may create the wants/ symlink before returning a
      // non-zero exit. Disable first so a failed fresh install cannot leave a
      // ghost auto-start reference to the unit we are about to remove.
      try {
        execFileSync('systemctl', ['--user', 'disable', SERVICE_NAME], { stdio: 'pipe' })
      }
      catch {
        // No symlink is the expected case for failures before the enable step.
      }
      fs.rmSync(SERVICE_PATH, { force: true })
    }
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
    return true
  }
  catch (error) {
    consola.error('Failed to roll back systemd service installation:', error instanceof Error ? error.message : error)
    return false
  }
}

export function commitAutoStartInstall(): void {
  pendingInstall = undefined
}

export function rollbackAutoStartInstall(): boolean {
  const install = pendingInstall
  pendingInstall = undefined
  if (!install)
    return true

  if (!rollbackServiceFile(install.previous))
    return false
  if (!install.previous)
    return true

  try {
    execFileSync('systemctl', ['--user', 'enable', SERVICE_NAME], { stdio: 'pipe' })
    execFileSync('systemctl', ['--user', 'restart', SERVICE_NAME], { stdio: 'pipe' })
    return true
  }
  catch (error) {
    consola.error('Restored the previous systemd unit but failed to restart it:', error instanceof Error ? error.message : error)
    return false
  }
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
  return fs.existsSync(SERVICE_PATH)
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

export async function uninstallAutoStart(): Promise<boolean> {
  if (!fs.existsSync(SERVICE_PATH)) {
    consola.info('Auto-start service is not installed')
    return true
  }

  let hadErrors = false

  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' })
  }
  catch {
    // Service may not be running, that's fine
  }

  try {
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'pipe' })
  }
  catch (error) {
    consola.warn('Failed to disable service:', error instanceof Error ? error.message : error)
    hadErrors = true
  }

  try {
    fs.unlinkSync(SERVICE_PATH)
  }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      consola.error('Failed to remove service file:', error.message)
      return false
    }
  }

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
  }
  catch (error) {
    consola.warn('Failed to reload systemd:', error instanceof Error ? error.message : error)
    hadErrors = true
  }

  if (hadErrors) {
    consola.warn('Auto-start disabled with warnings')
    return false
  }

  consola.success('Auto-start disabled')
  return true
}
