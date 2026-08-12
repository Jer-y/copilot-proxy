import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeOwnerOnlyFileAtomically, writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory } from '../src/daemon/atomic-file'
import { buildTaskXml, captureAutoStartState, commitAutoStartInstall, encodeTaskSchedulerXml, restartAutoStartService, restoreAutoStartState, rollbackAutoStartInstall, uninstallAutoStart } from '../src/daemon/platform/win32'
import { ensureOwnerOnlyDirectories, hardenOwnerOnlyPaths } from '../src/lib/owner-only'

const WIN32_SOURCE = new URL('../src/daemon/platform/win32.ts', import.meta.url)

if (process.platform === 'win32')
  setDefaultTimeout(15_000)

describe('buildTaskXml', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const args = ['C:\\Users\\test\\.npm\\copilot-proxy\\main.js', 'start', '--port', '4399']

  function getHeadlessXml() {
    return buildTaskXml(execPath, args, { useHeadlessConhost: true })
  }

  function getDirectXml() {
    return buildTaskXml(execPath, args, { useHeadlessConhost: false })
  }

  test('uses Task schema version 1.2 for broad compatibility', () => {
    expect(getHeadlessXml()).toContain('version="1.2"')
  })

  test('sets ExecutionTimeLimit to PT0S (no timeout)', () => {
    expect(getHeadlessXml()).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
  })

  test('sets logon trigger with 30s delay', () => {
    const xml = getHeadlessXml()
    expect(xml).toContain('<LogonTrigger>')
    expect(xml).toContain('<Delay>PT30S</Delay>')
  })

  test('prevents multiple instances', () => {
    expect(getHeadlessXml()).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
  })

  test('allows running on battery power', () => {
    const xml = getHeadlessXml()
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>')
    expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
  })

  test('does not stop when idle', () => {
    const xml = getHeadlessXml()
    expect(xml).toContain('<RunOnlyIfIdle>false</RunOnlyIfIdle>')
    expect(xml).toContain('<StopOnIdleEnd>false</StopOnIdleEnd>')
  })

  test('enables start-when-available for missed triggers', () => {
    expect(getHeadlessXml()).toContain('<StartWhenAvailable>true</StartWhenAvailable>')
  })

  test('configures restart on failure', () => {
    const xml = getHeadlessXml()
    expect(xml).toContain('<RestartOnFailure>')
    expect(xml).toContain('<Interval>PT1M</Interval>')
    expect(xml).toContain('<Count>3</Count>')
  })

  test('hides task in Task Scheduler', () => {
    expect(getHeadlessXml()).toContain('<Hidden>true</Hidden>')
  })

  test('escapes XML special characters in paths', () => {
    const xml = buildTaskXml('C:\\node&<>.exe', ['arg with "quotes"'], { useHeadlessConhost: true })
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&lt;')
    expect(xml).toContain('&gt;')
  })

  test('quotes arguments with spaces for CommandLineToArgvW', () => {
    const xml = getHeadlessXml()
    expect(xml).toContain('C:\\Program Files\\nodejs\\node.exe')
  })

  test('uses conhost --headless command when enabled', () => {
    const xml = getHeadlessXml()
    expect(xml).toContain('<Command>conhost.exe</Command>')
    expect(xml).toContain('--headless')
    expect(xml).toContain('cmd.exe /d /s /c')
    expect(xml).toContain('C:\\Program Files\\nodejs\\node.exe')
  })

  test('falls back to cmd wrapper when headless is disabled', () => {
    const xml = getDirectXml()
    expect(xml).toContain('<Command>cmd.exe</Command>')
    expect(xml).not.toContain('<Command>conhost.exe</Command>')
  })

  test('redirects stdout and stderr to the daemon log', () => {
    const xml = getDirectXml()
    expect(xml).toContain('&gt;&gt;')
    expect(xml).toContain('daemon.log')
    expect(xml).toContain('2&gt;&amp;1')
  })

  test('does not hold the rotating daemon log open through cmd redirection', () => {
    const xml = buildTaskXml('C:\\node.exe', ['main.js', 'start', '--_log-file'], { useHeadlessConhost: true })
    expect(xml).not.toContain('&gt;&gt;')
    expect(xml).not.toContain('2&gt;&amp;1')
  })

  test('uses Citty semantics when deciding whether the process owns logging', () => {
    const disabledCases = [
      ['main.js', '--_log-file', 'start'],
      ['main.js', 'start', '--host', '--_log-file'],
      ['main.js', 'start', '--_log-file=false'],
      ['main.js', 'start', '--logFile', '--no-logFile'],
      ['main.js', 'start', '--', '--logFile'],
    ]
    for (const args of disabledCases) {
      const xml = buildTaskXml('C:\\node.exe', args, { useHeadlessConhost: true })
      expect({ args, redirected: xml.includes('&gt;&gt;') }).toEqual({
        args,
        redirected: true,
      })
    }

    const enabledCases = [
      ['main.js', 'start', '--logFile'],
      ['main.js', 'start', '---log-file'],
      ['main.js', 'start', '--host', '--', '--logFile'],
      ['main.js', 'start', '--no-logFile', '---log-file'],
    ]
    for (const args of enabledCases) {
      const xml = buildTaskXml('C:\\node.exe', args, { useHeadlessConhost: true })
      expect({ args, redirected: xml.includes('&gt;&gt;') }).toEqual({
        args,
        redirected: false,
      })
    }
  })

  test('process-rotated logging avoids cmd.exe interpretation of service arguments', () => {
    const xml = buildTaskXml(
      'C:\\Program Files\\nodejs\\node.exe',
      ['C:\\app\\main.js', 'start', '--host', '127.0.0.1&calc', '--_log-file'],
      { useHeadlessConhost: true },
    )

    expect(xml).toContain('<Command>conhost.exe</Command>')
    expect(xml).toContain('--headless')
    expect(xml).not.toContain('cmd.exe /d /s /c')
    expect(xml).toContain('127.0.0.1&amp;calc')
  })

  test('uses the shared persisted-environment bootstrap without embedding security settings or tokens', () => {
    const xml = buildTaskXml(
      'C:\\Program Files\\nodejs\\node.exe',
      [
        'C:\\app\\main.js',
        'start',
        '--_service',
        '--_data-dir',
        'C:\\Users\\alice\\AppData\\Local\\copilot-proxy',
        '--_log-file',
      ],
      { useHeadlessConhost: true },
    )

    expect(xml).toContain('--_service')
    expect(xml).toContain('--_data-dir')
    expect(xml).not.toContain('COPILOT_PROXY_ALLOWED_HOSTS')
    expect(xml).not.toContain('GITHUB_TOKEN')
  })

  test('does not escape inner quotes with backslashes for cmd /s /c', () => {
    const xml = getDirectXml()
    expect(xml).toContain('/d /s /c &quot;&quot;C:\\Program Files\\nodejs\\node.exe&quot;')
    expect(xml).not.toContain('\\&quot;')
  })

  test('does not contain DisallowStartOnRemoteAppSession (requires v1.3+)', () => {
    expect(getHeadlessXml()).not.toContain('DisallowStartOnRemoteAppSession')
  })
})

describe('Task Scheduler XML encoding', () => {
  const xml = '<?xml version="1.0" encoding="UTF-16"?><Task />'

  test('writes new task XML as UTF-16LE with the required BOM', () => {
    const encoded = encodeTaskSchedulerXml(xml)

    expect([...encoded.subarray(0, 4)]).toEqual([0xFF, 0xFE, 0x3C, 0x00])
    expect(encoded.toString('utf16le')).toBe(`\uFEFF${xml}`)
  })

  test('keeps exactly one BOM when encoding a captured task for rollback', () => {
    const encoded = encodeTaskSchedulerXml(`\uFEFF${xml}`)

    expect([...encoded.subarray(0, 6)]).toEqual([0xFF, 0xFE, 0x3C, 0x00, 0x3F, 0x00])
    expect(encoded.toString('utf16le')).toBe(`\uFEFF${xml}`)
  })
})

describe('Task Scheduler replacement state', () => {
  test('captures disabled and running task states before replacement', () => {
    expect(captureAutoStartState({
      isInstalled: () => true,
      readEnabled: () => false,
      readState: () => 'Running',
    })).toEqual({ installed: true, enabled: false, running: true })
    expect(captureAutoStartState({
      isInstalled: () => true,
      readEnabled: () => true,
      readState: () => 'Running',
    })).toEqual({ installed: true, enabled: true, running: true })
  })

  test('restarts a previously running task and restores its disabled flag', () => {
    const calls: string[] = []
    expect(restoreAutoStartState(
      { installed: true, enabled: false, running: true },
      {
        enable: () => {
          calls.push('enable')
          return true
        },
        disable: () => {
          calls.push('disable')
          return true
        },
        restart: () => {
          calls.push('restart')
          return true
        },
        stop: () => {
          calls.push('stop')
          return true
        },
      },
    )).toBe(true)
    expect(calls).toEqual(['enable', 'restart', 'disable'])
  })

  test('keeps a previously enabled but stopped task stopped', () => {
    const calls: string[] = []
    expect(restoreAutoStartState(
      { installed: true, enabled: true, running: false },
      {
        enable: () => {
          calls.push('enable')
          return true
        },
        disable: () => {
          calls.push('disable')
          return true
        },
        restart: () => {
          calls.push('restart')
          return true
        },
        stop: () => {
          calls.push('stop')
          return true
        },
      },
    )).toBe(true)
    expect(calls).toEqual(['stop', 'enable'])
  })
})

test('Task Scheduler install transaction helpers are safe when no install is pending', () => {
  commitAutoStartInstall()
  expect(rollbackAutoStartInstall()).toBe(true)
})

test('Task Scheduler install records rollback state before its first mutation', () => {
  const source = readFileSync(WIN32_SOURCE, 'utf8')
  const transactionStart = source.indexOf('pendingInstall = { previousTaskXml }')
  const firstMutation = source.indexOf('fs.writeFileSync(xmlPath, encodeTaskSchedulerXml(taskXml))')
  const handledFailureClear = source.indexOf('pendingInstall = undefined', transactionStart)

  expect(transactionStart).toBeGreaterThanOrEqual(0)
  expect(transactionStart).toBeLessThan(firstMutation)
  expect(handledFailureClear).toBeGreaterThan(firstMutation)
})

test('Task Scheduler install and rollback both use BOM-safe XML encoding', () => {
  const source = readFileSync(WIN32_SOURCE, 'utf8')

  expect(source).toContain('fs.writeFileSync(xmlPath, encodeTaskSchedulerXml(taskXml))')
  expect(source).toContain('fs.writeFileSync(rollbackPath, encodeTaskSchedulerXml(install.previousTaskXml))')
})

describe('uninstallAutoStart stop safety', () => {
  test('never deletes the task when schtasks /end fails', async () => {
    let deleteCalls = 0
    let waitCalls = 0

    const result = await uninstallAutoStart({
      isInstalled: () => true,
      isRunning: () => true,
      requestGracefulStop: () => false,
      endTask: () => { throw new Error('access denied') },
      waitForStop: () => {
        waitCalls++
        return true
      },
      deleteTask: () => { deleteCalls++ },
    })

    expect(result).toBe(false)
    expect(waitCalls).toBe(0)
    expect(deleteCalls).toBe(0)
  })

  test('never deletes the task until its stopped state is confirmed', async () => {
    let deleteCalls = 0

    const result = await uninstallAutoStart({
      isInstalled: () => true,
      isRunning: () => true,
      requestGracefulStop: () => false,
      endTask: () => {},
      waitForStop: () => false,
      deleteTask: () => { deleteCalls++ },
    })

    expect(result).toBe(false)
    expect(deleteCalls).toBe(0)
  })

  test('deletes only after forced stop is confirmed', async () => {
    let installed = true
    let endCalls = 0
    let deleteCalls = 0

    const result = await uninstallAutoStart({
      isInstalled: () => installed,
      isRunning: () => true,
      requestGracefulStop: () => false,
      endTask: () => { endCalls++ },
      waitForStop: () => true,
      deleteTask: () => {
        deleteCalls++
        installed = false
      },
    })

    expect(result).toBe(true)
    expect(endCalls).toBe(1)
    expect(deleteCalls).toBe(1)
  })
})

describe('Task Scheduler restart stop safety', () => {
  test('does not run a replacement when forced stop fails', () => {
    let runCalls = 0
    const result = restartAutoStartService({
      isInstalled: () => true,
      isRunning: () => true,
      requestGracefulStop: () => false,
      endTask: () => { throw new Error('access denied') },
      waitForStop: () => true,
      runTask: () => { runCalls++ },
    })

    expect(result).toBe(false)
    expect(runCalls).toBe(0)
  })

  test('does not run a replacement until stopped state is confirmed', () => {
    let runCalls = 0
    const result = restartAutoStartService({
      isInstalled: () => true,
      isRunning: () => true,
      requestGracefulStop: () => false,
      endTask: () => {},
      waitForStop: () => false,
      runTask: () => { runCalls++ },
    })

    expect(result).toBe(false)
    expect(runCalls).toBe(0)
  })

  test('runs exactly once after forced stop is confirmed', () => {
    let runCalls = 0
    const result = restartAutoStartService({
      isInstalled: () => true,
      isRunning: () => true,
      requestGracefulStop: () => false,
      endTask: () => {},
      waitForStop: () => true,
      runTask: () => { runCalls++ },
    })

    expect(result).toBe(true)
    expect(runCalls).toBe(1)
  })
})

describe('Windows owner-only ACL hardening', () => {
  const windowsTest = process.platform === 'win32' ? test : test.skip

  windowsTest('batches exact hardening and reuses a cached secure parent for inherited writes', () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-owner-only-'))
    const directoryPath = path.join(temporaryRoot, 'owner only & unicode-测试')
    const existingFilePath = path.join(directoryPath, 'existing secret.txt')
    const inheritedFilePath = path.join(directoryPath, 'inherited secret.txt')
    mkdirSync(directoryPath)
    writeFileSync(existingFilePath, 'secret')

    try {
      grantEveryoneRead(directoryPath, true)
      grantEveryoneRead(existingFilePath, false)

      const startedAt = Date.now()
      hardenOwnerOnlyPaths([
        { path: directoryPath, directory: true },
        { path: existingFilePath },
      ])
      for (let index = 0; index < 20; index++) {
        ensureOwnerOnlyDirectories([directoryPath])
        writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory(
          inheritedFilePath,
          `replacement-${index}`,
        )
      }
      expect(Date.now() - startedAt).toBeLessThan(5_000)

      assertCurrentUserAcls([
        { path: directoryPath, directory: true, inherited: false, protected: true },
        { path: existingFilePath, directory: false, inherited: false, protected: true },
        { path: inheritedFilePath, directory: false, inherited: true, protected: false },
      ])
    }
    finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  }, 10_000)

  windowsTest('keeps the default atomic writer exact without hardening its parent', () => {
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-owner-only-default-'))
    const filePath = path.join(temporaryRoot, 'control state.json')
    writeFileSync(filePath, 'old')

    try {
      grantEveryoneRead(temporaryRoot, true)
      grantEveryoneRead(filePath, false)
      writeOwnerOnlyFileAtomically(filePath, 'replacement')
      assertCurrentUserAcls([
        { path: temporaryRoot, hasEveryoneRead: true },
        { path: filePath, directory: false, inherited: false, protected: true },
      ])
    }
    finally {
      rmSync(temporaryRoot, { force: true, recursive: true })
    }
  }, 15_000)
})

function grantEveryoneRead(targetPath: string, directory: boolean): void {
  const executable = windowsSystemExecutable('icacls.exe')
  execFileSync(executable, [
    targetPath,
    '/grant',
    directory ? '*S-1-1-0:(OI)(CI)R' : '*S-1-1-0:R',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })
}

interface ExpectedWindowsAcl {
  path: string
  directory?: boolean
  hasEveryoneRead?: boolean
  inherited?: boolean
  protected?: boolean
}

function assertCurrentUserAcls(targets: ExpectedWindowsAcl[]): void {
  const targetsEnv = 'COPILOT_PROXY_TEST_ACL_TARGETS'
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$payload = [Environment]::GetEnvironmentVariable('${targetsEnv}', 'Process') | ConvertFrom-Json
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($entry in @($payload.targets)) {
  $acl = Get-Acl -LiteralPath ([string]$entry.path)
  $ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -ne $currentSid) { throw "Unexpected owner SID for $($entry.path): $ownerSid" }
  if ($null -ne $entry.protected -and $acl.AreAccessRulesProtected -ne [bool]$entry.protected) {
    throw "Unexpected DACL protection for $($entry.path): $($acl.AreAccessRulesProtected)"
  }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  if ([bool]$entry.hasEveryoneRead) {
    if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' })) {
      throw "Expected Everyone access for $($entry.path)."
    }
    continue
  }
  if ($rules.Count -ne 1) { throw "Expected exactly one access rule for $($entry.path), found $($rules.Count)." }
  $rule = $rules[0]
  if ($rule.IdentityReference.Value -ne $currentSid) { throw "Unexpected access SID for $($entry.path): $($rule.IdentityReference.Value)" }
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw "The only access rule for $($entry.path) is not Allow." }
  if ($null -ne $entry.inherited -and $rule.IsInherited -ne [bool]$entry.inherited) { throw "Unexpected inheritance state for $($entry.path)." }
  if ($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw "Unexpected rights for $($entry.path): $($rule.FileSystemRights)" }
  $expectedInheritance = if ([bool]$entry.directory) {
    [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [System.Security.AccessControl.InheritanceFlags]::None
  }
  if ($rule.InheritanceFlags -ne $expectedInheritance) { throw "Unexpected inheritance flags for $($entry.path): $($rule.InheritanceFlags)" }
  if ($rule.PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None) { throw "Unexpected propagation flags for $($entry.path): $($rule.PropagationFlags)" }
}
`
  const command = Buffer.from(script, 'utf16le').toString('base64')
  execFileSync(windowsPowerShellExecutable(), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    command,
  ], {
    env: {
      ...process.env,
      [targetsEnv]: JSON.stringify({ targets }),
    },
    stdio: 'ignore',
    windowsHide: true,
  })
}

function windowsSystemExecutable(...segments: string[]): string {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  if (!systemRoot)
    throw new Error('SystemRoot is unavailable on Windows')
  return path.win32.join(systemRoot, 'System32', ...segments)
}

function windowsPowerShellExecutable(): string {
  return windowsSystemExecutable('WindowsPowerShell', 'v1.0', 'powershell.exe')
}
