import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'

import { createPackagedCliFixture } from './helpers/packaged-cli-fixture'

// Native Windows startup from a WSL UNC checkout can approach Bun's default
// five-second test limit even though each child retains its own 10s deadline.
setDefaultTimeout(15_000)

let packagedCliFixture: ReturnType<typeof createPackagedCliFixture> | undefined

beforeAll(() => {
  packagedCliFixture = createPackagedCliFixture()
}, 60_000)

afterAll(() => {
  packagedCliFixture?.cleanup()
})

function packagedCliEntrypoint(): string {
  if (!packagedCliFixture)
    throw new Error('Packaged CLI fixture was not initialized.')
  return packagedCliFixture.entrypoint
}

describe('CLI entrypoint', () => {
  test('loads the guarded entrypoint and exposes core commands', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('src/main.ts'), '--help'],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('start')
    expect(result.stdout).toContain('enable')
    expect(result.stdout).toContain('debug')
    expect(result.stdout).toContain('setup')
    expect(result.stdout).toContain('models')
    expect(result.stdout).toContain('doctor')
  })

  test('documents the Codex-only setup preflight and model gates', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('src/main.ts'), 'setup', '--help'],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Codex only: preflight installed Codex >=0.134.0 and bundled metadata before authentication')
    expect(result.stdout).toContain('Codex only: must have both a live direct route and installed bundled metadata')
    expect(result.stdout).toContain('required when non-interactive')
    expect(result.stdout).toContain('Client to configure: claude, codex, or openai-sdk')
  })

  test('reports the package version through source and packaged entrypoints', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      version: string
    }
    const sourceResult = spawnSync(
      process.execPath,
      [path.resolve('src/main.ts'), 'debug', '--json'],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(sourceResult.error).toBeUndefined()
    expect(sourceResult.status).toBe(0)
    expect(JSON.parse(sourceResult.stdout)).toMatchObject({
      version: packageJson.version,
      runtime: {
        name: 'bun',
        platform: process.platform,
      },
    })

    const packagedResult = spawnSync(
      'node',
      [packagedCliEntrypoint(), 'debug', '--json'],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(packagedResult.error).toBeUndefined()
    expect(packagedResult.status).toBe(0)
    expect(JSON.parse(packagedResult.stdout)).toMatchObject({
      version: packageJson.version,
      runtime: {
        name: 'node',
        platform: process.platform,
      },
    })
  }, 60_000)

  test('exposes fresh native-service configuration without requiring a legacy daemon', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('src/main.ts'), 'enable', '--help'],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(result.status).toBe(0)
    for (const option of [
      '--account-type',
      '--port',
      '--host',
      '--proxy-env',
      '--no-proxy-env',
      '--verbose',
      '--rate-limit',
      '--wait',
      '--headers-timeout-ms',
      '--body-timeout-ms',
      '--connect-timeout-ms',
    ]) {
      expect(result.stdout).toContain(option)
    }
  })

  test('rejects contradictory native-service boolean overrides before installation', () => {
    for (const [enabled, disabled] of [
      ['--proxy-env', '--no-proxy-env'],
      ['--verbose', '--no-verbose'],
      ['--wait', '--no-wait'],
    ]) {
      const result = spawnSync(
        process.execPath,
        [path.resolve('src/main.ts'), 'enable', enabled, disabled, '--port', '0'],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: process.env,
          timeout: 20_000,
        },
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(`${enabled} and ${disabled} cannot be combined`)
      expect(result.stderr).not.toContain('--port must be')
    }
  }, 60_000)

  test('keeps internal lifecycle arguments out of public start help', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('src/main.ts'), 'start', '--help'],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--preset')
    expect(result.stdout).toContain('(Default: custom)')
    expect(result.stdout).toContain('custom is unbounded')
    expect(result.stdout).not.toContain('disabled when omitted')
    expect(result.stdout).not.toContain('--_supervisor')
    expect(result.stdout).not.toContain('--_service')
    expect(result.stdout).not.toContain('--_log-file')
    expect(result.stdout).not.toContain('--_data-dir')
    expect(result.stdout).not.toContain('--_instance-token')
  })

  test('keeps internal lifecycle arguments out of colorized start help', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FORCE_COLOR: '1',
      TERM: 'xterm-256color',
    }
    delete env.CI
    delete env.NO_COLOR
    delete env.TEST

    const result = spawnSync(
      process.execPath,
      [path.resolve('src/main.ts'), 'start', '--help'],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env,
        timeout: 10_000,
      },
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('\u001B[')
    expect(result.stdout).toContain('--preset')
    expect(result.stdout).not.toContain('--_supervisor')
    expect(result.stdout).not.toContain('--_service')
    expect(result.stdout).not.toContain('--_log-file')
    expect(result.stdout).not.toContain('--_data-dir')
    expect(result.stdout).not.toContain('--_instance-token')
  })

  test('applies internal log flags only when Citty parses them for source and packaged start', () => {
    const entrypoints = [
      { name: 'source', path: path.resolve('src/main.ts'), runtime: process.execPath },
      { name: 'packaged', path: packagedCliEntrypoint(), runtime: 'node' },
    ] as const
    const ignoredCases = [
      { args: ['--_log-file', 'start', '--account-type', 'invalid'], expectedStatus: 1, expectedText: 'Invalid account-type' },
      { args: ['start', '--host', '--_log-file', '--account-type', 'invalid'], expectedStatus: 1, expectedText: 'Invalid account-type' },
      { args: ['start', '--_log-file=false', '--account-type', 'invalid'], expectedStatus: 1, expectedText: 'Invalid account-type' },
      { args: ['start', '--logFile', '--no-logFile', '--account-type', 'invalid'], expectedStatus: 1, expectedText: 'Invalid account-type' },
      { args: ['start', '--', '--logFile', '--help'], expectedStatus: 0, expectedText: 'Start the Copilot API server' },
      { args: ['--help', 'start', '--_log-file'], expectedStatus: 0, expectedText: 'Start the Copilot API server' },
    ]
    const enabledCases = [
      ['-v', 'start', '--logFile', '--account-type', 'invalid'],
      ['start', '---log-file', '--account-type', 'invalid'],
      ['start', '--host', '--', '--logFile', '--account-type', 'invalid'],
    ]

    for (const entrypoint of entrypoints) {
      for (const [index, testCase] of ignoredCases.entries()) {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `copilot-proxy-main-${entrypoint.name}-ignored-log-${index}-`))
        try {
          const result = spawnSync(entrypoint.runtime, [entrypoint.path, ...testCase.args], {
            cwd: path.resolve('.'),
            encoding: 'utf8',
            env: {
              ...process.env,
              COPILOT_PROXY_DATA_DIR: dataDir,
            },
            timeout: 10_000,
          })
          expect(result.error).toBeUndefined()
          expect(result.status).toBe(testCase.expectedStatus)
          expect(`${result.stdout}\n${result.stderr}`).toContain(testCase.expectedText)
          expect(fs.existsSync(path.join(dataDir, 'daemon.log'))).toBe(false)
        }
        finally {
          fs.rmSync(dataDir, { force: true, recursive: true })
        }
      }

      for (const [index, args] of enabledCases.entries()) {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `copilot-proxy-main-${entrypoint.name}-enabled-log-${index}-`))
        try {
          const result = spawnSync(entrypoint.runtime, [entrypoint.path, ...args], {
            cwd: path.resolve('.'),
            encoding: 'utf8',
            env: {
              ...process.env,
              COPILOT_PROXY_DATA_DIR: dataDir,
            },
            timeout: 10_000,
          })
          expect(result.error).toBeUndefined()
          expect(result.status).toBe(1)
          expect(`${result.stdout}\n${result.stderr}`).not.toContain('Invalid account-type')
          expect(fs.readFileSync(path.join(dataDir, 'daemon.log'), 'utf8'))
            .toContain('Invalid account-type')
        }
        finally {
          fs.rmSync(dataDir, { force: true, recursive: true })
        }
      }
    }
  }, 60_000)

  test('ignores prefixed, consumed, false, and negated native-service flags', () => {
    const env = { ...process.env }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'COPILOT_PROXY_NETWORK_BOOTSTRAPPED',
    ]) {
      delete env[key]
    }
    const cases = [
      { args: ['--_service', 'start', '--account-type', 'invalid'], expectedStatus: 1, expectedText: 'Invalid account-type' },
      { args: ['start', '--host', '--_service', '--account-type', 'invalid'], expectedStatus: 1, expectedText: 'Invalid account-type' },
      { args: ['start', '--_service=false', '--account-type', 'invalid'], expectedStatus: 1, expectedText: 'Invalid account-type' },
      { args: ['start', '--service', '--no-service', '--account-type', 'invalid'], expectedStatus: 1, expectedText: 'Invalid account-type' },
      { args: ['start', '--', '--service', '--help'], expectedStatus: 0, expectedText: 'Start the Copilot API server' },
      { args: ['--help', 'start', '--_service'], expectedStatus: 0, expectedText: 'Start the Copilot API server' },
      { args: ['start', '--help', '--_service'], expectedStatus: 0, expectedText: 'Start the Copilot API server' },
    ]

    for (const testCase of cases) {
      const result = spawnSync(
        process.execPath,
        [path.resolve('src/main.ts'), ...testCase.args],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env,
          timeout: 10_000,
        },
      )
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(testCase.expectedStatus)
      expect(`${result.stdout}\n${result.stderr}`).toContain(testCase.expectedText)
      expect(result.stderr).not.toContain('Native service is missing')
    }
  }, 60_000)

  test('shows root help without reading a broken installed service state', () => {
    const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-help-control-state-'))
    fs.writeFileSync(path.join(testHome, '.copilot-proxy-native-service.json'), '{invalid json')

    try {
      for (const args of [
        ['--help', 'status'],
        ['status', '-h'],
      ]) {
        const result = spawnSync(
          process.execPath,
          [path.resolve('src/main.ts'), ...args],
          {
            cwd: path.resolve('.'),
            encoding: 'utf8',
            env: {
              ...process.env,
              COPILOT_PROXY_TEST_HOME: testHome,
            },
            timeout: 10_000,
          },
        )
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Show native background service or legacy daemon status')
        expect(result.stderr).not.toContain('control state is invalid')
      }

      const prefixedStatus = spawnSync(
        process.execPath,
        [path.resolve('src/main.ts'), '-x', 'status'],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: {
            ...process.env,
            COPILOT_PROXY_TEST_HOME: testHome,
          },
          timeout: 10_000,
        },
      )
      expect(prefixedStatus.error).toBeUndefined()
      expect(prefixedStatus.status).toBe(1)
      expect(prefixedStatus.stderr).toContain('Repair or remove')
    }
    finally {
      fs.rmSync(testHome, { force: true, recursive: true })
    }
  })

  test('sanitizes ambient proxy state for a prefixed real subcommand but not root help', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-prefixed-network-'))
    const wrapperPath = path.join(dataDir, 'network-wrapper.ts')
    const childStatePath = path.join(dataDir, 'child-state.json')
    fs.writeFileSync(wrapperPath, `
import fs from 'node:fs'
import process from 'node:process'

if (process.env.COPILOT_PROXY_NETWORK_BOOTSTRAPPED === '1') {
  fs.writeFileSync(${JSON.stringify(childStatePath)}, JSON.stringify({
    hasHttpsProxy: process.env.HTTPS_PROXY !== undefined,
  }))
  process.exit(0)
}
await import(${JSON.stringify(path.resolve('src/main.ts'))})
`)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HTTPS_PROXY: 'http://ambient.invalid:8080',
    }
    delete env.COPILOT_PROXY_NETWORK_BOOTSTRAPPED

    try {
      const prefixed = spawnSync(
        process.execPath,
        [wrapperPath, '-v', 'start', '--account-type', 'invalid'],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env,
          timeout: 10_000,
        },
      )
      expect(prefixed.error).toBeUndefined()
      expect(prefixed.status).toBe(0)
      expect(JSON.parse(fs.readFileSync(childStatePath, 'utf8'))).toEqual({
        hasHttpsProxy: false,
      })

      fs.rmSync(childStatePath, { force: true })
      const help = spawnSync(
        process.execPath,
        [wrapperPath, '--help', 'start'],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env,
          timeout: 10_000,
        },
      )
      expect(help.error).toBeUndefined()
      expect(help.status).toBe(0)
      expect(help.stdout).toContain('Start the Copilot API server')
      expect(fs.existsSync(childStatePath)).toBe(false)
    }
    finally {
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('fails gateway mode before authentication when the private Host allowlist is missing', () => {
    const env = { ...process.env }
    delete env.COPILOT_PROXY_ALLOWED_HOSTS
    const result = spawnSync(
      process.execPath,
      [path.resolve('src/main.ts'), 'start', '--preset', 'gateway-upstream'],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env,
        timeout: 10_000,
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('requires COPILOT_PROXY_ALLOWED_HOSTS')
    expect(result.stderr).not.toContain('Logged in as')
  })

  test('fails gateway mode before authentication for malformed and loopback-only Host allowlists', () => {
    for (const allowedHosts of ['proxy.internal:443', 'localhost']) {
      const result = spawnSync(
        process.execPath,
        [path.resolve('src/main.ts'), 'start', '--preset', 'gateway-upstream'],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: {
            ...process.env,
            COPILOT_PROXY_ALLOWED_HOSTS: allowedHosts,
          },
          timeout: 10_000,
        },
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('at least one non-loopback hostname or IP address')
      expect(result.stderr).not.toContain('Logged in as')
    }
  })

  test('applies camelCase concurrency aliases before authentication', () => {
    const maxConcurrency = spawnSync(
      process.execPath,
      [
        path.resolve('src/main.ts'),
        'start',
        '--preset',
        'custom',
        '--maxConcurrency',
        '7',
        '--max-queue',
        '3',
        '--account-type',
        'invalid',
      ],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(maxConcurrency.status).toBe(1)
    expect(maxConcurrency.stderr).toContain('Invalid account-type')
    expect(maxConcurrency.stderr).not.toContain('require --max-concurrency')
    expect(maxConcurrency.stderr).not.toContain('Logged in as')

    for (const [option, value] of [
      ['--maxQueue', '3'],
      ['--queueTimeoutMs', '1000'],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('src/main.ts'),
          'start',
          '--preset',
          'custom',
          option,
          value,
          '--account-type',
          'invalid',
        ],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: process.env,
          timeout: 10_000,
        },
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('--max-queue and --queue-timeout-ms require --max-concurrency')
      expect(result.stderr).not.toContain('Invalid account-type')
      expect(result.stderr).not.toContain('Logged in as')
    }
  })

  test('binds the native-service data directory before application imports', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-data-dir-'))
    fs.writeFileSync(path.join(dataDir, 'service-env.json'), JSON.stringify({
      COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
    }), { mode: 0o600 })

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('src/main.ts'),
          'start',
          '--_service',
          '--_data-dir',
          dataDir,
          '--proxy-env',
        ],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: process.env,
          timeout: 10_000,
        },
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Refusing to fall back to a direct connection')
      expect(result.stderr).not.toContain('ENOENT')
    }
    finally {
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('restores persisted security state before native-service application imports', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-service-security-'))
    fs.writeFileSync(path.join(dataDir, 'service-env.json'), JSON.stringify({
      version: 1,
      environment: {
        COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
      },
    }), { mode: 0o600 })

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('src/main.ts'),
          'start',
          '--_service',
          '--_data-dir',
          dataDir,
          '--preset',
          'gateway-upstream',
          '--account-type',
          'invalid',
        ],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: {
            ...process.env,
            COPILOT_PROXY_ALLOWED_HOSTS: 'localhost',
            GITHUB_TOKEN: 'ambient-token-must-not-control-the-service',
          },
          timeout: 10_000,
        },
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Invalid account-type')
      expect(result.stderr).not.toContain('requires COPILOT_PROXY_ALLOWED_HOSTS')
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('ambient-token-must-not-control-the-service')
    }
    finally {
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('sanitizes the long-lived native-service bootstrap parent as well as its child', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-service-parent-env-'))
    const wrapperPath = path.join(dataDir, 'service-wrapper.ts')
    const childStatePath = path.join(dataDir, 'child-state.json')
    const parentStatePath = path.join(dataDir, 'parent-state.json')
    const releasePath = path.join(dataDir, 'release')
    fs.writeFileSync(path.join(dataDir, 'service-env.json'), JSON.stringify({
      version: 1,
      environment: {
        COPILOT_PROXY_ALLOWED_HOSTS: 'persisted.internal',
      },
    }), { mode: 0o600 })
    fs.writeFileSync(wrapperPath, `
import fs from 'node:fs'
import process from 'node:process'

const childStatePath = ${JSON.stringify(childStatePath)}
const parentStatePath = ${JSON.stringify(parentStatePath)}
const releasePath = ${JSON.stringify(releasePath)}

function environmentState() {
  return {
    allowedHosts: process.env.COPILOT_PROXY_ALLOWED_HOSTS,
    bootstrapped: process.env.COPILOT_PROXY_NETWORK_BOOTSTRAPPED,
    hasGhToken: process.env.GH_TOKEN !== undefined,
    hasGithubToken: process.env.GITHUB_TOKEN !== undefined,
    hasOpenaiApiKey: process.env.OPENAI_API_KEY !== undefined,
  }
}

if (process.env.COPILOT_PROXY_NETWORK_BOOTSTRAPPED === '1') {
  fs.writeFileSync(childStatePath, JSON.stringify(environmentState()))
  const releaseTimer = setInterval(() => {
    if (fs.existsSync(releasePath)) {
      clearInterval(releaseTimer)
      process.exit(0)
    }
  }, 10)
  await new Promise(() => {})
}
else {
  const observationTimer = setInterval(() => {
    if (fs.existsSync(childStatePath)) {
      fs.writeFileSync(parentStatePath, JSON.stringify(environmentState()))
      clearInterval(observationTimer)
    }
  }, 10)
  await import(${JSON.stringify(path.resolve('src/main.ts'))})
}
`)

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COPILOT_PROXY_ALLOWED_HOSTS: 'ambient.internal',
      GH_TOKEN: 'gho_parent_secret',
      GITHUB_TOKEN: 'ghp_parent_secret',
      OPENAI_API_KEY: 'sk_parent_secret',
    }
    delete env.COPILOT_PROXY_NETWORK_BOOTSTRAPPED

    let stdout = ''
    let stderr = ''
    const bootstrap = spawn(
      process.execPath,
      [
        wrapperPath,
        '-v',
        'start',
        '--service',
        '--_data-dir',
        dataDir,
      ],
      {
        cwd: path.resolve('.'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    bootstrap.stdout?.on('data', chunk => stdout += String(chunk))
    bootstrap.stderr?.on('data', chunk => stderr += String(chunk))
    const exit = new Promise<number | null>((resolve, reject) => {
      bootstrap.once('error', reject)
      bootstrap.once('exit', code => resolve(code))
    })

    try {
      const deadline = Date.now() + 10_000
      while (!fs.existsSync(parentStatePath)) {
        if (bootstrap.exitCode !== null) {
          throw new Error(
            `Native-service bootstrap exited before parent observation (code ${bootstrap.exitCode}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          )
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for native-service parent observation.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          )
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      const expected = {
        allowedHosts: 'persisted.internal',
        bootstrapped: '1',
        hasGhToken: false,
        hasGithubToken: false,
        hasOpenaiApiKey: false,
      }
      expect(JSON.parse(fs.readFileSync(parentStatePath, 'utf8'))).toEqual(expected)
      expect(JSON.parse(fs.readFileSync(childStatePath, 'utf8'))).toEqual(expected)

      fs.writeFileSync(releasePath, '')
      expect(await exit).toBe(0)
    }
    finally {
      fs.writeFileSync(releasePath, '')
      if (bootstrap.exitCode === null && bootstrap.signalCode === null) {
        await Promise.race([
          exit.catch(() => null),
          new Promise(resolve => setTimeout(resolve, 1_000)),
        ])
      }
      if (bootstrap.exitCode === null && bootstrap.signalCode === null)
        bootstrap.kill()
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  }, 15_000)

  test('persists --github-token and exits promptly before any long-lived start', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-token-'))
    const token = 'ghu_main_argv_secret'

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('src/main.ts'),
          'start',
          '--github-token',
          token,
          '--_data-dir',
          dataDir,
        ],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: process.env,
          timeout: 10_000,
        },
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).not.toContain(token)
      expect(result.stderr).not.toContain(token)
      expect(result.stderr).toContain('Rerun `copilot-proxy start` without --github-token')
      const tokenPath = path.join(dataDir, 'github_token')
      expect(fs.readFileSync(tokenPath, 'utf8')).toBe(token)
      if (process.platform !== 'win32')
        expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600)
    }
    finally {
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('keeps builtin help side-effect free for every GitHub-token spelling', () => {
    const entrypoints = [
      { name: 'source', path: path.resolve('src/main.ts'), runtime: process.execPath },
      { name: 'packaged', path: packagedCliEntrypoint(), runtime: 'node' },
    ] as const
    const helpCases = [
      {
        args: (_token: string) => ['auth', '--github-token', '--help'],
        expectedHelp: 'Run GitHub auth flow without running the server',
        name: 'auth-canonical-help-value',
      },
      {
        args: (_token: string) => ['auth', '--githubToken', '-h'],
        expectedHelp: 'Run GitHub auth flow without running the server',
        name: 'auth-camel-help-value',
      },
      {
        args: (_token: string) => ['auth', '-g', '--help'],
        expectedHelp: 'Run GitHub auth flow without running the server',
        name: 'auth-short-help-value',
      },
      {
        args: (token: string) => ['start', `--github-token=${token}`, '--help', '--_service'],
        expectedHelp: 'Start the Copilot API server',
        name: 'start-canonical',
      },
      {
        args: (token: string) => ['start', `--githubToken=${token}`, '-h'],
        expectedHelp: 'Start the Copilot API server',
        name: 'start-camel',
      },
      {
        args: (token: string) => ['start', `-g${token}`, '--help'],
        expectedHelp: 'Start the Copilot API server',
        name: 'start-short',
      },
      {
        args: (token: string) => ['start', '--host', '--help', `--github-token=${token}`],
        expectedHelp: 'Start the Copilot API server',
        name: 'help-consumed-by-other-string-option',
      },
      {
        args: (token: string) => ['--help', 'auth', `--githubToken=${token}`],
        expectedHelp: 'Run GitHub auth flow without running the server',
        name: 'prefixed-long-help',
      },
      {
        args: (token: string) => ['-h', 'start', `-g${token}`],
        expectedHelp: 'Start the Copilot API server',
        name: 'prefixed-short-help',
      },
      {
        args: (_token: string) => ['--github-token', '--help', 'auth'],
        expectedHelp: 'Run GitHub auth flow without running the server',
        name: 'prefixed-token-consumes-help',
      },
    ] as const
    const baseEnv = { ...process.env }
    delete baseEnv.GH_TOKEN
    delete baseEnv.GITHUB_TOKEN

    for (const entrypoint of entrypoints) {
      for (const [index, helpCase] of helpCases.entries()) {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `copilot-proxy-main-help-token-${entrypoint.name}-${index}-`))
        const tokenPath = path.join(dataDir, 'github_token')
        const existingToken = `ghu_existing_help_credential_${entrypoint.name}_${index}`
        const candidateToken = `ghu_ignored_help_candidate_${entrypoint.name}_${index}`
        fs.writeFileSync(tokenPath, existingToken, { mode: 0o600 })

        try {
          const result = spawnSync(
            entrypoint.runtime,
            [entrypoint.path, ...helpCase.args(candidateToken)],
            {
              cwd: path.resolve('.'),
              encoding: 'utf8',
              env: {
                ...baseEnv,
                COPILOT_PROXY_DATA_DIR: dataDir,
              },
              timeout: 10_000,
            },
          )

          expect(result.error, `${entrypoint.name}/${helpCase.name}`).toBeUndefined()
          expect(result.status, `${entrypoint.name}/${helpCase.name}`).toBe(0)
          expect(result.stdout, `${entrypoint.name}/${helpCase.name}`).toContain(helpCase.expectedHelp)
          expect(result.stderr, `${entrypoint.name}/${helpCase.name}`).not.toContain('GitHub token saved securely')
          expect(`${result.stdout}\n${result.stderr}`, `${entrypoint.name}/${helpCase.name}`).not.toContain(candidateToken)
          expect(fs.readFileSync(tokenPath, 'utf8'), `${entrypoint.name}/${helpCase.name}`).toBe(existingToken)
        }
        finally {
          fs.rmSync(dataDir, { force: true, recursive: true })
        }
      }
    }
  }, 90_000)

  test('persists prefixed token arguments before source and packaged commands can continue', () => {
    const env = { ...process.env }
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN
    const cases = [
      {
        command: 'start',
        entrypoint: path.resolve('src/main.ts'),
        expectedStatus: 1,
        prefixArguments: (_token: string) => ['-v'],
        runtime: process.execPath,
        tokenArguments: (token: string) => ['--github-token', token],
      },
      {
        command: 'auth',
        entrypoint: path.resolve('src/main.ts'),
        expectedStatus: 0,
        prefixArguments: (_token: string) => ['--unknown'],
        runtime: process.execPath,
        tokenArguments: (token: string) => [`--githubToken=${token}`],
      },
      {
        command: 'start',
        entrypoint: packagedCliEntrypoint(),
        expectedStatus: 1,
        prefixArguments: (_token: string) => ['--unknown=value', '-v'],
        runtime: 'node',
        tokenArguments: (token: string) => [`--githubToken=${token}`],
      },
      {
        command: 'auth',
        entrypoint: packagedCliEntrypoint(),
        expectedStatus: 0,
        prefixArguments: (_token: string) => ['-x'],
        runtime: 'node',
        tokenArguments: (token: string) => ['--github-token', token],
      },
      {
        command: 'start',
        entrypoint: path.resolve('src/main.ts'),
        expectedStatus: 1,
        prefixArguments: (token: string) => [`--githubToken=${token}`],
        runtime: process.execPath,
        tokenArguments: (_token: string) => [],
      },
      {
        command: 'start',
        entrypoint: packagedCliEntrypoint(),
        expectedStatus: 1,
        prefixArguments: (token: string) => [`-g${token}`],
        runtime: 'node',
        tokenArguments: (_token: string) => [],
      },
    ] as const

    for (const [index, testCase] of cases.entries()) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-prefixed-token-'))
      const token = `ghu_prefixed_argv_secret_${index}`

      try {
        const result = spawnSync(
          testCase.runtime,
          [
            testCase.entrypoint,
            ...testCase.prefixArguments(token),
            testCase.command,
            ...testCase.tokenArguments(token),
            ...(testCase.command === 'start' ? ['--port', '0'] : []),
            '--_data-dir',
            dataDir,
          ],
          {
            cwd: path.resolve('.'),
            encoding: 'utf8',
            env,
            timeout: 10_000,
          },
        )

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(testCase.expectedStatus)
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
        expect(result.stderr).toContain('GitHub token saved securely.')
        if (testCase.command === 'start')
          expect(result.stderr).toContain('Rerun `copilot-proxy start` without --github-token')
        else
          expect(result.stderr).not.toContain('Rerun `copilot-proxy start`')
        expect(fs.readFileSync(path.join(dataDir, 'github_token'), 'utf8')).toBe(token)
      }
      finally {
        fs.rmSync(dataDir, { force: true, recursive: true })
      }
    }
  }, 60_000)

  test('matches data-dir bootstrap, generated aliases, and token precedence in the real CLI', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-token-parser-'))
    const entrypoint = path.resolve('src/main.ts')
    const baseEnv = { ...process.env }
    delete baseEnv.COPILOT_PROXY_DATA_DIR
    delete baseEnv.GH_TOKEN
    delete baseEnv.GITHUB_TOKEN

    try {
      const prefixDataDirValue = '--github-token=prefix-data-dir-value'
      const prefixDataDir = path.resolve(cwd, prefixDataDirValue)
      const prefixResult = spawnSync(
        process.execPath,
        [entrypoint, '--_data-dir', prefixDataDirValue, 'auth', '--help'],
        {
          cwd,
          encoding: 'utf8',
          env: baseEnv,
          timeout: 10_000,
        },
      )

      expect(prefixResult.error).toBeUndefined()
      expect(prefixResult.status).toBe(0)
      expect(prefixResult.stdout).toContain('Run GitHub auth flow without running the server')
      expect(prefixResult.stderr).not.toContain('GitHub token saved securely')
      expect(fs.existsSync(path.join(prefixDataDir, 'github_token'))).toBe(false)

      const firstDataDir = path.join(cwd, 'first-data-dir')
      const repeatedToken = 'ghu_repeated_data_dir_real_token'
      const repeatedResult = spawnSync(
        process.execPath,
        [
          entrypoint,
          'auth',
          '--_data-dir',
          firstDataDir,
          '--_data-dir',
          `--github-token=${repeatedToken}`,
        ],
        {
          cwd,
          encoding: 'utf8',
          env: baseEnv,
          timeout: 10_000,
        },
      )

      expect(repeatedResult.error).toBeUndefined()
      expect(repeatedResult.status).toBe(0)
      expect(`${repeatedResult.stdout}\n${repeatedResult.stderr}`).not.toContain(repeatedToken)
      expect(repeatedResult.stderr).toContain('GitHub token saved securely.')
      expect(fs.readFileSync(path.join(firstDataDir, 'github_token'), 'utf8')).toBe(repeatedToken)

      const prefixDashToken = 'ghu_prefix_dash_data_dir_token'
      const prefixDashDataDir = path.join(cwd, '-prefix-dash-data-dir')
      const prefixDashResult = spawnSync(
        process.execPath,
        [
          entrypoint,
          '--_data-dir',
          '-prefix-dash-data-dir',
          'auth',
          `--github-token=${prefixDashToken}`,
        ],
        {
          cwd,
          encoding: 'utf8',
          env: baseEnv,
          timeout: 10_000,
        },
      )

      expect(prefixDashResult.error).toBeUndefined()
      expect(prefixDashResult.status).toBe(0)
      expect(fs.readFileSync(path.join(prefixDashDataDir, 'github_token'), 'utf8')).toBe(prefixDashToken)

      const dualRoleToken = 'ghu_dual_role_data_dir_token'
      const dualRoleDataDir = path.join(cwd, 'auth')
      const dualRoleResult = spawnSync(
        process.execPath,
        [
          entrypoint,
          '--_data-dir',
          'auth',
          `--github-token=${dualRoleToken}`,
        ],
        {
          cwd,
          encoding: 'utf8',
          env: baseEnv,
          timeout: 10_000,
        },
      )

      expect(dualRoleResult.error).toBeUndefined()
      expect(dualRoleResult.status).toBe(0)
      expect(fs.readFileSync(path.join(dualRoleDataDir, 'github_token'), 'utf8')).toBe(dualRoleToken)

      const aliasDataDir = path.join(cwd, 'generated-alias-data-dir')
      const aliasTokenValue = 'ghu_generated_alias_not_a_token'
      const aliasResult = spawnSync(
        process.execPath,
        [
          entrypoint,
          'start',
          '---data-dir',
          `--github-token=${aliasTokenValue}`,
          '--help',
        ],
        {
          cwd,
          encoding: 'utf8',
          env: {
            ...baseEnv,
            COPILOT_PROXY_DATA_DIR: aliasDataDir,
          },
          timeout: 10_000,
        },
      )

      expect(aliasResult.error).toBeUndefined()
      expect(aliasResult.status).toBe(0)
      expect(aliasResult.stdout).toContain('Start the Copilot API server')
      expect(aliasResult.stderr).not.toContain('GitHub token saved securely')
      expect(fs.existsSync(path.join(aliasDataDir, 'github_token'))).toBe(false)

      const nestedToken = 'ghu_nested_string_option_token'
      const nestedLeakDataDir = path.resolve(cwd, `--github-token=${nestedToken}`)
      const nestedExpectedDataDir = path.join(cwd, 'nested-expected-data-dir')
      const nestedResult = spawnSync(
        process.execPath,
        [
          entrypoint,
          'start',
          '---data-dir',
          '--_data-dir',
          `--github-token=${nestedToken}`,
        ],
        {
          cwd,
          encoding: 'utf8',
          env: {
            ...baseEnv,
            COPILOT_PROXY_DATA_DIR: nestedExpectedDataDir,
          },
          timeout: 10_000,
        },
      )

      expect(nestedResult.error).toBeUndefined()
      expect(nestedResult.status).toBe(1)
      expect(`${nestedResult.stdout}\n${nestedResult.stderr}`).not.toContain(nestedToken)
      expect(nestedResult.stderr).toContain('Rerun `copilot-proxy start` without --github-token')
      expect(fs.readFileSync(path.join(nestedExpectedDataDir, 'github_token'), 'utf8')).toBe(nestedToken)
      expect(fs.existsSync(nestedLeakDataDir)).toBe(false)

      const precedenceDataDir = path.join(cwd, 'precedence-data-dir')
      const canonicalToken = 'ghu_canonical_token'
      const camelToken = 'ghu_camel_token'
      const precedenceResult = spawnSync(
        process.execPath,
        [
          entrypoint,
          'auth',
          `--github-token=${canonicalToken}`,
          `--githubToken=${camelToken}`,
          '--_data-dir',
          precedenceDataDir,
        ],
        {
          cwd,
          encoding: 'utf8',
          env: baseEnv,
          timeout: 10_000,
        },
      )

      expect(precedenceResult.error).toBeUndefined()
      expect(precedenceResult.status).toBe(0)
      expect(`${precedenceResult.stdout}\n${precedenceResult.stderr}`).not.toContain(canonicalToken)
      expect(`${precedenceResult.stdout}\n${precedenceResult.stderr}`).not.toContain(camelToken)
      expect(fs.readFileSync(path.join(precedenceDataDir, 'github_token'), 'utf8')).toBe(canonicalToken)
    }
    finally {
      fs.rmSync(cwd, { force: true, recursive: true })
    }
  })

  test('keeps consumed data-dir tokens out of source and packaged directory names', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-shared-bootstrap-'))
    const baseEnv = { ...process.env }
    delete baseEnv.COPILOT_PROXY_DATA_DIR
    delete baseEnv.GH_TOKEN
    delete baseEnv.GITHUB_TOKEN

    const entrypoints = [
      { name: 'source', path: path.resolve('src/main.ts'), runtime: process.execPath },
      { name: 'packaged', path: packagedCliEntrypoint(), runtime: 'node' },
    ] as const
    const scenarios = [
      {
        command: 'start',
        name: 'generated-alias',
        args: (token: string, _dataDir: string) => [
          'start',
          '---data-dir',
          '--_data-dir',
          `--github-token=${token}`,
        ],
        leakName: (token: string) => `--github-token=${token}`,
      },
      {
        command: 'start',
        name: 'long-consumer',
        args: (token: string, dataDir: string) => [
          'start',
          '--host',
          '--_data-dir',
          `--github-token=${token}`,
          '--_data-dir',
          dataDir,
        ],
        leakName: (token: string) => `--github-token=${token}`,
      },
      {
        command: 'start',
        name: 'inline-consumer',
        args: (token: string, dataDir: string) => [
          'start',
          '--host',
          `--_data-dir=leak-${token}`,
          `--github-token=${token}`,
          '--_data-dir',
          dataDir,
        ],
        leakName: (token: string) => `leak-${token}`,
      },
      {
        command: 'start',
        name: 'short-consumer',
        args: (token: string, dataDir: string) => [
          'start',
          '-vp',
          '--_data-dir',
          `--github-token=${token}`,
          '--_data-dir',
          dataDir,
        ],
        leakName: (token: string) => `--github-token=${token}`,
      },
      {
        command: 'auth',
        name: 'auth-consumer',
        args: (token: string, dataDir: string) => [
          'auth',
          '--github-token',
          '--_data-dir',
          `--github-token=${token}`,
          '--_data-dir',
          dataDir,
        ],
        leakName: (token: string) => `--github-token=${token}`,
      },
      {
        command: 'auth',
        name: 'prefix-consumer',
        args: (token: string, dataDir: string) => [
          '--github-token',
          '--_data-dir',
          `--github-token=${token}`,
          'auth',
          '--_data-dir',
          dataDir,
        ],
        leakName: (token: string) => `--github-token=${token}`,
      },
      {
        command: 'start',
        name: 'start-consumed-terminator',
        args: (token: string, dataDir: string) => [
          'start',
          '--host',
          '--',
          '--_data-dir',
          dataDir,
          `--github-token=${token}`,
        ],
        leakName: (_token: string) => undefined,
      },
      {
        command: 'auth',
        name: 'auth-consumed-terminator',
        args: (token: string, dataDir: string) => [
          'auth',
          '--github-token',
          '--',
          '--_data-dir',
          dataDir,
          `--github-token=${token}`,
        ],
        leakName: (_token: string) => undefined,
      },
    ] as const

    try {
      for (const entrypoint of entrypoints) {
        for (const [index, scenario] of scenarios.entries()) {
          const token = `ghu_${entrypoint.name}_${scenario.name}_${index}`
          const expectedDataDir = path.join(rootDir, `${entrypoint.name}-${scenario.name}`)
          const leakName = scenario.leakName(token)
          const result = spawnSync(
            entrypoint.runtime,
            [entrypoint.path, ...scenario.args(token, expectedDataDir)],
            {
              cwd: rootDir,
              encoding: 'utf8',
              env: {
                ...baseEnv,
                COPILOT_PROXY_DATA_DIR: expectedDataDir,
              },
              timeout: 10_000,
            },
          )

          expect(result.error).toBeUndefined()
          expect(result.status).toBe(scenario.command === 'auth' ? 0 : 1)
          expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
          expect(result.stderr).toContain('GitHub token saved securely.')
          expect(fs.readFileSync(path.join(expectedDataDir, 'github_token'), 'utf8')).toBe(token)
          if (leakName)
            expect(fs.existsSync(path.join(rootDir, leakName))).toBe(false)
          expect(fs.readdirSync(rootDir).some(name => name.includes(token))).toBe(false)
        }
      }
    }
    finally {
      fs.rmSync(rootDir, { force: true, recursive: true })
    }
  }, 60_000)

  test('does not persist a token-shaped value consumed by a missing preset value', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-preset-token-'))
    const token = 'FAKE_TOKEN_SENTINEL_PRESET_VALUE'

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('src/main.ts'),
          'start',
          '--preset',
          `--github-token=${token}`,
          '--_data-dir',
          dataDir,
        ],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: process.env,
          timeout: 10_000,
        },
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
      expect(result.stderr).toContain('--github-token was consumed as another option value')
      expect(result.stderr).not.toContain('GitHub token saved securely')
      expect(fs.existsSync(path.join(dataDir, 'github_token'))).toBe(false)
    }
    finally {
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('rejects malformed start token arguments without output, path, or long-lived argv leaks', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-misplaced-token-'))
    const entrypoints = [
      { name: 'source', path: path.resolve('src/main.ts'), runtime: process.execPath },
      { name: 'packaged', path: packagedCliEntrypoint(), runtime: 'node' },
    ] as const
    const cases = [
      {
        args: (sentinel: string) => ['start', '--port', `--github-token=${sentinel}`],
        name: 'port',
      },
      {
        args: (sentinel: string) => ['start', '--port', '--no-verbose', `--github-token=${sentinel}`],
        name: 'port-with-removed-negative-boolean',
      },
      {
        args: (sentinel: string) => ['start', `--port=-g${sentinel}`],
        name: 'inline-port',
      },
      {
        args: (sentinel: string) => ['start', '--preset', `--githubToken=${sentinel}`],
        name: 'preset',
      },
      {
        args: (sentinel: string) => ['start', '--host', '--github-token', sentinel],
        name: 'host',
      },
      {
        args: (sentinel: string) => ['start', '--_data-dir', `--github-token=${sentinel}`],
        name: 'data-dir',
      },
      {
        args: (sentinel: string) => [`--no-github-token=${sentinel}`, 'start'],
        name: 'negative-token-prefix',
      },
      {
        args: (sentinel: string) => [`--no-g=${sentinel}`, 'start'],
        name: 'negative-short-token-prefix',
      },
      {
        args: (sentinel: string) => ['start', `--no-g=${sentinel}`],
        name: 'negative-short-token-subcommand',
      },
      {
        args: (sentinel: string) => [`--host=--github-token=${sentinel}`, 'start'],
        name: 'embedded-token-prefix',
      },
      {
        args: (sentinel: string) => ['--no-github-token', sentinel, 'start'],
        name: 'separated-negative-token-prefix',
      },
      {
        args: (sentinel: string) => ['--no-g', sentinel, 'start'],
        name: 'separated-negative-short-token-prefix',
      },
    ] as const
    const baseEnv = { ...process.env }
    delete baseEnv.GH_TOKEN
    delete baseEnv.GITHUB_TOKEN

    try {
      for (const entrypoint of entrypoints) {
        for (const testCase of cases) {
          const sentinel = `FAKE_TOKEN_SENTINEL_${entrypoint.name}_${testCase.name}`
          const safeDataDir = path.join(rootDir, `${entrypoint.name}-${testCase.name}`)
          const startedAt = Date.now()
          const result = spawnSync(
            entrypoint.runtime,
            [entrypoint.path, ...testCase.args(sentinel)],
            {
              cwd: rootDir,
              encoding: 'utf8',
              env: {
                ...baseEnv,
                COPILOT_PROXY_DATA_DIR: safeDataDir,
              },
              timeout: 10_000,
            },
          )

          expect(result.error, `${entrypoint.name}/${testCase.name}`).toBeUndefined()
          expect(result.status, `${entrypoint.name}/${testCase.name}`).toBe(1)
          expect(Date.now() - startedAt, `${entrypoint.name}/${testCase.name}`).toBeLessThan(5_000)
          expect(`${result.stdout}\n${result.stderr}`, `${entrypoint.name}/${testCase.name}`).not.toContain(sentinel)
          expect(result.stderr, `${entrypoint.name}/${testCase.name}`).toContain('--github-token was consumed as another option value')
          expect(result.stderr, `${entrypoint.name}/${testCase.name}`).not.toContain('GitHub token saved securely')
          expect(fs.existsSync(path.join(safeDataDir, 'github_token')), `${entrypoint.name}/${testCase.name}`).toBe(false)
          expect(fs.readdirSync(rootDir).some(name => name.includes(sentinel)), `${entrypoint.name}/${testCase.name}`).toBe(false)
        }
      }
    }
    finally {
      fs.rmSync(rootDir, { force: true, recursive: true })
    }
  }, 60_000)

  test('does not persist dashed or camelCase token-shaped values consumed by a missing internal data-dir value', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-missing-data-dir-'))
    const entrypoint = path.resolve('src/main.ts')
    const env = { ...process.env }
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN

    try {
      for (const [index, option] of ['--github-token', '--githubToken'].entries()) {
        const token = `ghu_not_a_token_value_${index}`
        const tokenArgument = `${option}=${token}`
        // A token-shaped data-dir value is rejected before it can become an
        // active path or start authentication.
        const consumedDataDir = path.resolve(cwd, tokenArgument)
        const result = spawnSync(
          process.execPath,
          [
            entrypoint,
            'auth',
            '--_data-dir',
            tokenArgument,
            '--help',
          ],
          {
            cwd,
            encoding: 'utf8',
            env,
            timeout: 10_000,
          },
        )

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.stdout).toContain('Run GitHub auth flow without running the server')
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
        expect(result.stderr).not.toContain('GitHub token saved securely')
        expect(fs.existsSync(path.join(consumedDataDir, 'github_token'))).toBe(false)
      }
    }
    finally {
      fs.rmSync(cwd, { force: true, recursive: true })
    }
  })

  test('persists a separated token option placed before the start command without exposing its value', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-prefix-separated-token-'))
    const token = 'FAKE_PREFIX_TOKEN_SENTINEL'
    try {
      const result = spawnSync(
        process.execPath,
        [path.resolve('src/main.ts'), '--github-token', token, 'start'],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: { ...process.env, COPILOT_PROXY_DATA_DIR: dataDir },
          timeout: 10_000,
        },
      )

      expect(result.status).toBe(1)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
      expect(result.stderr).toContain('GitHub token saved securely')
      expect(fs.readFileSync(path.join(dataDir, 'github_token'), 'utf8')).toBe(token)
    }
    finally {
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('documents and handles auth --github-token without starting the device flow', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-auth-token-'))
    const token = 'ghu_auth_argv_secret'

    try {
      const help = spawnSync(
        process.execPath,
        [path.resolve('src/main.ts'), 'auth', '--help'],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: process.env,
          timeout: 10_000,
        },
      )
      expect(help.status).toBe(0)
      expect(help.stdout).toContain('--github-token')
      expect(help.stdout).not.toContain('--_if-needed')

      const result = spawnSync(
        process.execPath,
        [
          path.resolve('src/main.ts'),
          'auth',
          '--github-token',
          token,
          '--_data-dir',
          dataDir,
        ],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env: process.env,
          timeout: 10_000,
        },
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).not.toContain(token)
      expect(result.stderr).not.toContain(token)
      expect(result.stderr).toContain('GitHub token saved securely.')
      expect(result.stderr).not.toContain('Rerun `copilot-proxy start`')
      expect(fs.readFileSync(path.join(dataDir, 'github_token'), 'utf8')).toBe(token)
    }
    finally {
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('internal auth preflight reuses a persisted token without starting device auth', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-main-auth-preflight-'))
    const tokenPath = path.join(dataDir, 'github_token')
    const token = 'ghu_existing_preflight_token'
    fs.writeFileSync(tokenPath, token, { mode: 0o600 })
    const env = { ...process.env }
    delete env.GH_TOKEN
    delete env.GITHUB_TOKEN

    try {
      const result = spawnSync(
        process.execPath,
        [
          path.resolve('src/main.ts'),
          'auth',
          '--_if-needed',
          '--_data-dir',
          dataDir,
        ],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          env,
          timeout: 10_000,
        },
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('Not logged in')
      expect(fs.readFileSync(tokenPath, 'utf8')).toBe(token)
    }
    finally {
      fs.rmSync(dataDir, { force: true, recursive: true })
    }
  })

  test('internal auth preflight persists environment token inputs for a sanitized launcher', () => {
    for (const variable of ['GH_TOKEN', 'GITHUB_TOKEN'] as const) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `copilot-proxy-main-${variable.toLowerCase()}-preflight-`))
      const token = `ghu_${variable.toLowerCase()}_preflight_secret`
      const env = { ...process.env }
      delete env.GH_TOKEN
      delete env.GITHUB_TOKEN
      env[variable] = token

      try {
        const result = spawnSync(
          process.execPath,
          [
            path.resolve('src/main.ts'),
            'auth',
            '--_if-needed',
            '--_data-dir',
            dataDir,
          ],
          {
            cwd: path.resolve('.'),
            encoding: 'utf8',
            env,
            timeout: 10_000,
          },
        )

        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(token)
        expect(`${result.stdout}\n${result.stderr}`).not.toContain('Not logged in')
        expect(fs.readFileSync(path.join(dataDir, 'github_token'), 'utf8')).toBe(token)
      }
      finally {
        fs.rmSync(dataDir, { force: true, recursive: true })
      }
    }
  })
})
