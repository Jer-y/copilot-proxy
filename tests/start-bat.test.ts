import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'

const START_BATCH = new URL('../start.bat', import.meta.url)
const READINESS_SCRIPT = new URL('../scripts/start-windows.ps1', import.meta.url)
const startBatch = readFileSync(START_BATCH, 'utf8')
const readinessScript = readFileSync(READINESS_SCRIPT, 'utf8')
const testWindows = process.platform === 'win32' ? test : test.skip
const testWindowsUnc = process.platform === 'win32' && import.meta.dir.startsWith('\\\\')
  ? test
  : test.skip

const fixtureServer = String.raw`
import { writeFileSync } from 'node:fs'

const startDelayMilliseconds = Number(process.env.TEST_START_DELAY_MILLISECONDS ?? 0)
const lifetimeMilliseconds = Number(process.env.TEST_LIFETIME_MILLISECONDS ?? 250)
const exitCode = Number(process.env.TEST_EXIT_CODE ?? 0)
const instanceTokenArgumentIndex = process.argv.indexOf('--_instance-token')
const instanceToken = process.env.TEST_FORCE_INSTANCE_TOKEN
  ?? (instanceTokenArgumentIndex === -1 ? undefined : process.argv[instanceTokenArgumentIndex + 1])

if (process.env.TEST_CWD_LOG)
  writeFileSync(process.env.TEST_CWD_LOG, process.cwd())
if (process.env.TEST_REPOSITORY_ROOT_ENV_LOG)
  writeFileSync(process.env.TEST_REPOSITORY_ROOT_ENV_LOG, process.env.COPILOT_PROXY_START_REPOSITORY_ROOT ?? '')
if (process.env.TEST_GITHUB_TOKEN_ENV_LOG)
  writeFileSync(process.env.TEST_GITHUB_TOKEN_ENV_LOG, String(Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)))
if (process.env.TEST_PID_LOG)
  writeFileSync(process.env.TEST_PID_LOG, String(process.pid))

await Bun.sleep(startDelayMilliseconds)

if (process.env.TEST_SKIP_LISTENER !== '1') {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.TEST_PORT),
    fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname === '/') {
        return new Response('Server running', {
          headers: instanceToken
            ? { 'x-copilot-proxy-instance-token': instanceToken }
            : undefined,
        })
      }
      if (pathname === '/livez')
        return Response.json({ status: 'ok' })
      if (pathname === '/diagnostics')
        return Response.json({ status: 'ready' })
      return new Response('not found', { status: 404 })
    },
  })
  writeFileSync(process.env.TEST_READY_LOG!, String(Date.now()))
  await Bun.sleep(lifetimeMilliseconds)
  await server.stop(true)
}

process.exit(exitCode)
`

const fixtureAuth = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

if (!process.argv.includes('auth') || !process.argv.includes('--_if-needed'))
  process.exit(64)

const environmentToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
const authExitCode = Number(process.env.TEST_AUTH_EXIT_CODE ?? 0)

if (process.env.TEST_AUTH_STARTED_LOG)
  writeFileSync(process.env.TEST_AUTH_STARTED_LOG, String(Date.now()))
if (process.env.TEST_AUTH_GITHUB_TOKEN_ENV_LOG)
  appendFileSync(process.env.TEST_AUTH_GITHUB_TOKEN_ENV_LOG, String(Boolean(environmentToken)) + '\n')
if (process.env.TEST_AUTH_TOKEN_ENV_LOG) {
  appendFileSync(process.env.TEST_AUTH_TOKEN_ENV_LOG, JSON.stringify({
    ghToken: process.env.GH_TOKEN === undefined ? 'missing' : process.env.GH_TOKEN === '' ? 'empty' : 'present',
    githubToken: process.env.GITHUB_TOKEN === undefined ? 'missing' : process.env.GITHUB_TOKEN === '' ? 'empty' : 'present',
  }) + '\n')
}

if (authExitCode === 0 && process.env.TEST_AUTH_PERSISTED_TOKEN_PATH) {
  if (environmentToken) {
    writeFileSync(process.env.TEST_AUTH_PERSISTED_TOKEN_PATH, environmentToken)
  }
  else if (process.env.TEST_AUTH_REQUIRE_PERSISTED_TOKEN === '1') {
    if (!existsSync(process.env.TEST_AUTH_PERSISTED_TOKEN_PATH)
      || !readFileSync(process.env.TEST_AUTH_PERSISTED_TOKEN_PATH, 'utf8').trim()) {
      process.exit(65)
    }
  }
}

await Bun.sleep(Number(process.env.TEST_AUTH_DELAY_MILLISECONDS ?? 0))

if (process.env.TEST_AUTH_FINISHED_LOG)
  writeFileSync(process.env.TEST_AUTH_FINISHED_LOG, String(Date.now()))

process.exit(authExitCode)
`

const fixtureInstallLifecycle = String.raw`
import { appendFileSync } from 'node:fs'

const phase = process.argv.at(-1) ?? 'unknown'

if (process.env.TEST_INSTALL_ENV_LOG) {
  appendFileSync(process.env.TEST_INSTALL_ENV_LOG, JSON.stringify({
    phase,
    ghToken: process.env.GH_TOKEN === undefined ? 'missing' : process.env.GH_TOKEN === '' ? 'empty' : 'present',
    githubToken: process.env.GITHUB_TOKEN === undefined ? 'missing' : process.env.GITHUB_TOKEN === '' ? 'empty' : 'present',
  }) + '\n')
}

if (process.env.TEST_INSTALL_FAILURE_PHASE === phase)
  process.exit(Number(process.env.TEST_INSTALL_EXIT_CODE ?? 1))
`

const fixtureBrowser = String.raw`
import { writeFileSync } from 'node:fs'

if (process.env.TEST_BROWSER_GITHUB_TOKEN_ENV_LOG)
  writeFileSync(process.env.TEST_BROWSER_GITHUB_TOKEN_ENV_LOG, String(Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)))
if (process.env.TEST_BROWSER_URL_LOG)
  writeFileSync(process.env.TEST_BROWSER_URL_LOG, process.argv.at(-1) ?? '')
`

function writeFixturePackage(directory: string, installRequired = false) {
  const packageJson: {
    dependencies?: Record<string, string>
    private: boolean
    scripts: Record<string, string>
  } = {
    private: true,
    scripts: { dev: 'bun run ./server.ts' },
  }

  if (installRequired) {
    const dependencyDirectory = path.join(directory, 'fixture-dependency')
    mkdirSync(dependencyDirectory)
    writeFileSync(path.join(dependencyDirectory, 'package.json'), JSON.stringify({
      name: 'fixture-dependency',
      version: '1.0.0',
    }))
    packageJson.dependencies = { 'fixture-dependency': 'file:./fixture-dependency' }
    packageJson.scripts.install = 'bun run ./install-lifecycle.ts install'
    packageJson.scripts.prepare = 'bun run ./install-lifecycle.ts prepare'
    writeFileSync(path.join(directory, 'install-lifecycle.ts'), fixtureInstallLifecycle)
  }

  writeFileSync(path.join(directory, 'package.json'), JSON.stringify(packageJson))
  writeFileSync(path.join(directory, 'server.ts'), fixtureServer)
  writeFileSync(path.join(directory, 'browser.ts'), fixtureBrowser)
  mkdirSync(path.join(directory, 'src'))
  writeFileSync(path.join(directory, 'src', 'main.ts'), fixtureAuth)
}

interface InstallLifecycleObservation {
  ghToken: 'empty' | 'missing' | 'present'
  githubToken: 'empty' | 'missing' | 'present'
  phase: string
}

function readInstallLifecycleObservations(logPath: string): InstallLifecycleObservation[] {
  return readFileSync(logPath, 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as InstallLifecycleObservation)
}

function createWindowsFixture(options: { installRequired?: boolean, parentDirectory?: string } = {}) {
  const directory = mkdtempSync(path.join(options.parentDirectory ?? os.tmpdir(), 'copilot-proxy-start-bat-'))
  if (!options.installRequired)
    mkdirSync(path.join(directory, 'node_modules'))
  mkdirSync(path.join(directory, 'scripts'))
  copyFileSync(START_BATCH, path.join(directory, 'start.bat'))
  copyFileSync(READINESS_SCRIPT, path.join(directory, 'scripts', 'start-windows.ps1'))
  writeFixturePackage(directory, options.installRequired)
  return directory
}

function createWindowsCallerFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-start-bat-caller-'))
  mkdirSync(path.join(directory, 'node_modules'))
  writeFixturePackage(directory)
  return directory
}

function runWindowsFixture(repositoryDirectory: string, callerDirectory: string, env: NodeJS.ProcessEnv) {
  const startBatchPath = path.join(repositoryDirectory, 'start.bat')
  return spawnSync('cmd.exe', ['/d', '/s', '/c', `call "${startBatchPath}"`], {
    cwd: callerDirectory,
    encoding: 'utf8',
    env: { ...process.env, ...env, TEMP: repositoryDirectory, TMP: repositoryDirectory },
    input: '\n',
    timeout: 15_000,
    windowsHide: true,
    windowsVerbatimArguments: true,
  })
}

function runWindowsPowerShellFixture(repositoryDirectory: string, callerDirectory: string, env: NodeJS.ProcessEnv) {
  const readinessScriptPath = path.join(repositoryDirectory, 'scripts', 'start-windows.ps1')
  return spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    readinessScriptPath,
  ], {
    cwd: callerDirectory,
    encoding: 'utf8',
    env: { ...process.env, ...env, TEMP: repositoryDirectory, TMP: repositoryDirectory },
    timeout: 15_000,
    windowsHide: true,
  })
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a Windows test port'))
        return
      }
      server.close(error => error ? reject(error) : resolve(address.port))
    })
  })
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function waitForFile(filePath: string, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds
  while (Date.now() < deadline) {
    if (existsSync(filePath))
      return
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for ${filePath}`)
}

function dashboardUrlFor(diagnosticsEndpoint: string): string {
  return `https://jer-y.github.io/copilot-proxy?endpoint=${encodeURIComponent(diagnosticsEndpoint)}`
}

describe('Windows development launcher', () => {
  test('opens the hosted diagnostics dashboard only through the readiness supervisor', () => {
    const watcherIndex = startBatch.indexOf('start-windows.ps1')

    expect(watcherIndex).toBeGreaterThan(-1)
    expect(startBatch).not.toMatch(/^start\s+""\s+"http:\/\/localhost:4399\/diagnostics"/m)
    expect(readinessScript).toContain('http://127.0.0.1:4399/')
    expect(readinessScript).toContain('https://jer-y.github.io/copilot-proxy?endpoint=')
    expect(readinessScript).toContain('[System.Uri]::EscapeDataString($diagnosticsEndpoint)')
    expect(readinessScript).toContain('Start-Process -FilePath $dashboardUrl')
    expect(readinessScript).toContain('$response.IsSuccessStatusCode')
    expect(readinessScript).toContain('$instanceHeaderName = \'x-copilot-proxy-instance-token\'')
    expect(readinessScript).toContain('$instanceHeaderValues -contains $instanceToken')
  })

  test('uses a direct bounded probe supervised with the foreground server', () => {
    const batchAuthIndex = startBatch.indexOf('auth --_if-needed')
    const batchAuthFailureIndex = startBatch.indexOf('goto auth_failed')
    const batchClearGhTokenIndex = startBatch.indexOf('set "GH_TOKEN="', batchAuthIndex)
    const batchClearGithubTokenIndex = startBatch.indexOf('set "GITHUB_TOKEN="', batchAuthIndex)
    const watcherIndex = startBatch.indexOf('start-windows.ps1')
    const powershellAuthIndex = readinessScript.indexOf('auth --_if-needed')
    const powershellClearGhTokenIndex = readinessScript.indexOf('Remove-Item Env:GH_TOKEN')
    const powershellClearGithubTokenIndex = readinessScript.indexOf('Remove-Item Env:GITHUB_TOKEN')
    const serverStartIndex = readinessScript.indexOf('$serverProcess = [System.Diagnostics.Process]::Start')
    const browserStartIndex = readinessScript.indexOf('Start-Process -FilePath $dashboardUrl')

    expect(batchAuthIndex).toBeGreaterThan(-1)
    expect(batchClearGhTokenIndex).toBeGreaterThan(batchAuthIndex)
    expect(batchClearGithubTokenIndex).toBeGreaterThan(batchAuthIndex)
    expect(batchClearGhTokenIndex).toBeLessThan(batchAuthFailureIndex)
    expect(batchClearGithubTokenIndex).toBeLessThan(batchAuthFailureIndex)
    expect(watcherIndex).toBeGreaterThan(batchClearGhTokenIndex)
    expect(watcherIndex).toBeGreaterThan(batchClearGithubTokenIndex)
    expect(watcherIndex).toBeGreaterThan(batchAuthIndex)
    expect(startBatch).toContain('-AuthenticationPreflightCompleted')
    expect(powershellAuthIndex).toBeGreaterThan(-1)
    expect(powershellClearGhTokenIndex).toBeGreaterThan(powershellAuthIndex)
    expect(powershellClearGithubTokenIndex).toBeGreaterThan(powershellAuthIndex)
    expect(serverStartIndex).toBeGreaterThan(powershellClearGhTokenIndex)
    expect(serverStartIndex).toBeGreaterThan(powershellClearGithubTokenIndex)
    expect(browserStartIndex).toBeGreaterThan(serverStartIndex)
    expect(readinessScript).toContain('Add-Type -AssemblyName System.Net.Http')
    expect(readinessScript).toContain('$handler.UseProxy = $false')
    expect(readinessScript).toContain('$timeoutSeconds = 90')
    expect(readinessScript).toContain('$processStartInfo.FileName = \'bun.exe\'')
    expect(readinessScript).toContain('run dev -- --_instance-token $instanceToken')
    expect(readinessScript).toContain('(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot \'..\')).ProviderPath')
    expect(readinessScript).toContain('$processStartInfo.WorkingDirectory = $repositoryRoot')
    expect(readinessScript).toContain('$authProcessStartInfo.WorkingDirectory = $repositoryRoot')
    expect(readinessScript).toContain('$serverProcess.WaitForExit()')
    expect(readinessScript).toContain('taskkill.exe /PID $serverProcess.Id /T /F')
    expect(readinessScript).toContain('The server did not become ready within $timeoutSeconds seconds. Stopping it.')
    expect(readinessScript).not.toContain('the server remains attached to this window.')
  })

  test('isolates dependency setup from credentials and restores the caller directory', () => {
    const pushIndex = startBatch.indexOf('pushd "%repo_root%"')
    const dependencyIndex = startBatch.indexOf('if exist node_modules')
    const installScopeIndex = startBatch.indexOf('setlocal', dependencyIndex)
    const installClearGhTokenIndex = startBatch.indexOf('set "GH_TOKEN="', installScopeIndex)
    const installClearGithubTokenIndex = startBatch.indexOf('set "GITHUB_TOKEN="', installScopeIndex)
    const installIndex = startBatch.indexOf('bun install')
    const installExitCaptureIndex = startBatch.indexOf('set "install_exit=%errorlevel%"')
    const installScopeEndIndex = startBatch.indexOf('endlocal & set "install_exit=%install_exit%"')
    const authIndex = startBatch.indexOf('auth --_if-needed')
    const popIndex = startBatch.indexOf('popd')

    expect(startBatch).toContain('set "repo_root=%~dp0"')
    expect(startBatch).toContain('set "COPILOT_PROXY_START_REPOSITORY_ROOT=%CD%"')
    expect(pushIndex).toBeGreaterThan(-1)
    expect(dependencyIndex).toBeGreaterThan(pushIndex)
    expect(installScopeIndex).toBeGreaterThan(dependencyIndex)
    expect(installClearGhTokenIndex).toBeGreaterThan(installScopeIndex)
    expect(installClearGithubTokenIndex).toBeGreaterThan(installScopeIndex)
    expect(installIndex).toBeGreaterThan(installClearGhTokenIndex)
    expect(installIndex).toBeGreaterThan(installClearGithubTokenIndex)
    expect(installExitCaptureIndex).toBeGreaterThan(installIndex)
    expect(installScopeEndIndex).toBeGreaterThan(installExitCaptureIndex)
    expect(authIndex).toBeGreaterThan(installScopeEndIndex)
    expect(popIndex).toBeGreaterThan(installIndex)
    expect(startBatch).toContain('endlocal & exit /b %install_exit%')
    expect(readinessScript).toContain('$env:COPILOT_PROXY_START_REPOSITORY_ROOT')
    expect(readinessScript).toContain('(Resolve-Path -LiteralPath $env:COPILOT_PROXY_START_REPOSITORY_ROOT).ProviderPath')
    expect(readinessScript).toContain('Remove-Item Env:COPILOT_PROXY_START_REPOSITORY_ROOT')
    expect(readinessScript).toContain('Remove-Item Env:GH_TOKEN')
    expect(readinessScript).toContain('Remove-Item Env:GITHUB_TOKEN')
    expect(readinessScript).toContain('EnvironmentVariables.Remove(\'GH_TOKEN\')')
    expect(readinessScript).toContain('EnvironmentVariables.Remove(\'GITHUB_TOKEN\')')
  })

  test('preserves the foreground Bun exit code across the double-click pause', () => {
    const captureIndex = startBatch.indexOf('set "server_exit=%errorlevel%"')
    const pauseIndex = startBatch.indexOf('pause')
    const exitIndex = startBatch.indexOf('endlocal & exit /b %server_exit%')

    expect(captureIndex).toBeGreaterThan(-1)
    expect(pauseIndex).toBeGreaterThan(captureIndex)
    expect(exitIndex).toBeGreaterThan(pauseIndex)
    expect(startBatch).toContain('set "server_exit=%errorlevel%"')
    expect(startBatch).toContain('endlocal & exit /b %server_exit%')
  })
})

describe('Windows development launcher native integration', () => {
  testWindows('waits for a real Windows Bun listener and returns its exact exit code', async () => {
    const directory = createWindowsFixture({ installRequired: true })
    const callerDirectory = createWindowsCallerFixture()
    const readyLog = path.join(directory, 'ready.log')
    const openLog = path.join(directory, 'open.log')
    const cwdLog = path.join(directory, 'cwd.log')
    const port = await getAvailablePort()

    try {
      const result = runWindowsFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_OPEN_LOG: openLog,
        COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '50',
        COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '5',
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        TEST_EXIT_CODE: '23',
        TEST_CWD_LOG: cwdLog,
        TEST_LIFETIME_MILLISECONDS: '800',
        TEST_PORT: String(port),
        TEST_READY_LOG: readyLog,
        TEST_START_DELAY_MILLISECONDS: '600',
      })

      expect(result.error).toBeUndefined()
      if (result.status !== 23)
        throw new Error(`Windows launcher exited with ${result.status}. stdout: ${result.stdout}; stderr: ${result.stderr}`)
      expect(result.status).toBe(23)
      expect(path.resolve(readFileSync(cwdLog, 'utf8'))).toBe(path.resolve(directory))
      expect(existsSync(path.join(directory, 'node_modules', 'fixture-dependency', 'package.json'))).toBe(true)
      expect(readFileSync(openLog, 'utf8')).toBe(dashboardUrlFor(`http://127.0.0.1:${port}/diagnostics`))
      expect(statSync(openLog).mtimeMs).toBeGreaterThanOrEqual(statSync(readyLog).mtimeMs)
    }
    finally {
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('does not open diagnostics when Bun exits before listening', async () => {
    const directory = createWindowsFixture()
    const callerDirectory = createWindowsCallerFixture()
    const openLog = path.join(directory, 'open.log')
    const port = await getAvailablePort()

    try {
      const result = runWindowsFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_OPEN_LOG: openLog,
        COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '50',
        COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '5',
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        TEST_EXIT_CODE: '19',
        TEST_PORT: String(port),
        TEST_READY_LOG: path.join(directory, 'ready.log'),
        TEST_SKIP_LISTENER: '1',
        TEST_START_DELAY_MILLISECONDS: '250',
      })

      expect(result.error).toBeUndefined()
      if (result.status !== 19)
        throw new Error(`Windows launcher exited with ${result.status}. stdout: ${result.stdout}; stderr: ${result.stderr}`)
      expect(result.status).toBe(19)
      expect(existsSync(openLog)).toBe(false)
    }
    finally {
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('keeps first-run authentication outside the readiness deadline', async () => {
    const directory = createWindowsFixture()
    const callerDirectory = createWindowsCallerFixture()
    const authStartedLog = path.join(directory, 'auth-started.log')
    const authFinishedLog = path.join(directory, 'auth-finished.log')
    const readyLog = path.join(directory, 'ready.log')
    const openLog = path.join(directory, 'open.log')
    const port = await getAvailablePort()

    try {
      const result = runWindowsFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_OPEN_LOG: openLog,
        COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '25',
        COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '1',
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        TEST_AUTH_DELAY_MILLISECONDS: '1500',
        TEST_AUTH_FINISHED_LOG: authFinishedLog,
        TEST_AUTH_STARTED_LOG: authStartedLog,
        TEST_EXIT_CODE: '37',
        TEST_LIFETIME_MILLISECONDS: '300',
        TEST_PORT: String(port),
        TEST_READY_LOG: readyLog,
        TEST_START_DELAY_MILLISECONDS: '100',
      })

      expect(result.error).toBeUndefined()
      if (result.status !== 37)
        throw new Error(`Windows launcher exited with ${result.status}. stdout: ${result.stdout}; stderr: ${result.stderr}`)
      expect(result.status).toBe(37)
      expect(result.stderr).not.toContain('The server did not become ready within 1 seconds.')
      expect(Number(readFileSync(authFinishedLog, 'utf8')) - Number(readFileSync(authStartedLog, 'utf8'))).toBeGreaterThanOrEqual(1_300)
      expect(Number(readFileSync(readyLog, 'utf8'))).toBeGreaterThanOrEqual(Number(readFileSync(authFinishedLog, 'utf8')))
      expect(readFileSync(openLog, 'utf8')).toBe(dashboardUrlFor(`http://127.0.0.1:${port}/diagnostics`))
    }
    finally {
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('returns an install failure before authentication without restoring credentials to a child', async () => {
    const directory = createWindowsFixture({ installRequired: true })
    const callerDirectory = createWindowsCallerFixture()
    const authStartedLog = path.join(directory, 'auth-started.log')
    const installTokenLog = path.join(directory, 'install-token.log')
    const pidLog = path.join(directory, 'pid.log')
    const token = 'ghu_install_failure_%PATH%_!bang!_^caret^_&pipe|_<angle>_"quote"'

    try {
      const result = runWindowsFixture(directory, callerDirectory, {
        GH_TOKEN: token,
        GITHUB_TOKEN: '',
        TEST_AUTH_STARTED_LOG: authStartedLog,
        TEST_INSTALL_ENV_LOG: installTokenLog,
        TEST_INSTALL_EXIT_CODE: '1',
        TEST_INSTALL_FAILURE_PHASE: 'install',
        TEST_PID_LOG: pidLog,
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(readInstallLifecycleObservations(installTokenLog)).toEqual([
        { phase: 'install', ghToken: 'missing', githubToken: 'missing' },
      ])
      expect(existsSync(authStartedLog)).toBe(false)
      expect(existsSync(pidLog)).toBe(false)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
    }
    finally {
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('preserves authentication failure after restoring the credential from the install scope', async () => {
    const directory = createWindowsFixture({ installRequired: true })
    const callerDirectory = createWindowsCallerFixture()
    const authTokenLog = path.join(directory, 'auth-token.log')
    const installTokenLog = path.join(directory, 'install-token.log')
    const openLog = path.join(directory, 'open.log')
    const pidLog = path.join(directory, 'pid.log')
    const readyLog = path.join(directory, 'ready.log')
    const port = await getAvailablePort()
    const token = 'github_pat_auth_failure_%TEMP%_!bang!_^caret^_&pipe|_<angle>_"quote"'

    try {
      const result = runWindowsFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_OPEN_LOG: openLog,
        COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '25',
        COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '1',
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        GH_TOKEN: '',
        GITHUB_TOKEN: token,
        TEST_AUTH_EXIT_CODE: '41',
        TEST_AUTH_GITHUB_TOKEN_ENV_LOG: authTokenLog,
        TEST_INSTALL_ENV_LOG: installTokenLog,
        TEST_PID_LOG: pidLog,
        TEST_PORT: String(port),
        TEST_READY_LOG: readyLog,
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(41)
      expect(readInstallLifecycleObservations(installTokenLog)).toEqual([
        { phase: 'install', ghToken: 'missing', githubToken: 'missing' },
        { phase: 'prepare', ghToken: 'missing', githubToken: 'missing' },
      ])
      expect(readFileSync(authTokenLog, 'utf8')).toBe('true\n')
      expect(existsSync(pidLog)).toBe(false)
      expect(existsSync(readyLog)).toBe(false)
      expect(existsSync(openLog)).toBe(false)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
    }
    finally {
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('hides each environment token from install lifecycles but restores it once for authentication', async () => {
    const credentials = [
      {
        environmentName: 'GH_TOKEN',
        token: 'ghu_windows_%PATH%_!bang!_^caret^_&pipe|_<angle>_"quote"',
      },
      {
        environmentName: 'GITHUB_TOKEN',
        token: 'github_pat_windows_%TEMP%_!alias!_^caret^_&pipe|_<angle>_"quote"',
      },
    ] as const

    for (const [index, credential] of credentials.entries()) {
      const directory = createWindowsFixture({ installRequired: true })
      const callerDirectory = createWindowsCallerFixture()
      const authTokenLog = path.join(directory, 'auth-token.log')
      const authTokenStateLog = path.join(directory, 'auth-token-state.log')
      const browserTokenLog = path.join(directory, 'browser-token.log')
      const browserUrlLog = path.join(directory, 'browser-url.log')
      const installTokenLog = path.join(directory, 'install-token.log')
      const persistedTokenPath = path.join(directory, 'persisted-token')
      const serverTokenLog = path.join(directory, 'server-token.log')
      const port = await getAvailablePort()
      const expectedAuthState = credential.environmentName === 'GH_TOKEN'
        ? { ghToken: 'present', githubToken: 'empty' }
        : { ghToken: 'empty', githubToken: 'present' }

      try {
        const result = runWindowsFixture(directory, callerDirectory, {
          COPILOT_PROXY_START_BROWSER_ARGUMENT: path.join(directory, 'browser.ts'),
          COPILOT_PROXY_START_BROWSER_COMMAND: process.execPath,
          COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
          COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '25',
          COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '5',
          COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
          GH_TOKEN: credential.environmentName === 'GH_TOKEN' ? credential.token : '',
          GITHUB_TOKEN: credential.environmentName === 'GITHUB_TOKEN' ? credential.token : '',
          TEST_AUTH_GITHUB_TOKEN_ENV_LOG: authTokenLog,
          TEST_AUTH_PERSISTED_TOKEN_PATH: persistedTokenPath,
          TEST_AUTH_REQUIRE_PERSISTED_TOKEN: '1',
          TEST_AUTH_TOKEN_ENV_LOG: authTokenStateLog,
          TEST_BROWSER_GITHUB_TOKEN_ENV_LOG: browserTokenLog,
          TEST_BROWSER_URL_LOG: browserUrlLog,
          TEST_EXIT_CODE: String(43 + index),
          TEST_GITHUB_TOKEN_ENV_LOG: serverTokenLog,
          TEST_INSTALL_ENV_LOG: installTokenLog,
          TEST_LIFETIME_MILLISECONDS: '600',
          TEST_PORT: String(port),
          TEST_READY_LOG: path.join(directory, 'ready.log'),
        })

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(43 + index)
        await waitForFile(browserTokenLog)
        expect(readInstallLifecycleObservations(installTokenLog)).toEqual([
          { phase: 'install', ghToken: 'missing', githubToken: 'missing' },
          { phase: 'prepare', ghToken: 'missing', githubToken: 'missing' },
        ])
        expect(readFileSync(authTokenLog, 'utf8')).toBe('true\n')
        expect(readFileSync(authTokenStateLog, 'utf8').trim().split(/\r?\n/)).toEqual([
          JSON.stringify(expectedAuthState),
        ])
        expect(readFileSync(persistedTokenPath, 'utf8')).toBe(credential.token)
        expect(readFileSync(serverTokenLog, 'utf8')).toBe('false')
        expect(readFileSync(browserTokenLog, 'utf8')).toBe('false')
        expect(readFileSync(browserUrlLog, 'utf8')).toBe(dashboardUrlFor(`http://127.0.0.1:${port}/diagnostics`))
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(credential.token)
      }
      finally {
        await Bun.sleep(500)
        rmSync(directory, { force: true, recursive: true })
        rmSync(callerDirectory, { force: true, recursive: true })
      }
    }
  }, 40_000)

  testWindows('sanitizes direct PowerShell startup before the watcher and browser inherit its environment', async () => {
    const directory = createWindowsFixture()
    const callerDirectory = createWindowsCallerFixture()
    const authTokenLog = path.join(directory, 'auth-token.log')
    const browserTokenLog = path.join(directory, 'browser-token.log')
    const browserUrlLog = path.join(directory, 'browser-url.log')
    const cwdLog = path.join(directory, 'cwd.log')
    const persistedTokenPath = path.join(directory, 'persisted-token')
    const serverTokenLog = path.join(directory, 'server-token.log')
    const port = await getAvailablePort()
    const ghToken = 'ghu_direct_powershell_secret'
    const githubToken = 'ghu_direct_powershell_alias_secret'

    try {
      const result = runWindowsPowerShellFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_BROWSER_ARGUMENT: path.join(directory, 'browser.ts'),
        COPILOT_PROXY_START_BROWSER_COMMAND: process.execPath,
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '25',
        COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '5',
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        GH_TOKEN: ghToken,
        GITHUB_TOKEN: githubToken,
        TEST_AUTH_GITHUB_TOKEN_ENV_LOG: authTokenLog,
        TEST_AUTH_PERSISTED_TOKEN_PATH: persistedTokenPath,
        TEST_AUTH_REQUIRE_PERSISTED_TOKEN: '1',
        TEST_BROWSER_GITHUB_TOKEN_ENV_LOG: browserTokenLog,
        TEST_BROWSER_URL_LOG: browserUrlLog,
        TEST_CWD_LOG: cwdLog,
        TEST_EXIT_CODE: '47',
        TEST_GITHUB_TOKEN_ENV_LOG: serverTokenLog,
        TEST_LIFETIME_MILLISECONDS: '1000',
        TEST_PORT: String(port),
        TEST_READY_LOG: path.join(directory, 'ready.log'),
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(47)
      await waitForFile(browserTokenLog)
      expect(readFileSync(authTokenLog, 'utf8')).toBe('true\n')
      expect(readFileSync(persistedTokenPath, 'utf8')).toBe(ghToken)
      expect(path.resolve(readFileSync(cwdLog, 'utf8'))).toBe(path.resolve(directory))
      expect(readFileSync(serverTokenLog, 'utf8')).toBe('false')
      expect(readFileSync(browserTokenLog, 'utf8')).toBe('false')
      expect(readFileSync(browserUrlLog, 'utf8')).toBe(dashboardUrlFor(`http://127.0.0.1:${port}/diagnostics`))
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(ghToken)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(githubToken)
    }
    finally {
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('reuses persisted authentication through direct PowerShell and batch startup', async () => {
    const launchers = [
      { authCalls: 'false\n', name: 'PowerShell', run: runWindowsPowerShellFixture },
      { authCalls: 'false\n', name: 'batch', run: runWindowsFixture },
    ] as const

    for (const [index, launcher] of launchers.entries()) {
      const directory = createWindowsFixture()
      const callerDirectory = createWindowsCallerFixture()
      const authTokenLog = path.join(directory, 'auth-token.log')
      const openLog = path.join(directory, 'open.log')
      const persistedTokenPath = path.join(directory, 'persisted-token')
      const serverTokenLog = path.join(directory, 'server-token.log')
      const port = await getAvailablePort()
      const token = `ghu_existing_${launcher.name.toLowerCase()}_secret`
      writeFileSync(persistedTokenPath, token)

      try {
        const result = launcher.run(directory, callerDirectory, {
          COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
          COPILOT_PROXY_START_OPEN_LOG: openLog,
          COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '25',
          COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '5',
          COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
          GH_TOKEN: '',
          GITHUB_TOKEN: '',
          TEST_AUTH_GITHUB_TOKEN_ENV_LOG: authTokenLog,
          TEST_AUTH_PERSISTED_TOKEN_PATH: persistedTokenPath,
          TEST_AUTH_REQUIRE_PERSISTED_TOKEN: '1',
          TEST_EXIT_CODE: String(51 + index),
          TEST_GITHUB_TOKEN_ENV_LOG: serverTokenLog,
          TEST_LIFETIME_MILLISECONDS: '500',
          TEST_PORT: String(port),
          TEST_READY_LOG: path.join(directory, 'ready.log'),
        })

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(51 + index)
        expect(readFileSync(authTokenLog, 'utf8')).toBe(launcher.authCalls)
        expect(readFileSync(persistedTokenPath, 'utf8')).toBe(token)
        expect(readFileSync(serverTokenLog, 'utf8')).toBe('false')
        expect(readFileSync(openLog, 'utf8')).toBe(dashboardUrlFor(`http://127.0.0.1:${port}/diagnostics`))
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
      }
      finally {
        await Bun.sleep(500)
        rmSync(directory, { force: true, recursive: true })
        rmSync(callerDirectory, { force: true, recursive: true })
      }
    }
  }, 30_000)

  testWindows('preserves a direct PowerShell authentication failure without starting descendants', async () => {
    const directory = createWindowsFixture()
    const callerDirectory = createWindowsCallerFixture()
    const authTokenLog = path.join(directory, 'auth-token.log')
    const openLog = path.join(directory, 'open.log')
    const pidLog = path.join(directory, 'pid.log')
    const port = await getAvailablePort()
    const token = 'ghu_direct_auth_failure_secret'

    try {
      const result = runWindowsPowerShellFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_OPEN_LOG: openLog,
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        GH_TOKEN: token,
        GITHUB_TOKEN: '',
        TEST_AUTH_EXIT_CODE: '59',
        TEST_AUTH_GITHUB_TOKEN_ENV_LOG: authTokenLog,
        TEST_PID_LOG: pidLog,
        TEST_PORT: String(port),
        TEST_READY_LOG: path.join(directory, 'ready.log'),
      })

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(59)
      expect(readFileSync(authTokenLog, 'utf8')).toBe('true\n')
      expect(existsSync(pidLog)).toBe(false)
      expect(existsSync(openLog)).toBe(false)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
    }
    finally {
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('fails at the diagnostics deadline and kills the pre-listener process tree', async () => {
    const directory = createWindowsFixture()
    const callerDirectory = createWindowsCallerFixture()
    const openLog = path.join(directory, 'open.log')
    const pidLog = path.join(directory, 'pid.log')
    const port = await getAvailablePort()
    let serverPid: number | undefined

    try {
      const startedAt = Date.now()
      const result = runWindowsFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_OPEN_LOG: openLog,
        COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '25',
        COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '1',
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        TEST_EXIT_CODE: '29',
        TEST_PORT: String(port),
        TEST_PID_LOG: pidLog,
        TEST_READY_LOG: path.join(directory, 'ready.log'),
        TEST_LIFETIME_MILLISECONDS: '300',
        TEST_START_DELAY_MILLISECONDS: '10000',
      })

      expect(result.error).toBeUndefined()
      if (result.status !== 1)
        throw new Error(`Windows launcher exited with ${result.status}. stdout: ${result.stdout}; stderr: ${result.stderr}`)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('The server did not become ready within 1 seconds. Stopping it.')
      expect(existsSync(openLog)).toBe(false)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800)
      expect(Date.now() - startedAt).toBeLessThan(8_000)
      serverPid = Number(readFileSync(pidLog, 'utf8'))
      expect(Number.isSafeInteger(serverPid)).toBe(true)
      expect(isProcessRunning(serverPid)).toBe(false)
    }
    finally {
      if (serverPid !== undefined && isProcessRunning(serverPid)) {
        spawnSync('taskkill.exe', ['/PID', String(serverPid), '/T', '/F'], {
          encoding: 'utf8',
          windowsHide: true,
        })
      }
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindows('does not accept a ready response from an older process', async () => {
    const directory = createWindowsFixture()
    const callerDirectory = createWindowsCallerFixture()
    const openLog = path.join(directory, 'open.log')
    const oldReadyLog = path.join(directory, 'old-ready.log')
    const port = await getAvailablePort()
    const oldServer = Bun.spawn([process.execPath, 'run', path.join(directory, 'server.ts')], {
      cwd: directory,
      env: {
        ...process.env,
        TEST_FORCE_INSTANCE_TOKEN: 'stale_instance_token_20260718',
        TEST_LIFETIME_MILLISECONDS: '10000',
        TEST_PORT: String(port),
        TEST_READY_LOG: oldReadyLog,
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })

    try {
      await waitForFile(oldReadyLog)
      const result = runWindowsFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_OPEN_LOG: openLog,
        COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '25',
        COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '5',
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        TEST_EXIT_CODE: '0',
        TEST_PORT: String(port),
        TEST_READY_LOG: path.join(directory, 'new-ready.log'),
      })

      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(existsSync(openLog)).toBe(false)
      expect(existsSync(path.join(directory, 'new-ready.log'))).toBe(false)
    }
    finally {
      oldServer.kill()
      await oldServer.exited
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)

  testWindowsUnc('uses the drive mapped by pushd instead of a UNC Bun working directory', async () => {
    const directory = createWindowsFixture({ parentDirectory: import.meta.dir })
    const callerDirectory = createWindowsCallerFixture()
    const cwdLog = path.join(directory, 'cwd.log')
    const environmentLog = path.join(directory, 'environment.log')
    const openLog = path.join(directory, 'open.log')
    const port = await getAvailablePort()

    try {
      const result = runWindowsFixture(directory, callerDirectory, {
        COPILOT_PROXY_START_DIAGNOSTICS_URL: `http://127.0.0.1:${port}/diagnostics`,
        COPILOT_PROXY_START_OPEN_LOG: openLog,
        COPILOT_PROXY_START_READY_POLL_MILLISECONDS: '25',
        COPILOT_PROXY_START_READY_TIMEOUT_SECONDS: '5',
        COPILOT_PROXY_START_READY_URL: `http://127.0.0.1:${port}/`,
        TEST_CWD_LOG: cwdLog,
        TEST_EXIT_CODE: '31',
        TEST_LIFETIME_MILLISECONDS: '1000',
        TEST_PORT: String(port),
        TEST_READY_LOG: path.join(directory, 'ready.log'),
        TEST_REPOSITORY_ROOT_ENV_LOG: environmentLog,
      })

      expect(result.error).toBeUndefined()
      if (result.status !== 31)
        throw new Error(`Windows UNC launcher exited with ${result.status}. stdout: ${result.stdout}; stderr: ${result.stderr}`)
      expect(result.status).toBe(31)
      expect(readFileSync(cwdLog, 'utf8')).toMatch(/^[A-Z]:\\/i)
      expect(readFileSync(environmentLog, 'utf8')).toBe('')
      expect(readFileSync(openLog, 'utf8')).toBe(dashboardUrlFor(`http://127.0.0.1:${port}/diagnostics`))

      if (process.env.COPILOT_PROXY_TEST_REQUIRE_WINDOWS_UNC === '1') {
        const markerPath = process.env.COPILOT_PROXY_TEST_WINDOWS_UNC_MARKER
        expect(markerPath).toBeTruthy()
        writeFileSync(markerPath!, JSON.stringify({
          platform: process.platform,
          status: 'passed',
          testModuleDirectory: import.meta.dir,
        }))
      }
    }
    finally {
      await Bun.sleep(500)
      rmSync(directory, { force: true, recursive: true })
      rmSync(callerDirectory, { force: true, recursive: true })
    }
  }, 20_000)
})
