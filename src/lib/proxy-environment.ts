import type {
  CittyStringOptionDefinition,
} from './citty-argv'

import { analyzeBootstrapArguments } from '~/daemon/github-token-argv'
import {
  AUTH_CITTY_STRING_OPTIONS,
  findCittyRootCommand,
  hasCittyRootHelpFlag,
  resolveCittyBooleanOption,
  START_CITTY_STRING_OPTIONS,
} from './citty-argv'

export type {
  CittyBooleanOptionResolution,
  CittyStringOptionDefinition,
} from './citty-argv'
export { resolveCittyBooleanOption } from './citty-argv'

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

const NETWORK_COMMAND_STRING_OPTIONS: Record<string, readonly CittyStringOptionDefinition[]> = {
  'auth': AUTH_CITTY_STRING_OPTIONS,
  'check-usage': [],
  'doctor': [
    { name: 'endpoint' },
    { name: 'client' },
    { name: 'timeout-ms' },
  ],
  'models': [
    { name: 'account-type', shortName: 'a' },
    { name: 'client' },
  ],
  'setup': [
    { name: 'model' },
    { name: 'small-model' },
    { name: 'port', shortName: 'p' },
    { name: 'host', shortName: 'H' },
    { name: 'account-type', shortName: 'a' },
    { name: 'preset' },
    { name: 'shell' },
  ],
  'start': START_CITTY_STRING_OPTIONS,
}

// This bootstrap module is loaded before the runtime guard and before command
// modules, so it cannot reuse Citty or import their argument definitions. Keep
// only the string options that can consume a following proxy-looking token.

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
  if (hasCittyRootHelpFlag(args))
    return false
  const command = findCittyRootCommand(args)
  if (!command)
    return false
  if (command.command === 'start' || command.command === 'auth')
    return analyzeBootstrapArguments(args).proxyEnvironment
  return resolveCittyBooleanOption(command.rawArgs, 'proxy-env', {
    stringOptions: NETWORK_COMMAND_STRING_OPTIONS[command.command] ?? [],
  }).value === true
}

export function shouldRestartWithSanitizedNetworkEnvironment(
  args: string[],
  env: NodeJS.ProcessEnv,
  isBun: boolean,
): boolean {
  if (hasCittyRootHelpFlag(args))
    return false
  const command = findCittyRootCommand(args)
  const commandName = command?.command
  const usesNetwork = commandName === 'start'
    || commandName === 'auth'
    || commandName === 'check-usage'
    || commandName === 'setup'
    || commandName === 'models'
    || commandName === 'doctor'
  const nativeService = command?.command === 'start'
    && resolveCittyBooleanOption(command.rawArgs, '_service', {
      stringOptions: START_CITTY_STRING_OPTIONS,
    }).value === true
  return usesNetwork
    && env[NETWORK_BOOTSTRAPPED_ENV] !== '1'
    && (
      nativeService
      || (isBun && !cliEnablesProxyEnvironment(args) && hasProxyEndpointEnvironment(env))
    )
}
