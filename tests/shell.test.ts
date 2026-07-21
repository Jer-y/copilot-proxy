import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'

import { buildWindowsParentProcessNameScript, buildWindowsProcessChainScript, classifyWindowsShellProcess, classifyWindowsShellProcessChain, detectWindowsShell, generateEnvScript, generateShellCommand, WINDOWS_SHELL_DETECTION_TIMEOUT_MS } from '~/lib/shell'

function decodePowerShellCommand(command: string): string {
  const encoded = command.split(' ').at(-1)
  if (!encoded)
    throw new Error('Encoded PowerShell command is missing')
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

const testWindows = process.platform === 'win32' ? test : test.skip

function runGeneratedWindowsCommand(
  command: string,
  envOverrides: Record<string, string> = {},
) {
  const comspecKey = Object.keys(process.env).find(key => key.toLowerCase() === 'comspec') ?? 'ComSpec'
  const comspec = process.env[comspecKey] || 'cmd.exe'
  return spawnSync(comspec, ['/d', '/s', '/c', command], {
    cwd: process.env.SystemRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envOverrides,
    },
    windowsHide: true,
  })
}

function runGeneratedPowerShellCommand(
  executable: 'powershell.exe' | 'pwsh',
  command: string,
  envOverrides: Record<string, string> = {},
) {
  return spawnSync(executable, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], {
    cwd: process.env.SystemRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envOverrides,
    },
    windowsHide: true,
  })
}

describe('generateEnvScript', () => {
  test('quotes POSIX environment values', () => {
    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4899/v1?x=1&y=2',
        ANTHROPIC_MODEL: `model with 'quote`,
        EMPTY: undefined,
      },
      'claude',
      { shell: 'bash' },
    )

    expect(command).toBe(
      `export ANTHROPIC_BASE_URL='http://127.0.0.1:4899/v1?x=1&y=2' ANTHROPIC_MODEL='model with '\\''quote' && claude`,
    )
  })

  test('quotes fish environment values', () => {
    const command = generateEnvScript(
      {
        ANTHROPIC_MODEL: 'model with spaces',
      },
      'claude',
      { shell: 'fish' },
    )

    expect(command).toBe(`set -gx ANTHROPIC_MODEL 'model with spaces' && claude`)
  })

  test('quotes PowerShell environment values and uses a compatible separator', () => {
    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:4899/v1',
        ANTHROPIC_MODEL: `model with 'quote`,
      },
      'claude',
      { shell: 'powershell' },
    )

    expect(command).toBe(
      `$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:4899/v1'; $env:ANTHROPIC_MODEL = 'model with ''quote'; claude`,
    )
  })

  test('uses PowerShell syntax when the parent shell is pwsh', () => {
    const command = generateEnvScript(
      { ANTHROPIC_MODEL: `model with 'quote` },
      'claude',
      { shell: 'pwsh' },
    )

    expect(command).toBe(`$env:ANTHROPIC_MODEL = 'model with ''quote'; claude`)
  })

  test('keeps cmd from parsing environment values', () => {
    const command = generateEnvScript(
      {
        ANTHROPIC_MODEL: 'model with spaces',
      },
      'claude',
      { shell: 'cmd' },
    )

    expect(command).toStartWith('powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ')
    expect(decodePowerShellCommand(command)).toBe(
      `$env:ANTHROPIC_MODEL = 'model with spaces'; $command = 'claude'; & $env:ComSpec '/d' '/s' '/c' $command; exit $LASTEXITCODE`,
    )
  })

  test('encodes cmd metacharacters instead of exposing them to cmd expansion', () => {
    const value = `model'; Start-Process calc; '%PATH%!`
    const command = generateEnvScript(
      { ANTHROPIC_MODEL: value },
      'claude --print',
      { shell: 'cmd' },
    )

    expect(command).not.toContain('Start-Process')
    expect(command).not.toContain('%PATH%')
    expect(decodePowerShellCommand(command)).toContain(
      `$env:ANTHROPIC_MODEL = 'model''; Start-Process calc; ''%PATH%!'`,
    )
    expect(decodePowerShellCommand(command)).toContain(`$command = 'claude --print'`)
  })

  test('returns the command when there are no environment values', () => {
    expect(generateEnvScript({ EMPTY: undefined }, 'claude', { shell: 'bash' })).toBe('claude')
  })
})

describe('Windows shell detection', () => {
  test('recognizes Windows native shells and Git Bash', () => {
    expect(classifyWindowsShellProcess('powershell.exe\r\n')).toBe('powershell')
    expect(classifyWindowsShellProcess('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh')
    expect(classifyWindowsShellProcess('C:\\Program Files\\Git\\usr\\bin\\BASH.EXE')).toBe('bash')
    expect(classifyWindowsShellProcess('cmd.exe')).toBe('cmd')
  })

  test('uses a CIM parent-process query without WMIC', () => {
    const script = buildWindowsParentProcessNameScript(4321)

    expect(script).toContain('Get-CimInstance -ClassName Win32_Process')
    expect(script).toContain('-Filter \'ProcessId = 4321\'')
    expect(script.toLowerCase()).not.toContain('wmic')
  })

  test('walks through a one-shot cmd npm shim to the invoking PowerShell', () => {
    expect(classifyWindowsShellProcessChain([
      { name: 'cmd.exe', oneShot: true },
      { name: 'pwsh.exe' },
    ])).toBe('pwsh')
    expect(classifyWindowsShellProcessChain([
      { name: 'cmd.exe', oneShot: true },
      { name: 'powershell.exe' },
    ])).toBe('powershell')
  })

  test('walks through a one-shot cmd npm shim to the invoking Git Bash', () => {
    expect(classifyWindowsShellProcessChain([
      { name: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    ])).toBe('bash')
    expect(classifyWindowsShellProcessChain([
      { name: 'bun.exe' },
      { name: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    ])).toBe('bash')
    expect(classifyWindowsShellProcessChain([
      { name: 'cmd.exe', oneShot: true },
      { name: 'bun.exe' },
      { name: 'C:\\Program Files\\Git\\bin\\bash.exe' },
    ])).toBe('bash')
  })

  test('keeps interactive cmd syntax even when another shell is an ancestor', () => {
    expect(classifyWindowsShellProcessChain([
      { name: 'cmd.exe' },
      { name: 'powershell.exe' },
    ])).toBe('cmd')
    expect(classifyWindowsShellProcessChain([
      { name: 'cmd.exe' },
      { name: 'bash.exe' },
    ])).toBe('cmd')
    expect(classifyWindowsShellProcessChain([
      { name: 'cmd.exe', oneShot: true },
      { name: 'cmd.exe' },
    ])).toBe('cmd')
    expect(classifyWindowsShellProcessChain([
      { name: 'cmd.exe', oneShot: true },
      { name: 'cmd.exe', oneShot: true },
      { name: 'pwsh.exe' },
    ])).toBe('pwsh')
  })

  test('queries a bounded Windows ancestor chain as JSON', () => {
    const script = buildWindowsProcessChainScript(4321)

    expect(script).toContain('Get-CimInstance -ClassName Win32_Process')
    expect(script.match(/Get-CimInstance/g)).toHaveLength(1)
    expect(script).toContain('$processesById = @{}')
    expect(script).toContain('$processesById[$processId]')
    expect(script).toContain('$i -lt 8')
    expect(script).toContain('ConvertTo-Json')
    expect(script).toContain('OneShot = $oneShot')
    expect(script.toLowerCase()).not.toContain('wmic')
  })

  test('runs the single CIM snapshot with a hard timeout', () => {
    let invocation: {
      args: string[]
      file: string
      options: { timeout: number, windowsHide: boolean }
    } | undefined
    const shell = detectWindowsShell(4321, (file, args, options) => {
      invocation = { args, file, options }
      return '[{"Name":"cmd.exe","OneShot":true},{"Name":"bash.exe","OneShot":false}]'
    })

    expect(shell).toBe('bash')
    expect(invocation).toMatchObject({
      file: 'powershell.exe',
      options: {
        timeout: WINDOWS_SHELL_DETECTION_TIMEOUT_MS,
        windowsHide: true,
      },
    })
    const script = invocation?.args.at(-1) ?? ''
    expect(script.match(/Get-CimInstance/g)).toHaveLength(1)
  })

  test('falls back to cmd when the bounded CIM query fails or times out', () => {
    expect(detectWindowsShell(4321, () => {
      throw new Error('query timed out')
    })).toBe('cmd')
  })
})

describe('generateShellCommand', () => {
  const settings = '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4399"}}'

  test('quotes a JSON settings overlay for POSIX shells and wraps PowerShell shells', () => {
    expect(generateShellCommand('claude', ['--settings', settings], { shell: 'bash' })).toBe(
      `'claude' '--settings' '${settings}'`,
    )

    const powershell = generateShellCommand('claude', ['--settings', settings], { shell: 'powershell' })
    const pwsh = generateShellCommand('claude', ['--settings', settings], { shell: 'pwsh' })
    expect(powershell).toStartWith('powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ')
    expect(pwsh).toStartWith('pwsh -NoLogo -NoProfile -NonInteractive -EncodedCommand ')
    expect(decodePowerShellCommand(powershell)).toBe(decodePowerShellCommand(pwsh))
  })

  test('keeps cmd from parsing the JSON argument', () => {
    const command = generateShellCommand('claude', ['--settings', settings], { shell: 'cmd' })
    const decoded = decodePowerShellCommand(command)
    expect(decoded).toContain(`$ErrorActionPreference = 'Stop'`)
    expect(decoded).toContain(`$command = 'claude'`)
    expect(decoded).toContain(`$arguments = @('--settings', '${settings}')`)
    expect(decoded).toContain('-CommandType Application')
    expect(decoded).toContain(`& $env:ComSpec '/d' '/v:off' '/s' '/c' $cmdCommandLine`)
    expect(decoded).toContain('& $resolved.Source @arguments')
    expect(decoded).toContain('[Console]::Error.WriteLine($_.Exception.Message)')
    expect(decoded).not.toContain('& $command @arguments')
  })

  testWindows('uses a cmd shim under Restricted policy and preserves exact argv', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-shell-command-'))
    const commandName = 'copilot-proxy-argv-probe'
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path'
    const originalPath = process.env[pathKey] ?? ''
    const settingsWithMeta = JSON.stringify({
      env: {
        BANG: '!PATH!',
        META: '&|<>()^',
        PERCENT: '%PATH%',
        QUOTED: `a" & echo CMD_INJECTION & "b`,
        URL: 'http://127.0.0.1:4399/a b',
      },
    })

    try {
      fs.writeFileSync(
        path.join(fixtureDir, `${commandName}.cmd`),
        `@echo off\r\n"${process.execPath}" "%~dp0argv-probe.js" %*\r\n`,
      )
      fs.writeFileSync(
        path.join(fixtureDir, `${commandName}.ps1`),
        `throw 'PS1_SHIM_MUST_NOT_RUN'\r\n`,
      )
      fs.writeFileSync(
        path.join(fixtureDir, 'argv-probe.js'),
        `process.stdout.write(JSON.stringify(process.argv.slice(2)))\n`,
      )

      const command = generateShellCommand(
        commandName,
        ['--settings', settingsWithMeta],
        { shell: 'cmd' },
      )
      const result = runGeneratedWindowsCommand(command, {
        [pathKey]: `${fixtureDir};${originalPath}`,
        PSExecutionPolicyPreference: 'Restricted',
      })

      expect({
        error: result.error?.message,
        status: result.status,
        stderr: result.stderr,
      }).toEqual({
        error: undefined,
        status: 0,
        stderr: '',
      })
      expect(result.stdout).toBe(JSON.stringify(['--settings', settingsWithMeta]))
      expect(result.stderr).not.toContain('PS1_SHIM_MUST_NOT_RUN')
    }
    finally {
      fs.rmSync(fixtureDir, { force: true, recursive: true })
    }
  }, 15_000)

  testWindows('preserves exact argv through a standard cmd shim from PowerShell and pwsh', () => {
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-powershell-command-'))
    const commandName = 'copilot-proxy-powershell-argv-probe'
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path'
    const originalPath = process.env[pathKey] ?? ''
    const settingsWithQuotesAndSpaces = JSON.stringify({
      env: {
        MESSAGE: `quoted "value" with spaces`,
        URL: 'http://127.0.0.1:4399/a b',
      },
    })

    try {
      fs.writeFileSync(
        path.join(fixtureDir, `${commandName}.cmd`),
        `@echo off\r\n"${process.execPath}" "%~dp0argv-probe.js" %*\r\n`,
      )
      fs.writeFileSync(
        path.join(fixtureDir, `${commandName}.ps1`),
        `throw 'PS1_SHIM_MUST_NOT_RUN'\r\n`,
      )
      fs.writeFileSync(
        path.join(fixtureDir, 'argv-probe.js'),
        `process.stdout.write(JSON.stringify(process.argv.slice(2)))\n`,
      )

      for (const shell of ['powershell', 'pwsh'] as const) {
        const command = generateShellCommand(
          commandName,
          ['--settings', settingsWithQuotesAndSpaces],
          { shell },
        )
        const result = runGeneratedPowerShellCommand(
          shell === 'pwsh' ? 'pwsh' : 'powershell.exe',
          command,
          { [pathKey]: `${fixtureDir};${originalPath}` },
        )

        expect({
          error: result.error?.message,
          shell,
          status: result.status,
          stderr: result.stderr,
        }).toEqual({
          error: undefined,
          shell,
          status: 0,
          stderr: '',
        })
        expect(result.stdout).toBe(JSON.stringify(['--settings', settingsWithQuotesAndSpaces]))
        expect(result.stderr).not.toContain('PS1_SHIM_MUST_NOT_RUN')
      }
    }
    finally {
      fs.rmSync(fixtureDir, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('returns non-zero for command resolution and PowerShell wrapper failures', () => {
    const missing = generateShellCommand(
      'definitely-missing-copilot-proxy-command',
      [],
      { shell: 'cmd' },
    )
    const missingResult = runGeneratedWindowsCommand(missing)
    expect(missingResult.status).not.toBe(0)

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-shell-failure-'))
    const commandName = 'copilot-proxy-wrapper-failure'
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path'
    const comspecKey = Object.keys(process.env).find(key => key.toLowerCase() === 'comspec') ?? 'ComSpec'
    try {
      fs.writeFileSync(path.join(fixtureDir, `${commandName}.cmd`), '@exit /b 0\r\n')
      const command = generateShellCommand(commandName, [], { shell: 'cmd' })
      const wrapperFailure = runGeneratedWindowsCommand(command, {
        [comspecKey]: 'Z:\\definitely-missing\\cmd.exe',
        [pathKey]: `${fixtureDir};${process.env[pathKey] ?? ''}`,
      })
      expect(wrapperFailure.status).not.toBe(0)
    }
    finally {
      fs.rmSync(fixtureDir, { force: true, recursive: true })
    }
  }, 15_000)
})
