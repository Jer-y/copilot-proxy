import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import consola from 'consola'
import { ensureDaemonLogFile, readLastLogLines, rotateDaemonLogIfNeeded } from '~/daemon/log-file'
import { PATHS } from '~/lib/paths'

const TASK_NAME = 'CopilotProxy'
const GRACEFUL_STOP_TIMEOUT_MS = 5_000
const TASK_STOP_POLL_INTERVAL_MS = 100
let pendingInstall: { previousTaskXml: string | undefined } | undefined

export interface UninstallAutoStartOptions {
  isInstalled?: () => boolean
  isRunning?: () => boolean
  requestGracefulStop?: () => boolean
  endTask?: () => void
  waitForStop?: () => boolean
  deleteTask?: () => void
}

export interface ScheduledTaskControlOptions {
  isInstalled?: () => boolean
  isRunning?: () => boolean
  requestGracefulStop?: () => boolean
  endTask?: () => void
  waitForStop?: () => boolean
  runTask?: () => void
}

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
  const usesProcessLogger = args.includes('--_log-file')
  const commandParts = [winQuoteArg(execPath), ...args.map(a => winQuoteArg(a))]
  // The process-level rotating writer must be able to rename daemon.log on
  // Windows. Keeping cmd.exe's append redirection open would lock that file.
  if (!usesProcessLogger)
    commandParts.push('>>', winQuoteArg(PATHS.DAEMON_LOG), '2>&1')
  const commandLine = commandParts.join(' ')

  const cmdArgs = `/d /s /c "${commandLine}"`

  // Use conhost --headless to hide console window when available
  const headless = options.useHeadlessConhost ?? supportsHeadlessConhost()
  let command: string
  let commandArgs: string
  if (usesProcessLogger && headless) {
    // No shell is needed when the process owns log rotation. Running the
    // executable directly prevents cmd.exe metacharacter and %VAR% expansion
    // in user-controlled arguments while conhost still hides the window.
    command = 'conhost.exe'
    commandArgs = `--headless ${commandLine}`
  }
  else if (usesProcessLogger) {
    command = execPath
    commandArgs = args.map(arg => winQuoteArg(arg)).join(' ')
  }
  else if (headless) {
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
  ensureDaemonLogFile()
  const taskXml = buildTaskXml(execPath, args)

  const tmpDir = os.tmpdir()
  const xmlPath = path.join(tmpDir, 'copilot-proxy-task.xml')
  const wasInstalled = isAutoStartInstalled()
  const previousTaskXml = wasInstalled ? readInstalledTaskXml() : undefined
  if (wasInstalled && !previousTaskXml) {
    consola.error('Cannot update scheduled task because its current definition could not be captured for rollback')
    return false
  }
  // Register the rollback state before any write or schtasks mutation. If an
  // unexpected exception escapes this function, enable.ts can still restore
  // the previous definition (or remove a partially-created new task).
  pendingInstall = { previousTaskXml }

  try {
    fs.writeFileSync(xmlPath, taskXml, { encoding: 'utf16le' })

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
    if (!rollbackAutoStartInstall())
      throw new Error('Failed to create scheduled task and roll back the previous definition', { cause: error })
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

export function commitAutoStartInstall(): void {
  pendingInstall = undefined
}

export function rollbackAutoStartInstall(): boolean {
  const install = pendingInstall
  if (!install)
    return true

  if (!stopReplacementTaskForRollback())
    return false

  if (!install.previousTaskXml) {
    if (!isAutoStartInstalled()) {
      pendingInstall = undefined
      return true
    }
    try {
      execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'pipe' })
      pendingInstall = undefined
      return true
    }
    catch (error) {
      consola.error('Failed to remove the replacement scheduled task:', error instanceof Error ? error.message : error)
      return false
    }
  }

  const rollbackPath = path.join(os.tmpdir(), `copilot-proxy-task-rollback-${process.pid}.xml`)
  try {
    fs.writeFileSync(rollbackPath, install.previousTaskXml, { encoding: 'utf16le' })
    execFileSync('schtasks', [
      '/create',
      '/tn',
      TASK_NAME,
      '/xml',
      rollbackPath,
      '/f',
    ], { stdio: 'pipe' })
    pendingInstall = undefined
    return true
  }
  catch (error) {
    consola.error('Failed to restore the previous scheduled task:', error instanceof Error ? error.message : error)
    return false
  }
  finally {
    fs.rmSync(rollbackPath, { force: true })
  }
}

function stopReplacementTaskForRollback(): boolean {
  if (!isScheduledTaskRunning())
    return true
  if (requestGracefulTaskStop())
    return true

  try {
    execFileSync('schtasks', ['/end', '/tn', TASK_NAME], { stdio: 'pipe' })
  }
  catch (error) {
    consola.error('Failed to stop replacement scheduled task during rollback:', error instanceof Error ? error.message : error)
    return false
  }
  if (waitForScheduledTaskStop())
    return true

  consola.error('Replacement scheduled task is still running; refusing to replace or delete its definition')
  return false
}

function readInstalledTaskXml(): string | undefined {
  try {
    return execFileSync(
      'schtasks',
      ['/query', '/tn', TASK_NAME, '/xml'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  }
  catch (error) {
    consola.warn('Could not capture the existing scheduled task for rollback:', error instanceof Error ? error.message : error)
    return undefined
  }
}

export function isAutoStartInstalled(): boolean {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference = 'Stop'; $tasks = @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq '${TASK_NAME}' }); if ($tasks.Count -gt 0) { 'installed' } else { 'absent' }`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
  if (output === 'installed')
    return true
  if (output === 'absent')
    return false
  throw new Error(`Unexpected Task Scheduler query result: ${output || '<empty>'}`)
}

export function stopAutoStartService(options: ScheduledTaskControlOptions = {}): boolean {
  const isInstalled = options.isInstalled ?? isAutoStartInstalled
  const isRunning = options.isRunning ?? isScheduledTaskRunning
  const gracefulStop = options.requestGracefulStop ?? requestGracefulTaskStop
  const endTask = options.endTask ?? (() => {
    execFileSync('schtasks', ['/end', '/tn', TASK_NAME], { stdio: 'inherit' })
  })
  const waitForStop = options.waitForStop ?? waitForScheduledTaskStop

  if (!isInstalled())
    return false

  if (!isRunning())
    return true

  if (gracefulStop())
    return true

  try {
    endTask()
  }
  catch (error) {
    consola.error('Failed to stop scheduled task:', error instanceof Error ? error.message : error)
    return false
  }

  if (!waitForStop()) {
    consola.error('Scheduled task is still running after schtasks /end')
    return false
  }
  return true
}

export function restartAutoStartService(options: ScheduledTaskControlOptions = {}): boolean {
  const isInstalled = options.isInstalled ?? isAutoStartInstalled
  const isRunning = options.isRunning ?? isScheduledTaskRunning
  const runTask = options.runTask ?? (() => {
    execFileSync('schtasks', ['/run', '/tn', TASK_NAME], { stdio: 'inherit' })
  })

  if (!isInstalled())
    return false

  if (isRunning() && !stopAutoStartService(options))
    return false

  rotateDaemonLogIfNeeded()
  ensureDaemonLogFile()

  try {
    runTask()
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

export async function uninstallAutoStart(options: UninstallAutoStartOptions = {}): Promise<boolean> {
  const isInstalled = options.isInstalled ?? isAutoStartInstalled
  const isRunning = options.isRunning ?? isScheduledTaskRunning
  const gracefulStop = options.requestGracefulStop ?? requestGracefulTaskStop
  const endTask = options.endTask ?? (() => {
    execFileSync('schtasks', ['/end', '/tn', TASK_NAME], { stdio: 'pipe' })
  })
  const waitForStop = options.waitForStop ?? waitForScheduledTaskStop
  const deleteTask = options.deleteTask ?? (() => {
    execFileSync('schtasks', ['/delete', '/tn', TASK_NAME, '/f'], { stdio: 'pipe' })
  })

  if (!isInstalled()) {
    consola.info('Auto-start service is not installed')
    return true
  }

  if (isRunning() && !gracefulStop()) {
    try {
      endTask()
    }
    catch (error) {
      consola.error('Failed to end scheduled task; refusing to delete a task that may still be running:', error instanceof Error ? error.message : error)
      return false
    }

    if (!waitForStop()) {
      consola.error('Scheduled task is still running after schtasks /end; refusing to delete it')
      return false
    }
  }

  try {
    deleteTask()
  }
  catch (error) {
    consola.error('Failed to delete scheduled task:', error instanceof Error ? error.message : error)
    return false
  }

  if (isInstalled()) {
    consola.error('Failed to delete scheduled task: task still exists after deletion')
    return false
  }

  consola.success('Auto-start disabled')
  return true
}

function waitForScheduledTaskStop(): boolean {
  const deadline = Date.now() + GRACEFUL_STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isScheduledTaskRunning())
      return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TASK_STOP_POLL_INTERVAL_MS)
  }
  return !isScheduledTaskRunning()
}

function isScheduledTaskRunning(): boolean {
  try {
    const state = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-ScheduledTask -TaskName '${TASK_NAME}').State.ToString()`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    return state.toLowerCase() === 'running'
  }
  catch {
    // Conservatively attempt graceful IPC if task state cannot be queried.
    return true
  }
}

function requestGracefulTaskStop(): boolean {
  try {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(PATHS.DAEMON_STOP, `${Date.now()}\n`, { mode: 0o600 })
  }
  catch (error) {
    consola.warn('Failed to request graceful scheduled-task shutdown:', error instanceof Error ? error.message : error)
    return false
  }

  const deadline = Date.now() + GRACEFUL_STOP_TIMEOUT_MS
  while (fs.existsSync(PATHS.DAEMON_STOP) && Date.now() < deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TASK_STOP_POLL_INTERVAL_MS)

  let acknowledged = !fs.existsSync(PATHS.DAEMON_STOP)
  if (acknowledged) {
    while (Date.now() < deadline) {
      if (!isScheduledTaskRunning())
        break
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TASK_STOP_POLL_INTERVAL_MS)
    }
  }
  acknowledged = acknowledged && !isScheduledTaskRunning()
  if (!acknowledged)
    fs.rmSync(PATHS.DAEMON_STOP, { force: true })
  return acknowledged
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
