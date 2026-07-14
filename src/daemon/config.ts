import fs from 'node:fs'
import path from 'node:path'

import consola from 'consola'
import { writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'
import { resolveConcurrencyLimitConfig } from '~/lib/concurrency-limiter'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'
import { PATHS } from '~/lib/paths'
import { DEFAULT_HOST } from '~/lib/security'

export interface DaemonConfig {
  port: number
  host: string
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  maxConcurrency?: number
  maxQueue?: number
  queueTimeoutMs?: number
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
  connectTimeoutMs?: number
  githubToken?: string
  showToken: boolean
  proxyEnv: boolean
}

const VALID_ACCOUNT_TYPES = ['individual', 'business', 'enterprise']
export const MAX_DAEMON_CONFIG_BACKUPS = 5

export const DEFAULT_SERVICE_CONFIG: DaemonConfig = {
  port: 4399,
  host: DEFAULT_HOST,
  verbose: false,
  accountType: 'individual',
  manual: false,
  rateLimitWait: false,
  showToken: false,
  proxyEnv: false,
}

export type DaemonConfigRecoveryReason = 'missing' | 'invalid' | 'unreadable'

export interface DaemonConfigRecoveryResult {
  config: DaemonConfig
  recovered: boolean
  persisted: boolean
  reason?: DaemonConfigRecoveryReason
  backupPath?: string
}

export function mergeDaemonConfigWithExplicitFlags(
  fileConfig: DaemonConfig,
  cliConfig: DaemonConfig,
  rawArgs: string[],
): DaemonConfig {
  const merged: DaemonConfig = { ...fileConfig }

  if (wasCliOptionPassed(rawArgs, 'port', 'p'))
    merged.port = cliConfig.port
  if (wasCliOptionPassed(rawArgs, 'host', 'H'))
    merged.host = cliConfig.host
  if (wasCliOptionPassed(rawArgs, 'verbose', 'v', true))
    merged.verbose = cliConfig.verbose
  if (wasCliOptionPassed(rawArgs, 'account-type', 'a'))
    merged.accountType = cliConfig.accountType
  if (wasCliOptionPassed(rawArgs, 'manual', undefined, true))
    merged.manual = cliConfig.manual
  if (wasCliOptionPassed(rawArgs, 'rate-limit', 'r'))
    merged.rateLimit = cliConfig.rateLimit
  if (wasCliOptionPassed(rawArgs, 'wait', 'w', true))
    merged.rateLimitWait = cliConfig.rateLimitWait
  if (wasCliOptionPassed(rawArgs, 'max-concurrency'))
    merged.maxConcurrency = cliConfig.maxConcurrency
  if (wasCliOptionPassed(rawArgs, 'max-queue'))
    merged.maxQueue = cliConfig.maxQueue
  if (wasCliOptionPassed(rawArgs, 'queue-timeout-ms'))
    merged.queueTimeoutMs = cliConfig.queueTimeoutMs
  if (wasCliOptionPassed(rawArgs, 'headers-timeout-ms'))
    merged.headersTimeoutMs = cliConfig.headersTimeoutMs
  if (wasCliOptionPassed(rawArgs, 'body-timeout-ms'))
    merged.bodyTimeoutMs = cliConfig.bodyTimeoutMs
  if (wasCliOptionPassed(rawArgs, 'connect-timeout-ms'))
    merged.connectTimeoutMs = cliConfig.connectTimeoutMs
  if (wasCliOptionPassed(rawArgs, 'github-token', 'g'))
    merged.githubToken = cliConfig.githubToken
  if (wasCliOptionPassed(rawArgs, 'show-token', undefined, true))
    merged.showToken = cliConfig.showToken
  if (wasCliOptionPassed(rawArgs, 'proxy-env', undefined, true))
    merged.proxyEnv = cliConfig.proxyEnv

  return merged
}

export function saveDaemonConfig(
  config: DaemonConfig,
  filePath: string = PATHS.DAEMON_JSON,
): void {
  const { githubToken: _removed, ...safeConfig } = config
  writeOwnerOnlyFileAtomically(filePath, JSON.stringify(safeConfig, null, 2))
}

export function loadDaemonConfig(): DaemonConfig | null {
  try {
    const content = fs.readFileSync(PATHS.DAEMON_JSON, 'utf8')
    const data = JSON.parse(content) as Record<string, unknown>
    return validateDaemonConfig(data)
  }
  catch {
    return null
  }
}

export function loadDaemonConfigWithRecovery(fallbackConfig: DaemonConfig): DaemonConfigRecoveryResult {
  let reason: DaemonConfigRecoveryReason = 'unreadable'
  let backupPath: string | undefined

  try {
    const content = fs.readFileSync(PATHS.DAEMON_JSON, 'utf8')

    try {
      const data = JSON.parse(content) as Record<string, unknown>
      const validConfig = validateDaemonConfig(data)
      if (validConfig) {
        return {
          config: validConfig,
          recovered: false,
          persisted: false,
        }
      }
      reason = 'invalid'
    }
    catch (error) {
      consola.debug('Failed to parse daemon config JSON:', error)
      reason = 'invalid'
    }

    backupPath = backupDaemonConfigFile()
  }
  catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (code === 'ENOENT') {
      reason = 'missing'
    }
    else {
      reason = 'unreadable'
      backupPath = backupDaemonConfigFile()
    }
  }

  try {
    saveDaemonConfig(fallbackConfig)
    return {
      config: fallbackConfig,
      recovered: true,
      persisted: true,
      reason,
      backupPath,
    }
  }
  catch (error) {
    consola.warn('Failed to persist recovered daemon config:', error)
    return {
      config: fallbackConfig,
      recovered: true,
      persisted: false,
      reason,
      backupPath,
    }
  }
}

function wasCliOptionPassed(
  rawArgs: string[],
  name: string,
  alias?: string,
  booleanFlag = false,
): boolean {
  const longFlag = `--${name}`
  const negatedLongFlag = `--no-${name}`
  const shortFlag = alias ? `-${alias}` : undefined

  for (const arg of rawArgs) {
    if (arg === '--') {
      break
    }

    if (arg === longFlag || arg.startsWith(`${longFlag}=`)) {
      return true
    }

    if (booleanFlag && (arg === negatedLongFlag || arg.startsWith(`${negatedLongFlag}=`))) {
      return true
    }

    if (shortFlag && (arg === shortFlag || arg.startsWith(`${shortFlag}=`))) {
      return true
    }
  }

  return false
}

function validateDaemonConfig(data: Record<string, unknown>): DaemonConfig | null {
  // Runtime validation of critical fields
  if (typeof data.port !== 'number' || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535)
    return null
  if (data.host === undefined)
    data.host = DEFAULT_HOST
  if (typeof data.host !== 'string' || !data.host.trim() || /[\s/]/.test(data.host))
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
  if (data.rateLimit !== undefined && (typeof data.rateLimit !== 'number' || !Number.isInteger(data.rateLimit) || data.rateLimit <= 0 || data.rateLimit > 86400))
    return null
  try {
    resolveConcurrencyLimitConfig({
      maxConcurrency: data.maxConcurrency as number | undefined,
      maxQueue: data.maxQueue as number | undefined,
      queueTimeoutMs: data.queueTimeoutMs as number | undefined,
    })
  }
  catch {
    return null
  }
  if (isInvalidTimeout(data.headersTimeoutMs))
    return null
  if (isInvalidTimeout(data.bodyTimeoutMs))
    return null
  if (isInvalidTimeout(data.connectTimeoutMs))
    return null
  if (data.githubToken !== undefined && typeof data.githubToken !== 'string')
    return null

  return data as unknown as DaemonConfig
}

function isInvalidTimeout(value: unknown): boolean {
  return value !== undefined
    && (typeof value !== 'number'
      || !Number.isInteger(value)
      || value < 0
      || value > MAX_TIMER_DELAY_MS)
}

function backupDaemonConfigFile(): string | undefined {
  if (!fs.existsSync(PATHS.DAEMON_JSON))
    return undefined

  const backupPath = `${PATHS.DAEMON_JSON}.bak.${Date.now()}`
  try {
    fs.renameSync(PATHS.DAEMON_JSON, backupPath)
    // Clamp backup file perms to user-only in case source file was overly permissive.
    try {
      fs.chmodSync(backupPath, 0o600)
    }
    catch {}
    pruneOldDaemonConfigBackups()
    return backupPath
  }
  catch {
    return undefined
  }
}

function pruneOldDaemonConfigBackups(): void {
  try {
    const backups = fs.readdirSync(PATHS.APP_DIR)
      .filter(name => /^daemon\.json\.bak\.\d+$/.test(name))
      .sort((a, b) => {
        const aTs = Number.parseInt(a.slice('daemon.json.bak.'.length), 10)
        const bTs = Number.parseInt(b.slice('daemon.json.bak.'.length), 10)
        return bTs - aTs
      })

    for (const backupName of backups.slice(MAX_DAEMON_CONFIG_BACKUPS)) {
      try {
        fs.unlinkSync(path.join(PATHS.APP_DIR, backupName))
      }
      catch {}
    }
  }
  catch {}
}
