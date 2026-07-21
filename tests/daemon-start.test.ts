import type { DaemonConfig } from '~/daemon/config'
import fs from 'node:fs'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { saveDaemonConfig } from '~/daemon/config'
import { NATIVE_SERVICE_ENV_SCHEMA_VERSION } from '~/daemon/service-env'
import {
  persistLegacyDaemonState,
  prepareDaemonEnvironment,
  waitForSupervisorReadiness,
} from '~/daemon/start'
import { PATHS } from '~/lib/paths'

const baseConfig: DaemonConfig = {
  port: 4399,
  host: '127.0.0.1',
  verbose: false,
  accountType: 'individual',
  manual: false,
  rateLimitWait: false,
  showToken: false,
  proxyEnv: false,
}

afterEach(() => {
  for (const filePath of [PATHS.DAEMON_ENV, PATHS.DAEMON_JSON, PATHS.GITHUB_TOKEN_PATH])
    fs.rmSync(filePath, { force: true, recursive: true })
})

describe('legacy daemon preflight state', () => {
  test('prepares a sanitized fresh environment with the live runtime path before preflight', () => {
    fs.rmSync(PATHS.DAEMON_ENV, { force: true })

    const secretKeys = [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'COPILOT_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'AZURE_OPENAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
    ] as const
    const originalSecrets = new Map(secretKeys.map(key => [key, process.env[key]]))

    try {
      for (const key of secretKeys)
        process.env[key] = `ambient-${key.toLowerCase()}`

      // Bun 1.3.12 exposes the real Windows `Path` through process.env.PATH,
      // but spreading process.env produces a plain object with only `Path`.
      // Exercise the real process environment so this cannot pass through a
      // Linux-only fixture that already uses the canonical `PATH` spelling.
      const expectedPath = process.env.PATH
      expect(expectedPath).toBeTruthy()

      const environment = prepareDaemonEnvironment(baseConfig)

      expect(environment.PATH).toBe(expectedPath)
      expect(Object.keys(environment).filter(key => key.toUpperCase() === 'PATH')).toEqual(['PATH'])
      for (const key of secretKeys)
        expect(environment[key]).toBeUndefined()

      if (process.platform === 'win32') {
        const windowsBootstrapKeys = [
          'APPDATA',
          'LOCALAPPDATA',
          'PROGRAMDATA',
          'USERPROFILE',
          'HOMEDRIVE',
          'HOMEPATH',
          'SystemRoot',
          'WINDIR',
          'COMSPEC',
          'PATHEXT',
        ] as const
        for (const key of windowsBootstrapKeys) {
          const value = process.env[key]
          if (value !== undefined)
            expect(environment[key]).toBe(value)
        }
      }

      expect(fs.existsSync(PATHS.DAEMON_ENV)).toBe(false)
    }
    finally {
      for (const [key, value] of originalSecrets) {
        if (value === undefined)
          delete process.env[key]
        else
          process.env[key] = value
      }
    }
  })

  test('rejects an invalid persisted environment before restart can stop the daemon', () => {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(PATHS.DAEMON_ENV, '{invalid json', { mode: 0o600 })

    expect(() => prepareDaemonEnvironment(baseConfig, {
      usePersistedEnvironment: true,
    })).toThrow()
  })

  test('rolls both files back when the paired state commit fails', () => {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(PATHS.DAEMON_ENV, 'old environment', { mode: 0o600 })
    saveDaemonConfig({ ...baseConfig, port: 4400 })
    const oldConfig = fs.readFileSync(PATHS.DAEMON_JSON, 'utf8')

    expect(() => persistLegacyDaemonState(
      { ...baseConfig, port: 4500 },
      process.env,
      {
        saveEnvironment: () => {
          fs.writeFileSync(PATHS.DAEMON_ENV, 'new environment', { mode: 0o600 })
        },
        saveConfig: () => {
          throw new Error('simulated config commit failure')
        },
      },
    )).toThrow('simulated config commit failure')

    expect(fs.readFileSync(PATHS.DAEMON_ENV, 'utf8')).toBe('old environment')
    expect(fs.readFileSync(PATHS.DAEMON_JSON, 'utf8')).toBe(oldConfig)
  })

  test('commits matching environment, config, and token snapshots', () => {
    persistLegacyDaemonState(
      { ...baseConfig, port: 4500, githubToken: 'ghu_daemon_secret' },
      { COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal' },
    )

    expect(JSON.parse(fs.readFileSync(PATHS.DAEMON_ENV, 'utf8'))).toEqual({
      version: NATIVE_SERVICE_ENV_SCHEMA_VERSION,
      environment: {
        COPILOT_PROXY_ALLOWED_HOSTS: 'proxy.internal',
      },
    })
    expect(JSON.parse(fs.readFileSync(PATHS.DAEMON_JSON, 'utf8'))).toMatchObject({
      port: 4500,
      proxyEnv: false,
    })
    expect(fs.readFileSync(PATHS.DAEMON_JSON, 'utf8')).not.toContain('ghu_daemon_secret')
    expect(fs.readFileSync(PATHS.GITHUB_TOKEN_PATH, 'utf8')).toBe('ghu_daemon_secret')
    if (process.platform !== 'win32')
      expect(fs.statSync(PATHS.GITHUB_TOKEN_PATH).mode & 0o777).toBe(0o600)
  })
})

describe('legacy supervisor readiness', () => {
  test('rejects a child that exits before readiness', async () => {
    const readiness = mock(() => true)

    await expect(waitForSupervisorReadiness(
      { exitCode: 1, signalCode: null },
      1234,
      readiness,
    )).rejects.toThrow('exited before becoming ready')
    expect(readiness).not.toHaveBeenCalled()
  })

  test('requires consecutive ready probes before reporting success', async () => {
    const results = [true, false, true, true]
    let probe = 0

    await waitForSupervisorReadiness(
      { exitCode: null, signalCode: null },
      1234,
      () => results[probe++] ?? false,
      {
        delay: async () => {},
        requiredReadyChecks: 2,
      },
    )

    expect(probe).toBe(4)
  })

  test('rejects a live child that never becomes ready without creating a fallback PID', async () => {
    await expect(waitForSupervisorReadiness(
      { exitCode: null, signalCode: null },
      1234,
      () => false,
      {
        timeoutMs: 5,
        pollIntervalMs: 1,
      },
    )).rejects.toThrow('did not become ready')

    expect(fs.existsSync(PATHS.DAEMON_PID)).toBe(false)
  })
})
