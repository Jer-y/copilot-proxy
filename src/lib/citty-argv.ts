export interface CittyStringOptionDefinition {
  name: string
  shortName?: string
}

export interface CittyBooleanOptionResolution {
  negated: boolean
  positiveValue: boolean | undefined
  value: boolean | undefined
}

export interface CittyRootCommandLocation {
  command: string
  index: number
  rawArgs: string[]
}

export const AUTH_CITTY_STRING_OPTIONS = [
  { name: 'github-token', shortName: 'g' },
] as const satisfies readonly CittyStringOptionDefinition[]

export const START_CITTY_STRING_OPTIONS = [
  { name: 'port', shortName: 'p' },
  { name: 'host', shortName: 'H' },
  { name: 'preset' },
  { name: 'account-type', shortName: 'a' },
  { name: 'rate-limit', shortName: 'r' },
  { name: 'max-concurrency' },
  { name: 'max-queue' },
  { name: 'queue-timeout-ms' },
  { name: 'headers-timeout-ms' },
  { name: 'body-timeout-ms' },
  { name: 'connect-timeout-ms' },
  { name: 'github-token', shortName: 'g' },
  { name: '_data-dir' },
  { name: '_instance-token' },
] as const satisfies readonly CittyStringOptionDefinition[]

// This module is loaded before the runtime guard. Keep it dependency-free and
// aligned with Citty's root command and node:util.parseArgs preprocessing.
export function findCittyRootCommand(args: string[]): CittyRootCommandLocation | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--')
      return undefined
    if (arg.startsWith('-'))
      continue
    return {
      command: arg,
      index,
      rawArgs: args.slice(index + 1),
    }
  }
  return undefined
}

export function hasCittyRootHelpFlag(args: string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

export function cittyLongOptionNames(name: string): Set<string> {
  const camelName = name
    .replace(/^[^a-z\d]+/i, '')
    .replace(/[-_]+([a-z\d])/gi, (_, character: string) => character.toUpperCase())
  const kebabName = name
    .replace(/([a-z\d])([A-Z])/g, '$1-$2')
    .replaceAll('_', '-')
    .toLowerCase()
  return new Set([name, camelName, kebabName])
}

export function resolveCittyBooleanOption(
  rawArgs: string[],
  name: string,
  options: {
    shortName?: string
    stringOptions?: readonly CittyStringOptionDefinition[]
  } = {},
): CittyBooleanOptionResolution {
  const longNames = cittyLongOptionNames(name)
  const { negatedNames: rawNegatedNames, processedArgs } = preprocessCittyArgs(rawArgs)
  const negatedNames = new Set(rawNegatedNames.filter(negatedName => longNames.has(negatedName)))

  const stringLongNames = new Set<string>()
  const stringShortNames = new Set<string>()
  for (const option of options.stringOptions ?? []) {
    for (const longName of cittyLongOptionNames(option.name))
      stringLongNames.add(longName)
    if (option.shortName)
      stringShortNames.add(option.shortName)
  }

  const positiveValues = new Map<string, boolean>()
  for (let index = 0; index < processedArgs.length; index++) {
    const arg = processedArgs[index]
    if (arg === '--')
      break

    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=')
      const rawName = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex)
      if (longNames.has(rawName)) {
        positiveValues.set(rawName, equalsIndex === -1 || arg.slice(equalsIndex + 1) !== 'false')
      }
      else if (equalsIndex === -1 && stringLongNames.has(rawName) && index + 1 < processedArgs.length) {
        index++
      }
      continue
    }

    if (!arg.startsWith('-') || arg === '-')
      continue

    const cluster = arg.slice(1)
    for (let clusterIndex = 0; clusterIndex < cluster.length; clusterIndex++) {
      const shortName = cluster[clusterIndex]
      if (stringShortNames.has(shortName)) {
        if (clusterIndex === cluster.length - 1 && index + 1 < processedArgs.length)
          index++
        break
      }
      if (shortName === options.shortName)
        positiveValues.set(name, true)
    }
  }

  const positiveValue = positiveValues.size === 0
    ? undefined
    // These callers define false-default booleans. Citty's generated aliases
    // have no default, so a true alias wins over the primary default false.
    : positiveValues.values().some(Boolean)
  const negated = negatedNames.size > 0
  const hasExplicitValue = positiveValues.size > 0 || negated

  // Reproduce Citty's alias overlay rather than treating any generated
  // negative as a global false. A canonical negative clears every alias, while
  // a negative generated alias clears only itself and the canonical value. A
  // positive sibling alias can therefore still replace the canonical default.
  const values = new Map<string, boolean>([[name, false], ...positiveValues])
  const aliases = [...longNames].filter(longName => longName !== name)
  for (const negatedName of negatedNames) {
    values.set(negatedName, false)
    values.set(name, false)
    if (negatedName === name) {
      for (const alias of aliases)
        values.set(alias, false)
    }
  }

  const synchronizeAlias = (alias: string, main: string) => {
    const aliasValue = values.get(alias)
    const mainValue = values.get(main)
    if (aliasValue !== undefined && mainValue === undefined)
      values.set(main, aliasValue)
    if (mainValue !== undefined && aliasValue === undefined)
      values.set(alias, mainValue)
    if (aliasValue !== undefined && mainValue !== undefined
      && aliasValue !== mainValue && main === name && mainValue === false) {
      values.set(main, aliasValue)
    }
  }

  if (aliases.length > 0) {
    synchronizeAlias(name, aliases.at(-1)!)
    for (const alias of aliases)
      synchronizeAlias(alias, name)
  }

  return {
    negated,
    positiveValue,
    value: hasExplicitValue ? values.get(name) : undefined,
  }
}

export function wasCittyStringOptionPassed(
  rawArgs: string[],
  name: string,
  options: {
    shortName?: string
    stringOptions?: readonly CittyStringOptionDefinition[]
  } = {},
): boolean {
  const targetLongNames = cittyLongOptionNames(name)
  const { processedArgs } = preprocessCittyArgs(rawArgs)
  const stringLongNames = new Set<string>()
  const stringShortNames = new Set<string>()
  for (const option of options.stringOptions ?? []) {
    for (const longName of cittyLongOptionNames(option.name))
      stringLongNames.add(longName)
    if (option.shortName)
      stringShortNames.add(option.shortName)
  }

  for (let index = 0; index < processedArgs.length; index++) {
    const arg = processedArgs[index]
    if (arg === '--')
      break

    if (arg.startsWith('--')) {
      const equalsIndex = arg.indexOf('=')
      const rawName = arg.slice(2, equalsIndex === -1 ? undefined : equalsIndex)
      if (targetLongNames.has(rawName))
        return true
      if (equalsIndex === -1 && stringLongNames.has(rawName) && index + 1 < processedArgs.length)
        index++
      continue
    }

    if (!arg.startsWith('-') || arg === '-')
      continue

    const cluster = arg.slice(1)
    for (let clusterIndex = 0; clusterIndex < cluster.length; clusterIndex++) {
      const shortName = cluster[clusterIndex]
      if (!stringShortNames.has(shortName))
        continue
      if (shortName === options.shortName)
        return true
      if (clusterIndex === cluster.length - 1 && index + 1 < processedArgs.length)
        index++
      break
    }
  }
  return false
}

function preprocessCittyArgs(rawArgs: string[]): {
  negatedNames: string[]
  processedArgs: string[]
} {
  const negatedNames: string[] = []
  const processedArgs: string[] = []

  // Citty removes every --no-* token before handing the remaining arguments to
  // node:util.parseArgs, then overlays the recorded negatives on the result.
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index]
    if (arg === '--') {
      processedArgs.push(...rawArgs.slice(index))
      break
    }
    if (arg.startsWith('--no-')) {
      negatedNames.push(arg.slice('--no-'.length))
      continue
    }
    processedArgs.push(arg)
  }
  return { negatedNames, processedArgs }
}
