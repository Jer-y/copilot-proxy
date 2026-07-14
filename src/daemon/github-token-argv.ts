export interface SanitizedGithubTokenArguments {
  args: string[]
  token?: string
}

const BOOLEAN_START_ALIASES = new Set(['v', 'w', 'c', 'd'])
const STRING_START_ALIASES = new Set(['p', 'H', 'a', 'r'])
const LONG_START_STRING_OPTIONS = new Set([
  '--port',
  '--host',
  '--account-type',
  '--rate-limit',
  '--max-concurrency',
  '--max-queue',
  '--queue-timeout-ms',
  '--headers-timeout-ms',
  '--body-timeout-ms',
  '--connect-timeout-ms',
  '--_data-dir',
  '--_instance-token',
])

export function removeGithubTokenArguments(args: string[]): SanitizedGithubTokenArguments {
  if (args[0] !== 'start' && args[0] !== 'auth')
    return { args: [...args] }

  const sanitized: string[] = []
  let token: string | undefined

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') {
      sanitized.push(...args.slice(index))
      break
    }

    if (args[0] === 'start' && (LONG_START_STRING_OPTIONS.has(arg)
      || (arg.length === 2 && STRING_START_ALIASES.has(arg[1])))) {
      sanitized.push(arg)
      if (args[index + 1] !== undefined)
        sanitized.push(args[++index])
      continue
    }

    if (arg === '--github-token') {
      const value = args[index + 1]
      if (value !== undefined) {
        token = value
        index++
        continue
      }
    }
    else if (arg.startsWith('--github-token=')) {
      const value = arg.slice('--github-token='.length)
      if (value) {
        token = value
        continue
      }
    }
    else if (arg.startsWith('-') && !arg.startsWith('--')) {
      const compact = extractGithubTokenFromShortArgument(arg, args[index + 1])
      if (compact) {
        if (compact.prefix)
          sanitized.push(`-${compact.prefix}`)
        token = compact.token
        if (compact.consumedNext)
          index++
        continue
      }
    }

    sanitized.push(arg)
  }

  return {
    args: sanitized,
    ...(token !== undefined && { token }),
  }
}

function extractGithubTokenFromShortArgument(
  arg: string,
  next: string | undefined,
): { consumedNext: boolean, prefix: string, token: string } | undefined {
  let prefix = ''
  for (let index = 1; index < arg.length; index++) {
    const option = arg[index]
    if (BOOLEAN_START_ALIASES.has(option)) {
      prefix += option
      continue
    }

    if (STRING_START_ALIASES.has(option)) {
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
    if (next !== undefined) {
      return { consumedNext: true, prefix, token: next }
    }
    return undefined
  }
  return undefined
}
