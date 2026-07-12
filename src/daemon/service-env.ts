import fs from 'node:fs'
import process from 'node:process'

import { writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'
import { PATHS } from '~/lib/paths'
import { PROXY_ENV_KEYS, resolveProxyForUrlFromEnvironment, withoutProxyEnvironment } from '~/lib/proxy-environment'

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

export function assertProxyEndpointAvailable(
  env: NodeJS.ProcessEnv,
  requiredTargets: string[] = ['https://api.github.com'],
): void {
  const resolvedRoutes = requiredTargets.map(target => ({
    proxy: resolveProxyForUrlFromEnvironment(target, env),
    target,
  }))
  const directTarget = resolvedRoutes.find(route => !route.proxy)?.target
  if (directTarget) {
    throw new Error(
      `--proxy-env requires HTTPS_PROXY or ALL_PROXY to route ${directTarget} (and NO_PROXY must not bypass it). Refusing to fall back to a direct connection.`,
    )
  }

  for (const route of resolvedRoutes) {
    let proxyUrl: URL
    try {
      proxyUrl = new URL(route.proxy!)
    }
    catch {
      throw new Error(`--proxy-env resolved an invalid proxy URL for ${route.target}. Refusing to fall back to a direct connection.`)
    }
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
      throw new Error(`--proxy-env resolved unsupported proxy protocol ${proxyUrl.protocol} for ${route.target}. Use an HTTP(S) proxy.`)
    }
  }
}

export function saveNativeServiceEnvironment(
  options: NativeServiceEnvironmentOptions,
): void {
  const saved = buildNativeServiceEnvironment(options)
  const filePath = options.filePath ?? PATHS.NATIVE_SERVICE_ENV

  writeOwnerOnlyFileAtomically(filePath, `${JSON.stringify(saved, null, 2)}\n`)
}

export function buildNativeServiceEnvironment(
  options: Pick<NativeServiceEnvironmentOptions, 'proxyEnv' | 'sourceEnv'>,
): Record<string, string> {
  const sourceEnv = options.sourceEnv ?? process.env

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

  return saved
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

export function buildNativeServiceBootstrapEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  saved: Record<string, string>,
  options: { proxyEnv?: boolean } = {},
): NodeJS.ProcessEnv {
  const env = withoutProxyEnvironment(sourceEnv)
  for (const key of SERVICE_TLS_ENV_KEYS)
    delete env[key]

  if (options.proxyEnv)
    assertProxyEndpointAvailable(saved)

  const restoredKeys = options.proxyEnv
    ? [...PROXY_ENV_KEYS, ...SERVICE_TLS_ENV_KEYS] as const
    : SERVICE_TLS_ENV_KEYS
  for (const key of restoredKeys) {
    if (saved[key] !== undefined)
      env[key] = saved[key]
  }
  return env
}

export function removeNativeServiceEnvironment(filePath: string = PATHS.NATIVE_SERVICE_ENV): void {
  fs.rmSync(filePath, { force: true })
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false

  return Object.values(value).every(entry => typeof entry === 'string')
}
