import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

import { buildSystemdUnit, captureAutoStartState, commitAutoStartInstall, getSystemdUserServiceDir, restoreAutoStartState, rollbackAutoStartInstall, shellQuote, shellQuoteForHelp, uninstallAutoStart } from '~/daemon/platform/linux'

const LINUX_SOURCE = new URL('../src/daemon/platform/linux.ts', import.meta.url)

describe('systemd shellQuote', () => {
  test('escapes systemd specifiers and dollar expansion', () => {
    expect(shellQuote('/tmp/app%dir/$bin/copilot proxy')).toBe('"/tmp/app%%dir/$$bin/copilot proxy"')
  })

  test('doubles literal backslashes before systemd parses C-style escapes', () => {
    expect(shellQuote('C:\\temp\\new folder')).toBe('"C:\\\\temp\\\\new folder"')
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

describe('systemd user service path', () => {
  test('respects an absolute XDG_CONFIG_HOME', () => {
    expect(getSystemdUserServiceDir(
      { XDG_CONFIG_HOME: '/srv/user-config' },
      '/home/alice',
    )).toBe('/srv/user-config/systemd/user')
  })

  test('ignores a relative XDG_CONFIG_HOME per the XDG specification', () => {
    expect(getSystemdUserServiceDir(
      { XDG_CONFIG_HOME: 'relative/config' },
      '/home/alice',
    )).toBe('/home/alice/.config/systemd/user')
  })

  test('enables the persisted absolute unit path for custom XDG homes', () => {
    const source = readFileSync(LINUX_SOURCE, 'utf8')
    expect(source).toContain('[\'--user\', \'enable\', SERVICE_PATH]')
  })
})

describe('systemd replacement state', () => {
  test('captures enabled and running state before replacing an existing unit', () => {
    expect(captureAutoStartState({
      isInstalled: () => true,
      readProperty: property => property === 'ActiveState' ? 'active' : 'enabled',
    })).toEqual({ installed: true, enabled: true, running: true })
  })

  test('restores a previously disabled but running unit', () => {
    const calls: string[] = []
    expect(restoreAutoStartState(
      { installed: true, enabled: false, running: true },
      {
        disable: () => {
          calls.push('disable')
          return true
        },
        enable: () => {
          calls.push('enable')
          return true
        },
        restart: () => {
          calls.push('restart')
          return true
        },
        reload: () => {
          calls.push('reload')
          return true
        },
        stop: () => {
          calls.push('stop')
          return true
        },
      },
    )).toBe(true)
    expect(calls).toEqual(['reload', 'disable', 'restart'])
  })

  test('restores a previously enabled but stopped unit without starting it', () => {
    const calls: string[] = []
    expect(restoreAutoStartState(
      { installed: true, enabled: true, running: false },
      {
        disable: () => {
          calls.push('disable')
          return true
        },
        enable: () => {
          calls.push('enable')
          return true
        },
        restart: () => {
          calls.push('restart')
          return true
        },
        reload: () => {
          calls.push('reload')
          return true
        },
        stop: () => {
          calls.push('stop')
          return true
        },
      },
    )).toBe(true)
    expect(calls).toEqual(['reload', 'stop', 'enable'])
  })

  test('treats a restored-file daemon-reload failure as activation failure', () => {
    const calls: string[] = []
    expect(restoreAutoStartState(
      { installed: true, enabled: true, running: true },
      {
        enable: () => {
          calls.push('enable')
          return true
        },
        reload: () => {
          calls.push('reload')
          return false
        },
        restart: () => {
          calls.push('restart')
          return true
        },
      },
    )).toBe(false)
    expect(calls).toEqual(['reload'])
  })
})

describe('systemd uninstall stop safety', () => {
  test('keeps the definition when stop fails', async () => {
    let removeCalls = 0
    let disableCalls = 0

    const result = await uninstallAutoStart({
      isInstalled: () => true,
      stop: () => { throw new Error('stop failed') },
      disable: () => { disableCalls++ },
      removeDefinition: () => { removeCalls++ },
    })

    expect(result).toBe(false)
    expect(disableCalls).toBe(0)
    expect(removeCalls).toBe(0)
  })

  test('removes the definition only after stop and disable succeed', async () => {
    let installed = true
    const calls: string[] = []

    const result = await uninstallAutoStart({
      isInstalled: () => installed,
      stop: () => { calls.push('stop') },
      disable: () => { calls.push('disable') },
      removeDefinition: () => {
        calls.push('remove')
        installed = false
      },
      reload: () => { calls.push('reload') },
    })

    expect(result).toBe(true)
    expect(calls).toEqual(['stop', 'disable', 'remove', 'reload'])
  })
})
