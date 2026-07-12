export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
] as const

export const PROXY_ENDPOINT_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const

export const NETWORK_BOOTSTRAPPED_ENV = 'COPILOT_PROXY_NETWORK_BOOTSTRAPPED'

export function hasProxyEndpointEnvironment(env: NodeJS.ProcessEnv): boolean {
  return PROXY_ENDPOINT_ENV_KEYS.some(key => Boolean(env[key]?.trim()))
}

export function resolveProxyForUrlFromEnvironment(
  rawUrl: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const url = new URL(rawUrl)
  if (matchesNoProxy(url, env))
    return undefined

  const protocolKey = `${url.protocol.slice(0, -1)}_proxy`
  const proxy = getEnvironmentValue(env, protocolKey) || getEnvironmentValue(env, 'all_proxy')
  if (!proxy)
    return undefined
  return proxy.includes('://') ? proxy : `${url.protocol}//${proxy}`
}

function matchesNoProxy(url: URL, env: NodeJS.ProcessEnv): boolean {
  const raw = getEnvironmentValue(env, 'no_proxy').toLowerCase()
  if (!raw)
    return false
  if (raw === '*')
    return true

  const hostname = url.hostname.toLowerCase()
  const effectivePort = Number.parseInt(url.port, 10)
    || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0)

  return raw.split(/[,\s]/).some((entry) => {
    if (!entry)
      return false
    const portMatch = entry.match(/^(.+):(\d+)$/)
    const entryHost = (portMatch?.[1] ?? entry).toLowerCase()
    const entryPort = portMatch ? Number.parseInt(portMatch[2], 10) : 0
    if (entryPort && entryPort !== effectivePort)
      return false

    if (!entryHost.startsWith('.') && !entryHost.startsWith('*'))
      return hostname === entryHost
    const suffix = entryHost.startsWith('*') ? entryHost.slice(1) : entryHost
    return hostname.endsWith(suffix)
  })
}

function getEnvironmentValue(env: NodeJS.ProcessEnv, lowerKey: string): string {
  return (env[lowerKey] || env[lowerKey.toUpperCase()] || '').trim()
}

export function withoutProxyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env }
  for (const key of PROXY_ENV_KEYS)
    delete sanitized[key]
  return sanitized
}

export function cliEnablesProxyEnvironment(args: string[]): boolean {
  let enabled = false
  for (const arg of args) {
    if (arg === '--proxy-env' || arg === '--proxy-env=true')
      enabled = true
    else if (arg === '--no-proxy-env' || arg === '--proxy-env=false')
      enabled = false
  }
  return enabled
}

export function shouldRestartWithSanitizedNetworkEnvironment(
  args: string[],
  env: NodeJS.ProcessEnv,
  isBun: boolean,
): boolean {
  const command = args[0]
  const usesNetwork = command === 'start' || command === 'auth' || command === 'check-usage'
  return usesNetwork
    && env[NETWORK_BOOTSTRAPPED_ENV] !== '1'
    && (
      (command === 'start' && args.includes('--_service'))
      || (isBun && !cliEnablesProxyEnvironment(args) && hasProxyEndpointEnvironment(env))
    )
}
