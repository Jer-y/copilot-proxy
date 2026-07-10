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
})
