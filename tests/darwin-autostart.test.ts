import { describe, expect, test } from 'bun:test'

import { buildLaunchctlEnableArgs, buildLaunchctlKickstartArgs, commitAutoStartInstall, isLaunchdJobRunningOutput, rollbackAutoStartInstall, uninstallAutoStart } from '../src/daemon/platform/darwin'

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

  test('recognizes launchctl running state without relying on localized list output', () => {
    expect(isLaunchdJobRunningOutput('state = running\n')).toBe(true)
    expect(isLaunchdJobRunningOutput('state = exited\n')).toBe(false)
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
