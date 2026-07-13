import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'

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
          '--help',
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
})
