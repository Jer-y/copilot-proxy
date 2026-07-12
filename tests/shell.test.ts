import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'bun:test'

import { buildWindowsParentProcessNameScript, classifyWindowsShellProcess, generateEnvScript } from '~/lib/shell'

function decodeCmdPowerShell(command: string): string {
  const encoded = command.split(' ').at(-1)
  if (!encoded)
    throw new Error('Encoded PowerShell command is missing')
  return Buffer.from(encoded, 'base64').toString('utf16le')
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
    expect(decodeCmdPowerShell(command)).toBe(
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
    expect(decodeCmdPowerShell(command)).toContain(
      `$env:ANTHROPIC_MODEL = 'model''; Start-Process calc; ''%PATH%!'`,
    )
    expect(decodeCmdPowerShell(command)).toContain(`$command = 'claude --print'`)
  })

  test('returns the command when there are no environment values', () => {
    expect(generateEnvScript({ EMPTY: undefined }, 'claude', { shell: 'bash' })).toBe('claude')
  })
})

describe('Windows shell detection', () => {
  test('recognizes Windows PowerShell and pwsh executables', () => {
    expect(classifyWindowsShellProcess('powershell.exe\r\n')).toBe('powershell')
    expect(classifyWindowsShellProcess('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh')
    expect(classifyWindowsShellProcess('cmd.exe')).toBe('cmd')
  })

  test('uses a CIM parent-process query without WMIC', () => {
    const script = buildWindowsParentProcessNameScript(4321)

    expect(script).toContain('Get-CimInstance -ClassName Win32_Process')
    expect(script).toContain('-Filter \'ProcessId = 4321\'')
    expect(script.toLowerCase()).not.toContain('wmic')
  })
})
