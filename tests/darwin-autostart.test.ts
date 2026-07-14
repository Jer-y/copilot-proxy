import { describe, expect, test } from 'bun:test'

import { buildLaunchctlDisableArgs, buildLaunchctlEnableArgs, buildLaunchctlKickstartArgs, captureAutoStartState, commitAutoStartInstall, isLaunchdJobEnabledOutput, isLaunchdJobRunningOutput, restoreAutoStartState, rollbackAutoStartInstall, uninstallAutoStart } from '../src/daemon/platform/darwin'

describe('launchd restart', () => {
  test('targets the GUI domain for reliable loaded-agent restarts', () => {
    expect(buildLaunchctlKickstartArgs(501)).toEqual([
      'kickstart',
      '-k',
      'gui/501/com.copilot-proxy',
    ])
  })

  test('falls back to the label when no user id is available', () => {
    expect(buildLaunchctlKickstartArgs()).toEqual([
      'kickstart',
      '-k',
      'com.copilot-proxy',
    ])
  })

  test('re-enables the same GUI-domain job before kickstart', () => {
    expect(buildLaunchctlEnableArgs(501)).toEqual([
      'enable',
      'gui/501/com.copilot-proxy',
    ])
  })

  test('targets the same GUI domain when restoring a disabled override', () => {
    expect(buildLaunchctlDisableArgs(501)).toEqual([
      'disable',
      'gui/501/com.copilot-proxy',
    ])
  })

  test('recognizes launchctl running state without relying on localized list output', () => {
    expect(isLaunchdJobRunningOutput('state = running\n')).toBe(true)
    expect(isLaunchdJobRunningOutput('state = exited\n')).toBe(false)
  })

  test('reads the persistent disabled override independently of loaded state', () => {
    expect(isLaunchdJobEnabledOutput('disabled services = {\n"com.copilot-proxy" => true\n}')).toBe(false)
    expect(isLaunchdJobEnabledOutput('disabled services = {\n"com.copilot-proxy" => false\n}')).toBe(true)
    expect(isLaunchdJobEnabledOutput('disabled services = {\n}')).toBe(true)
  })
})

describe('launchd replacement state', () => {
  test('captures the loaded and running state independently of install metadata', () => {
    expect(captureAutoStartState({
      isInstalled: () => true,
      isEnabled: () => false,
      inspect: () => ({ loaded: true, running: true }),
    })).toEqual({ installed: true, enabled: false, loaded: true, running: true })
  })

  test('reloads and restarts a previously running job, then restores its disabled override', () => {
    const calls: string[] = []
    let loaded = false
    expect(restoreAutoStartState(
      { installed: true, enabled: false, loaded: true, running: true },
      {
        disable: () => {
          calls.push('disable')
          return true
        },
        enable: () => {
          calls.push('enable')
          return true
        },
        isLoaded: () => loaded,
        isRunning: () => false,
        load: () => {
          calls.push('load')
          loaded = true
        },
        restart: () => {
          calls.push('restart')
          return true
        },
      },
    )).toBe(true)
    expect(calls).toEqual(['enable', 'load', 'restart', 'disable'])
  })

  test('keeps a previously unloaded job unloaded', () => {
    const calls: string[] = []
    expect(restoreAutoStartState(
      { installed: true, enabled: false, loaded: false, running: false },
      {
        disable: () => {
          calls.push('disable')
          return true
        },
        isLoaded: () => true,
        isRunning: () => true,
        stop: () => {
          calls.push('stop')
          return true
        },
        unload: () => { calls.push('unload') },
      },
    )).toBe(true)
    expect(calls).toEqual(['stop', 'unload', 'disable'])
  })
})

test('launchd install transaction helpers are safe when no install is pending', () => {
  commitAutoStartInstall()
  expect(rollbackAutoStartInstall()).toBe(true)
})

describe('launchd uninstall stop safety', () => {
  test('keeps the plist when stop fails', async () => {
    let unloadCalls = 0
    let removeCalls = 0

    const result = await uninstallAutoStart({
      isInstalled: () => true,
      isLoaded: () => true,
      stop: () => false,
      unload: () => { unloadCalls++ },
      removeDefinition: () => { removeCalls++ },
    })

    expect(result).toBe(false)
    expect(unloadCalls).toBe(0)
    expect(removeCalls).toBe(0)
  })

  test('keeps the plist when unload fails', async () => {
    let removeCalls = 0

    const result = await uninstallAutoStart({
      isInstalled: () => true,
      isLoaded: () => true,
      stop: () => true,
      unload: () => { throw new Error('unload failed') },
      removeDefinition: () => { removeCalls++ },
    })

    expect(result).toBe(false)
    expect(removeCalls).toBe(0)
  })

  test('removes the plist only after stop and unload succeed', async () => {
    let installed = true
    const calls: string[] = []

    const result = await uninstallAutoStart({
      isInstalled: () => installed,
      isLoaded: () => true,
      stop: () => {
        calls.push('stop')
        return true
      },
      unload: () => { calls.push('unload') },
      removeDefinition: () => {
        calls.push('remove')
        installed = false
      },
    })

    expect(result).toBe(true)
    expect(calls).toEqual(['stop', 'unload', 'remove'])
  })

  test('removes an unloaded plist without trying to stop or unload it', async () => {
    let installed = true
    const calls: string[] = []

    const result = await uninstallAutoStart({
      isInstalled: () => installed,
      isLoaded: () => false,
      stop: () => {
        calls.push('stop')
        return true
      },
      unload: () => { calls.push('unload') },
      removeDefinition: () => {
        calls.push('remove')
        installed = false
      },
    })

    expect(result).toBe(true)
    expect(calls).toEqual(['remove'])
  })

  test('preserves the plist when launchd state cannot be determined', async () => {
    let removeCalls = 0
    await expect(uninstallAutoStart({
      isInstalled: () => true,
      isLoaded: () => { throw new Error('launchctl unavailable') },
      removeDefinition: () => { removeCalls++ },
    })).rejects.toThrow('launchctl unavailable')
    expect(removeCalls).toBe(0)
  })
})
