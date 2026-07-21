import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

export const SHELL_NAMES = ['bash', 'zsh', 'fish', 'powershell', 'pwsh', 'cmd', 'sh'] as const

export type ShellName = typeof SHELL_NAMES[number]

export interface WindowsProcessInfo {
  name: string
  oneShot?: boolean
}

interface WindowsShellQueryOptions {
  encoding: 'utf8'
  stdio: ['ignore', 'pipe', 'pipe']
  timeout: number
  windowsHide: boolean
}

type WindowsShellQueryExecutor = (
  file: string,
  args: string[],
  options: WindowsShellQueryOptions,
) => string

type EnvVars = Record<string, string | undefined>

const SAFE_ENV_NAME = /^[A-Z_]\w*$/i
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g
export const WINDOWS_SHELL_DETECTION_TIMEOUT_MS = 5_000

function getShell(): ShellName {
  const { platform, ppid, env } = process

  if (platform === 'win32') {
    return detectWindowsShell(ppid)
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

export function generateShellCommand(
  command: string,
  args: string[],
  options?: { shell?: ShellName },
): string {
  if (!command || command.includes('\0') || args.some(arg => arg.includes('\0')))
    throw new Error('Command and arguments must be non-empty and must not contain NUL bytes')

  const shell = options?.shell ?? getShell()
  if (shell === 'cmd' || shell === 'powershell' || shell === 'pwsh')
    return encodePowerShellCommand(buildWindowsApplicationScript(command, args), shell === 'pwsh' ? 'pwsh' : 'powershell.exe')

  return [command, ...args].map(quotePosix).join(' ')
}

function buildWindowsApplicationScript(command: string, args: string[]): string {
  const escapedArguments = args.map(escapeCmdShimArgument).join(' ')
  return [
    `$ErrorActionPreference = 'Stop';`,
    `$command = ${quotePowerShell(command)};`,
    `$arguments = @(${args.map(quotePowerShell).join(', ')});`,
    `$escapedArguments = ${quotePowerShell(escapedArguments)};`,
    'try {',
    '$resolved = @(Get-Command -Name ([System.Management.Automation.WildcardPattern]::Escape($command)) -CommandType Application -ErrorAction Stop)[0];',
    `if ($null -eq $resolved) { throw "Command not found: $command" };`,
    `$extension = [System.IO.Path]::GetExtension([string]$resolved.Source).ToLowerInvariant();`,
    '$LASTEXITCODE = $null;',
    `if ($extension -eq '.cmd' -or $extension -eq '.bat') {`,
    '$escapedCommand = [System.Text.RegularExpressions.Regex]::Replace([string]$resolved.Source, \'([()\\][%!^"`<>&|;, *?])\', \'^$1\');',
    `$cmdCommandLine = $escapedCommand + $(if ($escapedArguments) { ' ' + $escapedArguments } else { '' });`,
    `& $env:ComSpec '/d' '/v:off' '/s' '/c' $cmdCommandLine;`,
    '}',
    'else {',
    '& $resolved.Source @arguments;',
    '};',
    '$exitCode = $LASTEXITCODE;',
    `if ($null -eq $exitCode) { throw "Command did not report an exit code: $command" };`,
    'exit ([int]$exitCode);',
    '}',
    'catch {',
    '[Console]::Error.WriteLine($_.Exception.Message);',
    'exit 1;',
    '}',
  ].join(' ')
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`
}

/**
 * cmd shims forward their arguments through a second cmd.exe parse via `%*`.
 * Escape once for the outer ComSpec invocation and once for that shim layer.
 */
function escapeCmdShimArgument(value: string): string {
  let escaped = value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')

  escaped = `"${escaped}"`.replace(CMD_META_CHARS, '^$1')
  return escaped.replace(CMD_META_CHARS, '^$1')
}

export function buildWindowsParentProcessNameScript(ppid: number): string {
  if (!Number.isSafeInteger(ppid) || ppid <= 0)
    throw new Error('Windows parent PID must be a positive safe integer')

  return `$process = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${ppid}'; if ($null -eq $process) { exit 1 }; [Console]::Out.Write([string]($process.Name))`
}

export function buildWindowsProcessChainScript(ppid: number): string {
  if (!Number.isSafeInteger(ppid) || ppid <= 0)
    throw new Error('Windows parent PID must be a positive safe integer')

  return `$processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine); $processesById = @{}; foreach ($process in $processes) { $processesById[[uint32]$process.ProcessId] = $process }; $items = @(); $processId = [uint32]${ppid}; for ($i = 0; $i -lt 8 -and $processId -gt 0; $i++) { $process = $processesById[$processId]; if ($null -eq $process) { break }; $oneShot = [bool](([string]$process.Name -ieq 'cmd.exe') -and ([string]$process.CommandLine -match '(?:^|\\s)/c(?:\\s|$)')); $items += [PSCustomObject]@{ Name = [string]$process.Name; OneShot = $oneShot }; $processId = [uint32]$process.ParentProcessId }; [Console]::Out.Write((ConvertTo-Json -InputObject @($items) -Compress))`
}

export function detectWindowsShell(
  ppid: number,
  execute: WindowsShellQueryExecutor = executeWindowsShellQuery,
): ShellName {
  try {
    const processChain = execute(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        buildWindowsProcessChainScript(ppid),
      ],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: WINDOWS_SHELL_DETECTION_TIMEOUT_MS,
        windowsHide: true,
      },
    )
    return classifyWindowsShellProcessChain(parseWindowsProcessChain(processChain))
  }
  catch {
    return 'cmd'
  }
}

export function classifyWindowsShellProcess(processName: string): ShellName {
  return classifyKnownWindowsShell(processName) ?? 'cmd'
}

export function classifyWindowsShellProcessChain(processes: WindowsProcessInfo[]): ShellName {
  for (const [index, processInfo] of processes.entries()) {
    const shell = classifyKnownWindowsShell(processInfo.name)
    if (!shell)
      continue
    if (shell !== 'cmd')
      return shell
    if (!processInfo.oneShot)
      return 'cmd'

    for (const ancestor of processes.slice(index + 1)) {
      const ancestorShell = classifyKnownWindowsShell(ancestor.name)
      if (ancestorShell && (ancestorShell !== 'cmd' || !ancestor.oneShot))
        return ancestorShell
    }
    return 'cmd'
  }
  return 'cmd'
}

function parseWindowsProcessChain(value: string): WindowsProcessInfo[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed))
    throw new Error('Windows process chain query returned a non-array value')
  return parsed.flatMap((item): WindowsProcessInfo[] => {
    if (!item || typeof item !== 'object')
      return []
    const record = item as Record<string, unknown>
    if (typeof record.Name !== 'string')
      return []
    return [{
      name: record.Name,
      ...(typeof record.OneShot === 'boolean' && { oneShot: record.OneShot }),
    }]
  })
}

function classifyKnownWindowsShell(processName: string): ShellName | undefined {
  const executable = processName.trim().toLowerCase().split(/[\\/]/).at(-1)
  if (executable === 'bash' || executable === 'bash.exe')
    return 'bash'
  if (executable === 'powershell' || executable === 'powershell.exe')
    return 'powershell'
  if (executable === 'pwsh' || executable === 'pwsh.exe')
    return 'pwsh'
  if (executable === 'cmd' || executable === 'cmd.exe')
    return 'cmd'
}

function executeWindowsShellQuery(
  file: string,
  args: string[],
  options: WindowsShellQueryOptions,
): string {
  return execFileSync(file, args, options)
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
  return encodePowerShellCommand(script)
}

function encodePowerShellCommand(script: string, executable: 'powershell.exe' | 'pwsh' = 'powershell.exe'): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `${executable} -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`
}
