import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

export type ShellName = 'bash' | 'zsh' | 'fish' | 'powershell' | 'pwsh' | 'cmd' | 'sh'
type EnvVars = Record<string, string | undefined>

const SAFE_ENV_NAME = /^[A-Z_]\w*$/i

function getShell(): ShellName {
  const { platform, ppid, env } = process

  if (platform === 'win32') {
    try {
      const parentProcess = execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          buildWindowsParentProcessNameScript(ppid),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
      )
      return classifyWindowsShellProcess(parentProcess)
    }
    catch {
      return 'cmd'
    }
  }
  else {
    const shellPath = env.SHELL
    if (shellPath) {
      if (shellPath.endsWith('zsh'))
        return 'zsh'
      if (shellPath.endsWith('fish'))
        return 'fish'
      if (shellPath.endsWith('bash'))
        return 'bash'
    }

    return 'sh'
  }
}

/**
 * Generates a copy-pasteable script to set multiple environment variables
 * and run a subsequent command.
 * @param {EnvVars} envVars - An object of environment variables to set.
 * @param {string} commandToRun - The command to run after setting the variables.
 * @returns {string} The formatted script string.
 */
export function generateEnvScript(
  envVars: EnvVars,
  commandToRun: string = '',
  options?: {
    shell?: ShellName
  },
): string {
  const shell = options?.shell ?? getShell()
  const filteredEnvVars = Object.entries(envVars).filter(
    ([, value]) => value !== undefined,
  ) as Array<[string, string]>
  validateEnvVars(filteredEnvVars)

  let commandBlock: string

  switch (shell) {
    case 'pwsh':
    case 'powershell': {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `$env:${key} = ${quotePowerShell(value)}`)
        .join('; ')
      break
    }
    case 'cmd': {
      return generateCmdScript(filteredEnvVars, commandToRun)
    }
    case 'fish': {
      commandBlock = filteredEnvVars
        .map(([key, value]) => `set -gx ${key} ${quotePosix(value)}`)
        .join('; ')
      break
    }
    default: {
      // bash, zsh, sh
      const assignments = filteredEnvVars
        .map(([key, value]) => `${key}=${quotePosix(value)}`)
        .join(' ')
      commandBlock = filteredEnvVars.length > 0 ? `export ${assignments}` : ''
      break
    }
  }

  if (commandBlock && commandToRun) {
    const separator = shell === 'powershell' || shell === 'pwsh'
      ? '; '
      : ' && '
    return `${commandBlock}${separator}${commandToRun}`
  }

  return commandBlock || commandToRun
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`
}

export function buildWindowsParentProcessNameScript(ppid: number): string {
  if (!Number.isSafeInteger(ppid) || ppid <= 0)
    throw new Error('Windows parent PID must be a positive safe integer')

  return `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${ppid}'; if ($null -eq $process) { exit 1 }; [Console]::Out.Write([string]($process.Name))`
}

export function classifyWindowsShellProcess(processName: string): ShellName {
  const executable = processName.trim().toLowerCase().split(/[\\/]/).at(-1)
  if (executable === 'powershell' || executable === 'powershell.exe')
    return 'powershell'
  if (executable === 'pwsh' || executable === 'pwsh.exe')
    return 'pwsh'
  return 'cmd'
}

function validateEnvVars(envVars: Array<[string, string]>): void {
  for (const [key, value] of envVars) {
    if (!SAFE_ENV_NAME.test(key))
      throw new Error(`Unsafe environment variable name: ${key}`)
    if (value.includes('\0'))
      throw new Error(`Environment variable ${key} contains a NUL byte`)
  }
}

/**
 * cmd.exe has no reliable single-pass quoting for values containing quotes,
 * percent expansion, delayed-expansion markers, and newlines at the same time.
 * Run an encoded PowerShell child instead: the environment is set in that
 * process and inherited by the requested cmd command without exposing any
 * environment value to cmd.exe's parser.
 */
function generateCmdScript(
  envVars: Array<[string, string]>,
  commandToRun: string,
): string {
  if (envVars.length === 0)
    return commandToRun

  if (!commandToRun) {
    for (const [key, value] of envVars) {
      if (/[\r\n"%!]/.test(value)) {
        throw new Error(`Cannot safely persist environment variable ${key} in an interactive cmd session`)
      }
    }
    return envVars.map(([key, value]) => `set "${key}=${value}"`).join(' & ')
  }

  const script = [
    ...envVars.map(([key, value]) => `$env:${key} = ${quotePowerShell(value)}`),
    `$command = ${quotePowerShell(commandToRun)}`,
    `& $env:ComSpec '/d' '/s' '/c' $command`,
    'exit $LASTEXITCODE',
  ].join('; ')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}
