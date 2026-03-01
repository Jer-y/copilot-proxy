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
  if (/^[\w/.:-]+$/.test(s))
    return s
  return `"${s.replace(/"/g, '\\"')}"`
}

export async function installAutoStart(execPath: string, args: string[]): Promise<void> {
  try {
    execSync('which systemctl', { stdio: 'pipe' })
  }
  catch {
    consola.error('systemctl not found. Cannot register systemd service.')
    consola.info('You may need to manually configure auto-start for your init system.')
    return
  }

  const unit = `[Unit]
Description=Copilot API Proxy
After=network-online.target

[Service]
ExecStart=${shellQuote(execPath)} ${args.map(a => shellQuote(a)).join(' ')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${PATHS.DAEMON_LOG}
StandardError=append:${PATHS.DAEMON_LOG}

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
    return
  }

  try {
    execSync(`systemctl --user enable --now ${SERVICE_NAME}`, { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to enable service:', error instanceof Error ? error.message : error)
    consola.info(`Service file written to: ${SERVICE_PATH}`)
    consola.info('You can try manually: systemctl --user enable --now copilot-proxy')
    return
  }

  try {
    execSync(`loginctl enable-linger ${os.userInfo().username}`)
  }
  catch {
    consola.warn('Could not enable linger. Service may not run when logged out.')
  }

  consola.success('Auto-start enabled via systemd')
}

export async function uninstallAutoStart(): Promise<void> {
  try {
    execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' })
    execSync(`systemctl --user disable ${SERVICE_NAME}`, { stdio: 'pipe' })
  }
  catch {}

  try {
    fs.unlinkSync(SERVICE_PATH)
  }
  catch {}

  try {
    execSync('systemctl --user daemon-reload')
  }
  catch {}

  consola.success('Auto-start disabled')
}
