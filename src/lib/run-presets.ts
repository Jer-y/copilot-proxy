import type { ParseArgsOptionsConfig } from 'node:util'
import type { CliOptionMetadata } from './cli-options'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { cittyLongOptionNames } from './citty-argv'
import { SETUP_CLI_OPTIONS, START_CLI_OPTIONS } from './cli-options'
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

function buildRunParseOptions(definitions: Record<string, CliOptionMetadata>): ParseArgsOptionsConfig {
  const options: ParseArgsOptionsConfig = {}
  for (const [optionName, definition] of Object.entries(definitions)) {
    if (definition.type === 'positional')
      continue
    const type = definition.type === 'boolean' ? 'boolean' : 'string'
    const [name, ...aliases] = [...cittyLongOptionNames(optionName)]
    options[name] = {
      type,
      ...(definition.alias && { short: definition.alias }),
    }
    for (const alias of aliases)
      options[alias] = { type }
  }
  return options
}

const RUN_PARSE_OPTIONS = {
  setup: buildRunParseOptions(SETUP_CLI_OPTIONS),
  start: buildRunParseOptions(START_CLI_OPTIONS),
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
