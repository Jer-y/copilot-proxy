import { describe, expect, test } from 'bun:test'
import { buildTaskXml, commitAutoStartInstall, rollbackAutoStartInstall } from '../src/daemon/platform/win32'

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

  test('does not escape inner quotes with backslashes for cmd /s /c', () => {
    const xml = getDirectXml()
    expect(xml).toContain('/d /s /c &quot;&quot;C:\\Program Files\\nodejs\\node.exe&quot;')
    expect(xml).not.toContain('\\&quot;')
  })

  test('does not contain DisallowStartOnRemoteAppSession (requires v1.3+)', () => {
    expect(getHeadlessXml()).not.toContain('DisallowStartOnRemoteAppSession')
  })
})

test('Task Scheduler install transaction helpers are safe when no install is pending', () => {
  commitAutoStartInstall()
  expect(rollbackAutoStartInstall()).toBe(true)
})
