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
  return args[0] === 'start'
    && env[NETWORK_BOOTSTRAPPED_ENV] !== '1'
    && (
      args.includes('--_service')
      || (isBun && !cliEnablesProxyEnvironment(args) && hasProxyEndpointEnvironment(env))
    )
}
