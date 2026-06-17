import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'
import { readLastLogLines, rotateDaemonLogIfNeeded } from '~/daemon/log-file'
import { PATHS } from '~/lib/paths'

const TASK_NAME = 'CopilotProxy'

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/**
 * Quote a single argument for Windows CommandLineToArgvW parsing.
 * See: https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
 */
function winQuoteArg(arg: string): string {
  if (arg.length > 0 && !/[\s"\\]/.test(arg))
    return arg

  let result = '"'
  for (let i = 0; i < arg.length; i++) {
    let numBackslashes = 0
    while (i < arg.length && arg[i] === '\\') {
      numBackslashes++
      i++
    }
    if (i >= arg.length) {
      // End of string: double all backslashes
      result += '\\'.repeat(numBackslashes * 2)
    }
    else if (arg[i] === '"') {
      // Before a quote: double backslashes, then escape the quote
      result += '\\'.repeat(numBackslashes * 2 + 1)
      result += '"'
    }
    else {
      // Not before a quote: keep backslashes as-is
      result += '\\'.repeat(numBackslashes)
      result += arg[i]
    }
  }
  result += '"'
  return result
}

/**
 * Detect whether conhost --headless is available (Win10 1809+).
 * Falls back to direct execution on older Windows versions.
 */
function supportsHeadlessConhost(): boolean {
  try {
    execFileSync('conhost.exe', ['--headless', 'cmd.exe', '/c', 'exit', '0'], {
      stdio: 'pipe',
      timeout: 5000,
    })
    return true
  }
  catch {
    return false
  }
}

interface BuildTaskXmlOptions {
  // Explicitly set for deterministic tests; undefined keeps runtime detection.
  useHeadlessConhost?: boolean
}

export function buildTaskXml(execPath: string, args: string[], options: BuildTaskXmlOptions = {}): string {
  const commandLine = [
    winQuoteArg(execPath),
    ...args.map(a => winQuoteArg(a)),
    '>>',
    winQuoteArg(PATHS.DAEMON_LOG),
    '2>&1',
  ].join(' ')

  const cmdArgs = `/d /s /c "${commandLine}"`

  // Use conhost --headless to hide console window when available
  const headless = options.useHeadlessConhost ?? supportsHeadlessConhost()
  let command: string
  let commandArgs: string
  if (headless) {
    command = 'conhost.exe'
    commandArgs = `--headless cmd.exe ${cmdArgs}`
  }
  else {
    if (options.useHeadlessConhost === undefined) {
      consola.warn('conhost --headless not supported, console window may briefly appear on startup')
    }
    command = 'cmd.exe'
    commandArgs = cmdArgs
  }

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escapeXmlAttr(command)}</Command>
      <Arguments>${escapeXmlAttr(commandArgs)}</Arguments>
    </Exec>
  </Actions>
</Task>`
}

export async function installAutoStart(execPath: string, args: string[]): Promise<boolean> {
  rotateDaemonLogIfNeeded()
  const taskXml = buildTaskXml(execPath, args)

  const tmpDir = os.tmpdir()
  const xmlPath = path.join(tmpDir, 'copilot-proxy-task.xml')

  try {
    // schtasks /create /xml requires a UTF-16 file *with* a BOM. Node's
    // 'utf16le' encoding does not emit one, so schtasks misreads the leading
    // '<' (0x3C 0x00) as '<' followed by NUL and fails with
    // "(1,2)::ERROR: one root element". Prepend a BOM so the file is valid.
    fs.writeFileSync(xmlPath, '\ufeff' + taskXml, { encoding: 'utf16le' })

    execFileSync('schtasks', [
      '/create',
      '/tn',
      TASK_NAME,
      '/xml',
      xmlPath,
      '/f',
    ], { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to create scheduled task:', error instanceof Error ? error.message : error)
    return false
  }
  finally {
    try {
      fs.unlinkSync(xmlPath)
    }
    catch {}
  }

  consola.success('Auto-start enabled via Task Scheduler')
  return true
}

export function isAutoStartInstalled(): boolean {
  try {
    execFileSync('schtasks', ['/query', '/tn', TASK_NAME], { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

export function stopAutoStartService(): boolean {
  if (!isAutoStartInstalled())
    return false

  try {
    execFileSync('schtasks', ['/end', '/tn', TASK_NAME], { stdio: 'inherit' })
    return true
  }
  catch (error) {
    consola.error('Failed to stop scheduled task:', error instanceof Error ? error.message : error)
    return false
  }
}

export function restartAutoStartService(): boolean {
  if (!isAutoStartInstalled())
    return false

  try {
    execFileSync('schtasks', ['/end', '/tn', TASK_NAME], { stdio: 'pipe' })
  }
  catch {
    // The task may not currently be running. Starting below is the important part.
  }

  rotateDaemonLogIfNeeded()

  try {
    execFileSync('schtasks', ['/run', '/tn', TASK_NAME], { stdio: 'inherit' })
    return true
  }
  catch (error) {
    consola.error('Failed to start scheduled task:', error instanceof Error ? error.message : error)
    return false
  }
}

export function showAutoStartStatus(): boolean {
  if (!isAutoStartInstalled())
    return false

  try {
    execFileSync('schtasks', ['/query', '/tn', TASK_NAME, '/v', '/fo', 'LIST'], { stdio: 'inherit' })
  }
  catch {
    // If the task exists but the query exits non-zero, do not fall back to the
    // legacy PID-file daemon and risk reporting a different control plane.
  }
  return true
}

export function showAutoStartLogs(options: { follow: boolean, lines: number }): boolean {
  if (!isAutoStartInstalled())
    return false

  if (!fs.existsSync(PATHS.DAEMON_LOG)) {
    consola.info('No native service log file found')
    return true
  }

  if (options.follow) {
    followLogFile(options.lines)
  }
  else {
    // eslint-disable-next-line no-console
    console.log(readLastLogLines(PATHS.DAEMON_LOG, options.lines))
  }
  return true
}

export async function uninstallAutoStart(): Promise<boolean> {
  try {
    execFileSync('schtasks', ['/end', '/tn', TASK_NAME], { stdio: 'pipe' })
  }
  catch {
    // Task may not be running, that's fine.
  }

  try {
    execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'pipe' })
  }
  catch (error) {
    consola.warn('Failed to delete scheduled task:', error instanceof Error ? error.message : error)
  }

  consola.success('Auto-start disabled')
  return true
}

function followLogFile(lineCount: number): void {
  const count = Number.isFinite(lineCount) ? lineCount : 50
  const content = readLastLogLines(PATHS.DAEMON_LOG, count)
  process.stdout.write(content)

  let position = fs.statSync(PATHS.DAEMON_LOG).size
  let currentIno: number | bigint = 0
  try {
    currentIno = fs.statSync(PATHS.DAEMON_LOG).ino
  }
  catch {}

  setInterval(() => {
    try {
      const stat = fs.statSync(PATHS.DAEMON_LOG)

      if (stat.ino !== currentIno) {
        currentIno = stat.ino
        position = 0
      }
      if (stat.size < position)
        position = 0
      if (stat.size > position) {
        const fd = fs.openSync(PATHS.DAEMON_LOG, 'r')
        const buffer = Buffer.alloc(stat.size - position)
        fs.readSync(fd, buffer, 0, buffer.length, position)
        fs.closeSync(fd)
        process.stdout.write(buffer)
        position = stat.size
      }
    }
    catch {
      // File may be absent briefly during rotation.
    }
  }, 500)
}
