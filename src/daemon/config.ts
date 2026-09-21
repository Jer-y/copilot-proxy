import fs from 'node:fs'
import path from 'node:path'

import { validateServiceConfig } from '~/daemon/service-install-state'
import { PATHS } from '~/lib/paths'
import { RUN_PRESETS } from '~/lib/run-presets'
import { DEFAULT_HOST } from '~/lib/security'

export interface ServiceConfig {
  port: number
  host: string
  verbose: boolean
  accountType: string
  rateLimit?: number
  rateLimitWait: boolean
  maxConcurrency?: number
  maxQueue?: number
  queueTimeoutMs?: number
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
  connectTimeoutMs?: number
  proxyEnv: boolean
}

export const UNBOUNDED_NATIVE_SERVICE_CONFIG: ServiceConfig = {
  port: 4399,
  host: DEFAULT_HOST,
  verbose: false,
  accountType: 'individual',
  rateLimitWait: false,
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
  return validateServiceConfig({ ...data, host: data.host ?? DEFAULT_HOST })
}
