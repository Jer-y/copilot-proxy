import {
  AUTH_CITTY_STRING_OPTIONS,
  cittyLongOptionNames,
  hasCittyRootHelpFlag,
  resolveCittyBooleanOption,
  START_CITTY_STRING_OPTIONS,
} from '~/lib/citty-argv'

export interface SanitizedGithubTokenArguments {
  args: string[]
  token?: string
}

export interface BootstrapArgumentAnalysis extends SanitizedGithubTokenArguments {
  command?: GithubTokenCommand
  dataDir?: string
  misplacedGithubToken: boolean
  nativeService: boolean
  processLog: boolean
  proxyEnvironment: boolean
  rootHelp: boolean
}

export type GithubTokenCommand = 'auth' | 'start'
type GithubTokenOptionKind = 'camel' | 'canonical'

const INTERNAL_DATA_DIR_OPTION = '--_data-dir'
const START_NON_TOKEN_STRING_OPTIONS = START_CITTY_STRING_OPTIONS
  .filter(option => option.name !== 'github-token')
const STRING_START_ALIASES = new Set<string>(START_NON_TOKEN_STRING_OPTIONS.flatMap(option => (
  'shortName' in option ? [option.shortName] : []
)))
const LONG_GITHUB_TOKEN_OPTIONS = new Map<string, GithubTokenOptionKind>([
  ['--github-token', 'canonical'],
  ['--githubToken', 'camel'],
])
const LONG_START_STRING_OPTIONS = new Set(START_NON_TOKEN_STRING_OPTIONS.flatMap(option => (
  [...cittyLongOptionNames(option.name)].map(name => `--${name}`)
)))

export function removeGithubTokenArguments(args: string[]): SanitizedGithubTokenArguments {
  const analysis = analyzeBootstrapArguments(args)
  return {
    args: analysis.args,
    ...(analysis.token !== undefined && { token: analysis.token }),
  }
}

export function resolveGithubTokenCommand(args: string[]): GithubTokenCommand | undefined {
  return analyzeBootstrapArguments(args).command
}

export function analyzeBootstrapArguments(args: string[]): BootstrapArgumentAnalysis {
  const rootHelp = hasCittyRootHelpFlag(args)
  const commandLocation = findGithubTokenCommand(args)
  if (!commandLocation) {
    return {
      args: [...args],
      misplacedGithubToken: args.some(isGithubTokenShapedArgument),
      nativeService: false,
      processLog: false,
      proxyEnvironment: false,
      rootHelp,
    }
  }

  const sanitized: string[] = []
  let camelToken: string | undefined
  let canonicalToken: string | undefined
  let dataDir: string | undefined
  let misplacedGithubToken = commandLocation.command === 'start'
    && hasCittyConsumedGithubTokenValue(args, commandLocation.index)
  let authDataDirOptionIndex: number | undefined
  let authDataDirValueIndex: number | undefined

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (index === commandLocation.index) {
      sanitized.push(arg)
      continue
    }

    if (arg === '--') {
      if (args.slice(index + 1).some(isGithubTokenShapedArgument))
        misplacedGithubToken = true
      sanitized.push(...args.slice(index))
      break
    }

    const isCommandPrefix = index < commandLocation.index
    const isStartArgument = !isCommandPrefix
      && commandLocation.command === 'start'
    const isAuthArgument = !isCommandPrefix
      && commandLocation.command === 'auth'

    if (isStartArgument && arg.startsWith(`${INTERNAL_DATA_DIR_OPTION}=`)) {
      const value = arg.slice(INTERNAL_DATA_DIR_OPTION.length + 1)
      if (dataDir === undefined && value) {
        if (isGithubTokenShapedArgument(value))
          misplacedGithubToken = true
        else
          dataDir = value
      }
      sanitized.push(arg)
      continue
    }

    const consumesStartStringValue = isStartArgument
      && (LONG_START_STRING_OPTIONS.has(arg)
        || startShortStringOptionConsumesNext(arg))
    if (consumesStartStringValue) {
      sanitized.push(arg)
      // Citty's declared start string options consume even a literal `--` as
      // their value.
      if (args[index + 1] !== undefined) {
        const value = args[index + 1]
        if (isGithubTokenShapedArgument(value))
          misplacedGithubToken = true
        if (arg === INTERNAL_DATA_DIR_OPTION && dataDir === undefined && value) {
          if (!isGithubTokenShapedArgument(value))
            dataDir = value
        }
        sanitized.push(args[++index])
      }
      continue
    }

    const canSelectBootstrapDataDir = dataDir === undefined
      && (isCommandPrefix || isAuthArgument)
    if (canSelectBootstrapDataDir && arg.startsWith(`${INTERNAL_DATA_DIR_OPTION}=`)) {
      const value = arg.slice(INTERNAL_DATA_DIR_OPTION.length + 1)
      if (value) {
        if (isGithubTokenShapedArgument(value))
          misplacedGithubToken = true
        else
          dataDir = value
        if (isAuthArgument)
          authDataDirOptionIndex = index
      }
      sanitized.push(arg)
      continue
    }
    if (canSelectBootstrapDataDir && arg === INTERNAL_DATA_DIR_OPTION) {
      const value = args[index + 1]
      const valueIsCommand = index + 1 === commandLocation.index
      if (value) {
        if (isGithubTokenShapedArgument(value))
          misplacedGithubToken = true
        else
          dataDir = value
        if (isAuthArgument) {
          authDataDirOptionIndex = index
          authDataDirValueIndex = index + 1
        }
        sanitized.push(arg)
        if (valueIsCommand)
          continue
        if (value === '--') {
          sanitized.push(...args.slice(index + 1))
          break
        }
        sanitized.push(value)
        index++
        continue
      }
    }

    const longTokenKind = LONG_GITHUB_TOKEN_OPTIONS.get(arg)
    if (longTokenKind) {
      const value = args[index + 1]
      const valuePrecedesCommand = index + 1 < commandLocation.index
      if (value !== undefined && (!isCommandPrefix || valuePrecedesCommand)) {
        if (longTokenKind === 'canonical')
          canonicalToken = value
        else
          camelToken = value
        index++
        continue
      }
    }
    else if ([...LONG_GITHUB_TOKEN_OPTIONS].some(([option]) => arg.startsWith(`${option}=`))) {
      const kind = arg.startsWith('--github-token=') ? 'canonical' : 'camel'
      const value = arg.slice(arg.indexOf('=') + 1)
      if (value) {
        if (kind === 'canonical')
          canonicalToken = value
        else
          camelToken = value
        continue
      }
    }
    else if (arg.startsWith('-') && !arg.startsWith('--')) {
      const compact = extractGithubTokenFromShortArgument(
        arg,
        args[index + 1],
        isCommandPrefix ? undefined : commandLocation.command,
        !isCommandPrefix || index + 1 < commandLocation.index,
      )
      if (compact) {
        if (compact.prefix)
          sanitized.push(`-${compact.prefix}`)
        canonicalToken = compact.token
        if (compact.consumedNext) {
          index++
        }
        continue
      }
    }

    const inlineStartStringValue = isStartArgument
      ? startInlineStringOptionValue(arg)
      : undefined
    if (
      inlineStartStringValue !== undefined
      && isGithubTokenShapedArgument(inlineStartStringValue)
    ) {
      misplacedGithubToken = true
    }
    if (isGithubTokenShapedArgument(arg)
      && (!isCommandPrefix || !isBareGithubTokenOption(arg))) {
      misplacedGithubToken = true
    }

    sanitized.push(arg)
  }

  const proxyRawArgs = commandLocation.command === 'auth'
    ? withoutSelectedAuthDataDirValue(
        args,
        commandLocation.index,
        authDataDirOptionIndex,
        authDataDirValueIndex,
      )
    : commandLocation.rawArgs
  const proxyEnvironment = !rootHelp
    && resolveCittyBooleanOption(proxyRawArgs, 'proxy-env', {
      stringOptions: commandLocation.command === 'start'
        ? START_CITTY_STRING_OPTIONS
        : AUTH_CITTY_STRING_OPTIONS,
    }).value === true

  return {
    args: sanitized,
    command: commandLocation.command,
    misplacedGithubToken,
    nativeService: !rootHelp && commandLocation.command === 'start'
      && resolveCittyBooleanOption(commandLocation.rawArgs, '_service', {
        stringOptions: START_CITTY_STRING_OPTIONS,
      }).value === true,
    processLog: !rootHelp && commandLocation.command === 'start'
      && resolveCittyBooleanOption(commandLocation.rawArgs, '_log-file', {
        stringOptions: START_CITTY_STRING_OPTIONS,
      }).value === true,
    proxyEnvironment,
    rootHelp,
    ...(dataDir !== undefined && { dataDir }),
    ...(!misplacedGithubToken && (canonicalToken ?? camelToken) !== undefined && {
      token: canonicalToken ?? camelToken,
    }),
  }
}

function isGithubTokenShapedArgument(arg: string): boolean {
  if (
    arg === '-g'
    || arg === '--github-token'
    || arg === '--githubToken'
    || arg === '--no-github-token'
    || arg.startsWith('--no-github-token=')
    || arg === '--no-githubToken'
    || arg.startsWith('--no-githubToken=')
    || arg === '--no-g'
    || arg.startsWith('--no-g=')
    || arg.includes('--github-token=')
    || arg.includes('--githubToken=')
  ) {
    return true
  }

  if (!arg.startsWith('-') || arg.startsWith('--'))
    return false

  return extractGithubTokenFromShortArgument(arg, '[redacted]', 'start', true) !== undefined
}

function isBareGithubTokenOption(arg: string): boolean {
  return arg === '--github-token'
    || arg === '--githubToken'
    || /^-[^-]*g$/.test(arg)
}

function hasCittyConsumedGithubTokenValue(args: string[], commandIndex: number): boolean {
  const processed: string[] = []
  for (let index = commandIndex + 1; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') {
      processed.push(...args.slice(index))
      break
    }
    // Citty removes negative boolean arguments before node:util.parseArgs
    // assigns following values to declared string options.
    if (arg.startsWith('--no-'))
      continue
    processed.push(arg)
  }

  for (let index = 0; index < processed.length; index++) {
    const arg = processed[index]
    if (arg === '--')
      return processed.slice(index + 1).some(isGithubTokenShapedArgument)

    const inlineValue = startInlineStringOptionValue(arg)
    if (inlineValue !== undefined && isGithubTokenShapedArgument(inlineValue))
      return true

    if (LONG_START_STRING_OPTIONS.has(arg) || startShortStringOptionConsumesNext(arg)) {
      const value = processed[index + 1]
      if (value !== undefined && isGithubTokenShapedArgument(value))
        return true
      index++
    }
  }
  return false
}

function withoutSelectedAuthDataDirValue(
  args: string[],
  commandIndex: number,
  optionIndex: number | undefined,
  valueIndex: number | undefined,
): string[] {
  if (optionIndex === undefined || optionIndex <= commandIndex)
    return args.slice(commandIndex + 1)

  const normalized: string[] = []
  for (let index = commandIndex + 1; index < args.length; index++) {
    if (index !== optionIndex) {
      normalized.push(args[index])
      continue
    }

    if (valueIndex !== undefined) {
      if (args[valueIndex] === '--')
        normalized.push('--')
      index = valueIndex
    }
  }
  return normalized
}

function findGithubTokenCommand(
  args: string[],
): { command: GithubTokenCommand, index: number, rawArgs: string[] } | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--')
      return undefined

    const longTokenKind = LONG_GITHUB_TOKEN_OPTIONS.get(arg)
    if (longTokenKind && args[index + 1] !== undefined) {
      const next = args[index + 1]
      if (next !== 'start' && next !== 'auth')
        index++
      continue
    }
    if ([...LONG_GITHUB_TOKEN_OPTIONS].some(([option]) => arg.startsWith(`${option}=`)))
      continue
    if (arg.startsWith('-') && !arg.startsWith('--')) {
      const token = extractGithubTokenFromShortArgument(arg, args[index + 1], undefined, true)
      if (token) {
        if (token.consumedNext && token.token !== 'start' && token.token !== 'auth')
          index++
        continue
      }
    }
    if (arg.startsWith('-'))
      continue
    if (arg !== 'start' && arg !== 'auth')
      return undefined
    return {
      command: arg,
      index,
      rawArgs: args.slice(index + 1),
    }
  }
  return undefined
}

function startShortStringOptionConsumesNext(arg: string): boolean {
  if (!arg.startsWith('-') || arg.startsWith('--'))
    return false

  for (let index = 1; index < arg.length; index++) {
    const option = arg[index]
    if (option === 'g')
      return false
    if (STRING_START_ALIASES.has(option))
      return index === arg.length - 1
  }
  return false
}

function startInlineStringOptionValue(arg: string): string | undefined {
  for (const option of LONG_START_STRING_OPTIONS) {
    const prefix = `${option}=`
    if (arg.startsWith(prefix))
      return arg.slice(prefix.length)
  }

  if (!arg.startsWith('-') || arg.startsWith('--'))
    return undefined

  for (let index = 1; index < arg.length; index++) {
    const option = arg[index]
    if (option === 'g')
      return undefined
    if (STRING_START_ALIASES.has(option)) {
      const value = arg.slice(index + 1)
      return value || undefined
    }
  }
  return undefined
}

function extractGithubTokenFromShortArgument(
  arg: string,
  next: string | undefined,
  command: GithubTokenCommand | undefined,
  canConsumeNext: boolean,
): { consumedNext: boolean, prefix: string, token: string } | undefined {
  let prefix = ''
  for (let index = 1; index < arg.length; index++) {
    const option = arg[index]
    if (command === 'start' && STRING_START_ALIASES.has(option)) {
      // The remainder belongs to an earlier string option, so a later `g` is
      // data rather than another option.
      return undefined
    }

    if (option !== 'g') {
      // citty uses non-strict option parsing, so unknown short flags can prefix
      // a known clustered option. Preserve them and keep scanning for `g`.
      prefix += option
      continue
    }

    const inlineValue = arg.slice(index + 1)
    if (inlineValue) {
      return { consumedNext: false, prefix, token: inlineValue }
    }
    if (canConsumeNext && next !== undefined) {
      return { consumedNext: true, prefix, token: next }
    }
    return undefined
  }
  return undefined
}
