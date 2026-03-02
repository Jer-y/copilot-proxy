import fs from 'node:fs'

import { PATHS } from '~/lib/paths'

export interface DaemonConfig {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  showToken: boolean
  proxyEnv: boolean
}

const VALID_ACCOUNT_TYPES = ['individual', 'business', 'enterprise']

export function saveDaemonConfig(config: DaemonConfig): void {
  const { githubToken: _removed, ...safeConfig } = config
  fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
  fs.writeFileSync(PATHS.DAEMON_JSON, JSON.stringify(safeConfig, null, 2), { mode: 0o600 })
  // Ensure permissions are correct even if file already existed with wider perms
  try {
    fs.chmodSync(PATHS.DAEMON_JSON, 0o600)
  }
  catch {}
}

export function loadDaemonConfig(): DaemonConfig | null {
  try {
    const content = fs.readFileSync(PATHS.DAEMON_JSON, 'utf8')
    const data = JSON.parse(content) as Record<string, unknown>

    // Runtime validation of critical fields
    if (typeof data.port !== 'number' || data.port <= 0 || data.port > 65535)
      return null
    if (typeof data.verbose !== 'boolean')
      return null
    if (typeof data.accountType !== 'string' || !VALID_ACCOUNT_TYPES.includes(data.accountType))
      return null
    if (typeof data.manual !== 'boolean')
      return null
    if (typeof data.rateLimitWait !== 'boolean')
      return null
    if (typeof data.showToken !== 'boolean')
      return null
    if (typeof data.proxyEnv !== 'boolean')
      return null
    if (data.rateLimit !== undefined && (typeof data.rateLimit !== 'number' || data.rateLimit <= 0))
      return null

    return data as unknown as DaemonConfig
  }
  catch {
    return null
  }
}
