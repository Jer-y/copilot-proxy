import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import consola from 'consola'

import { PATHS } from '~/lib/paths'

const SERVICE_NAME = 'copilot-proxy'
const SERVICE_DIR = path.join(os.homedir(), '.config', 'systemd', 'user')
const SERVICE_PATH = path.join(SERVICE_DIR, `${SERVICE_NAME}.service`)

function shellQuote(s: string): string {
  // Escape % for systemd (% is a specifier prefix in unit files)
  const escaped = s.replace(/%/g, '%%')
  if (/^[\w/.:-]+$/.test(escaped))
    return escaped
  return `"${escaped.replace(/"/g, '\\"')}"`
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

  const unit = `[Unit]
Description=Copilot API Proxy
After=network-online.target

[Service]
ExecStart=${shellQuote(execPath)} ${args.map(a => shellQuote(a)).join(' ')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${PATHS.DAEMON_LOG.replace(/%/g, '%%')}
StandardError=append:${PATHS.DAEMON_LOG.replace(/%/g, '%%')}

[Install]
WantedBy=default.target
`

  fs.mkdirSync(SERVICE_DIR, { recursive: true })
  fs.writeFileSync(SERVICE_PATH, unit)

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' })
  }
  catch {
    consola.error('Failed to reload systemd. Is systemd running in user mode?')
    consola.info('On WSL2, you may need to enable systemd: https://learn.microsoft.com/en-us/windows/wsl/systemd')
    return false
  }

  try {
    execSync(`systemctl --user enable --now ${SERVICE_NAME}`, { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to enable service:', error instanceof Error ? error.message : error)
    consola.info(`Service file written to: ${SERVICE_PATH}`)
    consola.info('You can try manually: systemctl --user enable --now copilot-proxy')
    return false
  }

  try {
    execSync(`loginctl enable-linger ${os.userInfo().username}`)
  }
  catch {
    consola.warn('Could not enable linger. Service may not run when logged out.')
  }

  consola.success('Auto-start enabled via systemd')
  return true
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
