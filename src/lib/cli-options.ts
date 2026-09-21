// Loaded before the runtime guard: keep this metadata dependency-free.
export interface CliOptionMetadata {
  type: 'boolean' | 'string' | 'enum' | 'positional'
  alias?: string
}

export interface CittyStringOptionDefinition {
  name: string
  shortName?: string
}

export const START_CLI_OPTIONS = {
  'port': { alias: 'p', type: 'string' },
  'host': { alias: 'H', type: 'string' },
  'preset': { type: 'enum' },
  'verbose': { alias: 'v', type: 'boolean' },
  'account-type': { alias: 'a', type: 'string' },
  'rate-limit': { alias: 'r', type: 'string' },
  'wait': { alias: 'w', type: 'boolean' },
  'max-concurrency': { type: 'string' },
  'max-queue': { type: 'string' },
  'queue-timeout-ms': { type: 'string' },
  'headers-timeout-ms': { type: 'string' },
  'body-timeout-ms': { type: 'string' },
  'connect-timeout-ms': { type: 'string' },
  'github-token': { alias: 'g', type: 'string' },
  'expose-account-identity': { type: 'boolean' },
  'expose-account-models': { type: 'boolean' },
  'proxy-env': { type: 'boolean' },
  'daemon': { alias: 'd', type: 'boolean' },
  '_service': { type: 'boolean' },
  '_log-file': { type: 'boolean' },
  '_data-dir': { type: 'string' },
  '_instance-token': { type: 'string' },
} as const satisfies Record<string, CliOptionMetadata>

export const SETUP_CLI_OPTIONS = {
  'client': { type: 'positional' },
  'model': { type: 'string' },
  'small-model': { type: 'string' },
  'port': { alias: 'p', type: 'string' },
  'host': { alias: 'H', type: 'string' },
  'account-type': { alias: 'a', type: 'string' },
  'preset': { type: 'enum' },
  'proxy-env': { type: 'boolean' },
  'shell': { type: 'enum' },
  'json': { type: 'boolean' },
  'copy': { type: 'boolean' },
} as const satisfies Record<string, CliOptionMetadata>

export const AUTH_CLI_OPTIONS = {
  'verbose': { alias: 'v', type: 'boolean' },
  'proxy-env': { type: 'boolean' },
  'github-token': { alias: 'g', type: 'string' },
  'account': { type: 'string' },
  'token-stdin': { type: 'boolean' },
  '_if-needed': { type: 'boolean' },
} as const satisfies Record<string, CliOptionMetadata>

interface CliOptionPresentation {
  description: string
  default?: string | boolean
  required?: boolean
  options?: string[]
}

/** Attach command-specific help/defaults without redefining parser metadata. */
export function withCliOptions<
  T extends Record<string, CliOptionMetadata>,
  P extends { [K in keyof T]: CliOptionPresentation },
>(metadata: T, presentation: P & Record<Exclude<keyof P, keyof T>, never>): { [K in keyof T]: T[K] & P[K] } {
  return Object.fromEntries(Object.entries(metadata).map(([name, option]) => [
    name,
    { ...presentation[name], ...option },
  ])) as { [K in keyof T]: T[K] & P[K] }
}

export function cliStringOptions(metadata: Record<string, CliOptionMetadata>): CittyStringOptionDefinition[] {
  return Object.entries(metadata)
    .filter(([, option]) => option.type === 'string' || option.type === 'enum')
    .map(([name, option]) => ({ name, ...(option.alias && { shortName: option.alias }) }))
}
