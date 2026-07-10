import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { PATHS } from '~/lib/paths'
import { hasProxyEndpointEnvironment, PROXY_ENV_KEYS } from '~/lib/proxy-environment'

export const SERVICE_SECURITY_ENV_KEYS = [
  'COPILOT_PROXY_ALLOWED_HOSTS',
  'COPILOT_PROXY_CORS_ORIGINS',
  'COPILOT_PROXY_EXPOSE_TOKEN',
  'COPILOT_PROXY_MAX_JSON_BODY_BYTES',
  'COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH',
] as const

export const SERVICE_TLS_ENV_KEYS = [
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const

const MANAGED_SERVICE_ENV_KEYS = [
  ...SERVICE_SECURITY_ENV_KEYS,
  ...SERVICE_TLS_ENV_KEYS,
  ...PROXY_ENV_KEYS,
] as const

export interface NativeServiceEnvironmentOptions {
  proxyEnv: boolean
  sourceEnv?: NodeJS.ProcessEnv
  filePath?: string
}

export function hasProxyEndpoint(env: NodeJS.ProcessEnv): boolean {
  return hasProxyEndpointEnvironment(env)
}

export function assertProxyEndpointAvailable(env: NodeJS.ProcessEnv): void {
  if (!hasProxyEndpoint(env)) {
    throw new Error(
      '--proxy-env requires at least one non-empty HTTP_PROXY, HTTPS_PROXY, or ALL_PROXY setting (uppercase or lowercase). Refusing to fall back to a direct connection.',
    )
  }
}

export function saveNativeServiceEnvironment(
  options: NativeServiceEnvironmentOptions,
): void {
  const sourceEnv = options.sourceEnv ?? process.env
  const filePath = options.filePath ?? PATHS.NATIVE_SERVICE_ENV

  if (options.proxyEnv)
    assertProxyEndpointAvailable(sourceEnv)

  const saved: Record<string, string> = {}
  const allowedKeys = options.proxyEnv
    ? MANAGED_SERVICE_ENV_KEYS
    : [...SERVICE_SECURITY_ENV_KEYS, ...SERVICE_TLS_ENV_KEYS]

  for (const key of allowedKeys) {
    const value = sourceEnv[key]
    if (value !== undefined)
      saved[key] = value
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(filePath, 0o600)
  }
  catch {}
}

export function loadNativeServiceEnvironment(
  options: {
    proxyEnv: boolean
    targetEnv?: NodeJS.ProcessEnv
    filePath?: string
  },
): void {
  const targetEnv = options.targetEnv ?? process.env
  const filePath = options.filePath ?? PATHS.NATIVE_SERVICE_ENV
  const raw = fs.readFileSync(filePath, 'utf8')
  const parsed = JSON.parse(raw) as unknown

  if (!isStringRecord(parsed))
    throw new Error(`Native service environment file is invalid: ${filePath}`)

  for (const key of MANAGED_SERVICE_ENV_KEYS)
    delete targetEnv[key]

  for (const key of MANAGED_SERVICE_ENV_KEYS) {
    const value = parsed[key]
    if (value !== undefined)
      targetEnv[key] = value
  }

  if (options.proxyEnv)
    assertProxyEndpointAvailable(targetEnv)
}

export function removeNativeServiceEnvironment(filePath: string = PATHS.NATIVE_SERVICE_ENV): void {
  fs.rmSync(filePath, { force: true })
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false

  return Object.values(value).every(entry => typeof entry === 'string')
}
