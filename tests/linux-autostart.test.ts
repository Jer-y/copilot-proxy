import { describe, expect, test } from 'bun:test'

import { buildSystemdUnit, commitAutoStartInstall, rollbackAutoStartInstall, shellQuote, shellQuoteForHelp } from '~/daemon/platform/linux'

describe('systemd shellQuote', () => {
  test('escapes systemd specifiers and dollar expansion', () => {
    expect(shellQuote('/tmp/app%dir/$bin/copilot proxy')).toBe('"/tmp/app%%dir/$$bin/copilot proxy"')
  })

  test('quotes user names for manual loginctl instructions', () => {
    expect(shellQuoteForHelp(`a'b`)).toBe(`'a'\\''b'`)
  })

  test('rejects newlines in systemd arguments', () => {
    expect(() => shellQuote('/tmp/app\nExecStart=/bin/false')).toThrow('newlines')
  })
})

test('systemd install transaction helpers are safe when no install is pending', () => {
  commitAutoStartInstall()
  expect(rollbackAutoStartInstall()).toBe(true)
})

describe('buildSystemdUnit', () => {
  test('runs foreground start under systemd rather than the app supervisor', () => {
    const unit = buildSystemdUnit('/usr/bin/node', ['/tmp/main.js', 'start', '--port', '4399'])

    expect(unit).toContain('ExecStart=/usr/bin/node /tmp/main.js start --port 4399')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).not.toContain('--_supervisor')
    expect(unit).not.toContain('StandardOutput=append:')
    expect(unit).not.toContain('StandardError=append:')
  })
})
