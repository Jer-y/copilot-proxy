import type { ParseArgsOptionsConfig } from 'node:util'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { cittyLongOptionNames } from './citty-argv'
import { ALLOWED_HOSTS_ENV, DEFAULT_HOST, hasValidNonLoopbackAllowedHost } from './security'

export const RUN_PRESET_NAMES = ['personal', 'service', 'gateway-upstream', 'custom'] as const

export type RunPresetName = typeof RUN_PRESET_NAMES[number]

export interface RunPresetDefaults {
  description: string
  host: string
  maxConcurrency?: number
  maxQueue?: number
  queueTimeoutMs?: number
}

export interface RunPresetOverrides {
  host?: string
  maxConcurrency?: number
  maxQueue?: number
  queueTimeoutMs?: number
}

export interface ResolvedRunPreset extends RunPresetDefaults {
  name: RunPresetName
}

export const RUN_PRESETS: Readonly<Record<RunPresetName, Readonly<RunPresetDefaults>>> = {
  'personal': {
    description: 'Safe loopback defaults for one local user',
    host: DEFAULT_HOST,
    maxConcurrency: 2,
    maxQueue: 8,
    queueTimeoutMs: 30_000,
  },
  'service': {
    description: 'Long-running private service with bounded identity-wide concurrency',
    host: DEFAULT_HOST,
    maxConcurrency: 4,
    maxQueue: 32,
    queueTimeoutMs: 30_000,
  },
  'gateway-upstream': {
    description: 'Private upstream behind an authenticated gateway; never expose directly',
    host: '0.0.0.0',
    maxConcurrency: 4,
    maxQueue: 50,
    queueTimeoutMs: 30_000,
  },
  'custom': {
    description: 'No identity-wide concurrency limit unless explicitly configured',
    host: DEFAULT_HOST,
  },
}

interface RunOptionDefinition {
  name: string
  short?: string
  type: 'boolean' | 'string'
}

// Keep the start portion aligned with every option accepted by that command.
// Citty delegates parsing to node:util after generating camelCase aliases for
// dashed names. Presence detection needs the complete type table: otherwise a
// string option such as --github-token can consume text that only looks like a
// later option, and a short boolean cluster such as -vH127.0.0.1 can be misread.
const START_RUN_OPTION_DEFINITIONS: readonly RunOptionDefinition[] = [
  { name: 'port', short: 'p', type: 'string' },
  { name: 'host', short: 'H', type: 'string' },
  { name: 'preset', type: 'string' },
  { name: 'verbose', short: 'v', type: 'boolean' },
  { name: 'account-type', short: 'a', type: 'string' },
  { name: 'manual', type: 'boolean' },
  { name: 'rate-limit', short: 'r', type: 'string' },
  { name: 'wait', short: 'w', type: 'boolean' },
  { name: 'max-concurrency', type: 'string' },
  { name: 'max-queue', type: 'string' },
  { name: 'queue-timeout-ms', type: 'string' },
  { name: 'headers-timeout-ms', type: 'string' },
  { name: 'body-timeout-ms', type: 'string' },
  { name: 'connect-timeout-ms', type: 'string' },
  { name: 'github-token', short: 'g', type: 'string' },
  { name: 'claude-code', short: 'c', type: 'boolean' },
  { name: 'show-token', type: 'boolean' },
  { name: 'proxy-env', type: 'boolean' },
  { name: 'daemon', short: 'd', type: 'boolean' },
  { name: '_supervisor', type: 'boolean' },
  { name: '_service', type: 'boolean' },
  { name: '_log-file', type: 'boolean' },
  { name: '_data-dir', type: 'string' },
  { name: '_instance-token', type: 'string' },
]

const SETUP_RUN_OPTION_DEFINITIONS: readonly RunOptionDefinition[] = [
  { name: 'model', type: 'string' },
  { name: 'small-model', type: 'string' },
  { name: 'port', short: 'p', type: 'string' },
  { name: 'host', short: 'H', type: 'string' },
  { name: 'account-type', short: 'a', type: 'string' },
  { name: 'preset', type: 'string' },
  { name: 'proxy-env', type: 'boolean' },
  { name: 'shell', type: 'string' },
  { name: 'json', type: 'boolean' },
  { name: 'copy', type: 'boolean' },
]

function buildRunParseOptions(definitions: readonly RunOptionDefinition[]): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = {}
  for (const definition of definitions) {
    const [name, ...aliases] = [...cittyLongOptionNames(definition.name)]
    options[name] = {
      type: definition.type,
      ...(definition.short && { short: definition.short }),
    }
    for (const alias of aliases)
      options[alias] = { type: definition.type }
  }
  return options
}

const RUN_PARSE_OPTIONS = {
  setup: buildRunParseOptions(SETUP_RUN_OPTION_DEFINITIONS),
  start: buildRunParseOptions(START_RUN_OPTION_DEFINITIONS),
} as const

export function isRunPresetName(value: string): value is RunPresetName {
  return RUN_PRESET_NAMES.includes(value as RunPresetName)
}

export function wasRunOptionPassed(
  rawArgs: string[],
  longName: string,
  shortName?: string,
  command: keyof typeof RUN_PARSE_OPTIONS = 'start',
): boolean {
  try {
    const processedArgs: string[] = []
    for (let index = 0; index < rawArgs.length; index++) {
      const arg = rawArgs[index]
      if (arg === '--') {
        processedArgs.push(...rawArgs.slice(index))
        break
      }
      // Citty removes negative boolean flags before passing the remaining
      // arguments to node:util.parseArgs. Mirroring that preprocessing matters
      // when a preceding string option would otherwise consume the negative.
      if (arg.startsWith('--no-'))
        continue
      processedArgs.push(arg)
    }

    const { tokens } = parseArgs({
      allowPositionals: true,
      args: processedArgs,
      options: RUN_PARSE_OPTIONS[command],
      strict: false,
      tokens: true,
    })
    const longRawNames = new Set([...cittyLongOptionNames(longName)].map(name => `--${name}`))
    return tokens.some(token => token.kind === 'option' && (
      longRawNames.has(token.rawName)
      || (shortName !== undefined && token.rawName === `-${shortName}`)
    ))
  }
  catch {
    // Citty treats the complete argument list as positional when node:util
    // rejects malformed input, so no option in that list was explicitly parsed.
    return false
  }
}

export function selectStartPreset(
  requested: RunPresetName,
  rawArgs: string[],
  nativeService: boolean,
): RunPresetName {
  if (wasRunOptionPassed(rawArgs, 'preset'))
    return requested

  const hasExistingConcurrencyOptions = [
    'max-concurrency',
    'max-queue',
    'queue-timeout-ms',
  ].some(option => wasRunOptionPassed(rawArgs, option))

  return nativeService || hasExistingConcurrencyOptions ? 'custom' : requested
}

export function gatewayPresetEnvironmentError(
  name: RunPresetName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (name !== 'gateway-upstream' || hasValidNonLoopbackAllowedHost(env[ALLOWED_HOSTS_ENV]))
    return undefined
  return 'The gateway-upstream preset requires COPILOT_PROXY_ALLOWED_HOSTS to be a valid exact Host allowlist containing at least one non-loopback hostname or IP address. Schemes, ports, paths, wildcards, empty entries, and a loopback-only allowlist are not accepted.'
}

export function resolveRunPreset(
  name: RunPresetName,
  overrides: RunPresetOverrides = {},
): ResolvedRunPreset {
  const preset = RUN_PRESETS[name]
  return {
    name,
    ...preset,
    ...(overrides.host !== undefined && { host: overrides.host }),
    ...(overrides.maxConcurrency !== undefined && { maxConcurrency: overrides.maxConcurrency }),
    ...(overrides.maxQueue !== undefined && { maxQueue: overrides.maxQueue }),
    ...(overrides.queueTimeoutMs !== undefined && { queueTimeoutMs: overrides.queueTimeoutMs }),
  }
}
