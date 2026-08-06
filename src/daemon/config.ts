import fs from 'node:fs'
import path from 'node:path'

import { resolveConcurrencyLimitConfig } from '~/lib/concurrency-limiter'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'
import { PATHS } from '~/lib/paths'
import { RUN_PRESETS } from '~/lib/run-presets'
import { DEFAULT_HOST } from '~/lib/security'

export interface ServiceConfig {
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
  showToken: boolean
  proxyEnv: boolean
}

export const UNBOUNDED_NATIVE_SERVICE_CONFIG: ServiceConfig = {
  port: 4399,
  host: DEFAULT_HOST,
  verbose: false,
  accountType: 'individual',
  manual: false,
  rateLimitWait: false,
  showToken: false,
  proxyEnv: false,
}

export const DEFAULT_SERVICE_CONFIG: ServiceConfig = {
  ...UNBOUNDED_NATIVE_SERVICE_CONFIG,
  maxConcurrency: RUN_PRESETS.service.maxConcurrency,
  maxQueue: RUN_PRESETS.service.maxQueue,
  queueTimeoutMs: RUN_PRESETS.service.queueTimeoutMs,
}

export function loadLegacyServiceConfig(
  filePath: string = path.join(PATHS.APP_DIR, 'daemon.json'),
): ServiceConfig | undefined {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined
    throw new Error(`Pre-v0.10.0 service config is unreadable: ${filePath}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content) as unknown
  }
  catch (error) {
    throw new Error(`Pre-v0.10.0 service config is invalid: ${filePath}`, { cause: error })
  }

  const config = validateLegacyServiceConfig(parsed)
  if (!config)
    throw new Error(`Pre-v0.10.0 service config is invalid: ${filePath}`)
  return config
}

function validateLegacyServiceConfig(value: unknown): ServiceConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined

  const data = value as Record<string, unknown>
  const host = data.host ?? DEFAULT_HOST
  if (typeof data.port !== 'number' || !Number.isInteger(data.port) || data.port <= 0 || data.port > 65535)
    return undefined
  if (typeof host !== 'string' || !host.trim() || /[\s/]/.test(host))
    return undefined
  if (typeof data.verbose !== 'boolean')
    return undefined
  if (typeof data.accountType !== 'string' || !['individual', 'business', 'enterprise'].includes(data.accountType))
    return undefined
  if (typeof data.manual !== 'boolean'
    || typeof data.rateLimitWait !== 'boolean'
    || typeof data.showToken !== 'boolean'
    || typeof data.proxyEnv !== 'boolean') {
    return undefined
  }
  if (data.rateLimit !== undefined
    && (typeof data.rateLimit !== 'number' || !Number.isInteger(data.rateLimit) || data.rateLimit <= 0 || data.rateLimit > 86400)) {
    return undefined
  }
  try {
    resolveConcurrencyLimitConfig({
      maxConcurrency: data.maxConcurrency as number | undefined,
      maxQueue: data.maxQueue as number | undefined,
      queueTimeoutMs: data.queueTimeoutMs as number | undefined,
    })
  }
  catch {
    return undefined
  }
  for (const key of ['headersTimeoutMs', 'bodyTimeoutMs', 'connectTimeoutMs'] as const) {
    const timeout = data[key]
    if (timeout !== undefined
      && (typeof timeout !== 'number'
        || !Number.isInteger(timeout)
        || timeout < 0
        || timeout > MAX_TIMER_DELAY_MS)) {
      return undefined
    }
  }

  return {
    port: data.port,
    host,
    verbose: data.verbose,
    accountType: data.accountType,
    manual: data.manual,
    ...(typeof data.rateLimit === 'number' && { rateLimit: data.rateLimit }),
    rateLimitWait: data.rateLimitWait,
    ...(typeof data.maxConcurrency === 'number' && { maxConcurrency: data.maxConcurrency }),
    ...(typeof data.maxQueue === 'number' && { maxQueue: data.maxQueue }),
    ...(typeof data.queueTimeoutMs === 'number' && { queueTimeoutMs: data.queueTimeoutMs }),
    ...(typeof data.headersTimeoutMs === 'number' && { headersTimeoutMs: data.headersTimeoutMs }),
    ...(typeof data.bodyTimeoutMs === 'number' && { bodyTimeoutMs: data.bodyTimeoutMs }),
    ...(typeof data.connectTimeoutMs === 'number' && { connectTimeoutMs: data.connectTimeoutMs }),
    showToken: data.showToken,
    proxyEnv: data.proxyEnv,
  }
}
