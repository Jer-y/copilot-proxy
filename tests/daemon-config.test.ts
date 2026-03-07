import type { DaemonConfig } from '../src/daemon/config'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import { loadDaemonConfig, loadDaemonConfigWithRecovery, MAX_DAEMON_CONFIG_BACKUPS, saveDaemonConfig } from '../src/daemon/config'
import { PATHS } from '../src/lib/paths'

afterEach(() => {
  try {
    fs.unlinkSync(PATHS.DAEMON_JSON)
  }
  catch {}

  try {
    const entries = fs.readdirSync(PATHS.APP_DIR)
    for (const entry of entries) {
      if (entry.startsWith('daemon.json.bak.')) {
        fs.unlinkSync(path.join(PATHS.APP_DIR, entry))
      }
    }
  }
  catch {}
})

const sampleConfig: DaemonConfig = {
  port: 4399,
  verbose: false,
  accountType: 'individual',
  manual: false,
  rateLimitWait: false,
  showToken: false,
  proxyEnv: false,
}

describe('saveDaemonConfig / loadDaemonConfig', () => {
  test('saves and loads config', () => {
    saveDaemonConfig(sampleConfig)
    expect(loadDaemonConfig()).toEqual(sampleConfig)
  })

  test('saves config with optional fields', () => {
    const config = { ...sampleConfig, rateLimit: 5, githubToken: 'ghu_xxx' }
    saveDaemonConfig(config)
    expect(loadDaemonConfig()).toEqual({ ...sampleConfig, rateLimit: 5 })
  })

  test('does not persist githubToken in file', () => {
    const config = { ...sampleConfig, githubToken: 'ghu_secret' }
    saveDaemonConfig(config)
    const raw = fs.readFileSync(PATHS.DAEMON_JSON, 'utf8')
    expect(raw).not.toContain('githubToken')
    expect(raw).not.toContain('ghu_secret')
  })

  test('returns null when no config file', () => {
    expect(loadDaemonConfig()).toBeNull()
  })

  test('returns null for config with invalid port', () => {
    saveDaemonConfig(sampleConfig)
    // Overwrite with invalid data
    fs.writeFileSync(PATHS.DAEMON_JSON, JSON.stringify({ ...sampleConfig, port: 'abc' }))
    expect(loadDaemonConfig()).toBeNull()
  })

  test('returns null for config with port out of range', () => {
    saveDaemonConfig(sampleConfig)
    fs.writeFileSync(PATHS.DAEMON_JSON, JSON.stringify({ ...sampleConfig, port: 99999 }))
    expect(loadDaemonConfig()).toBeNull()
  })

  test('returns null for config with non-boolean verbose', () => {
    saveDaemonConfig(sampleConfig)
    fs.writeFileSync(PATHS.DAEMON_JSON, JSON.stringify({ ...sampleConfig, verbose: 'oops' }))
    expect(loadDaemonConfig()).toBeNull()
  })

  test('returns null for config with invalid accountType', () => {
    saveDaemonConfig(sampleConfig)
    fs.writeFileSync(PATHS.DAEMON_JSON, JSON.stringify({ ...sampleConfig, accountType: 'garbage' }))
    expect(loadDaemonConfig()).toBeNull()
  })

  test('returns null for config with non-string apiKey', () => {
    saveDaemonConfig(sampleConfig)
    fs.writeFileSync(PATHS.DAEMON_JSON, JSON.stringify({ ...sampleConfig, apiKey: 12345 }))
    expect(loadDaemonConfig()).toBeNull()
  })

  test('saves and loads config with apiKey', () => {
    const config = { ...sampleConfig, apiKey: 'my-secret-key' }
    saveDaemonConfig(config)
    expect(loadDaemonConfig()).toEqual(config)
  })

  test('persists apiKey in daemon.json file', () => {
    const config = { ...sampleConfig, apiKey: 'persisted-key' }
    saveDaemonConfig(config)
    const raw = fs.readFileSync(PATHS.DAEMON_JSON, 'utf8')
    expect(raw).toContain('persisted-key')
  })

  test('accepts valid accountType values', () => {
    for (const accountType of ['individual', 'business', 'enterprise']) {
      const config = { ...sampleConfig, accountType }
      saveDaemonConfig(config)
      expect(loadDaemonConfig()).toEqual(config)
    }
  })

  test('recovers missing config with fallback and persists it', () => {
    const result = loadDaemonConfigWithRecovery(sampleConfig)
    expect(result.recovered).toBe(true)
    expect(result.persisted).toBe(true)
    expect(result.reason).toBe('missing')
    expect(result.backupPath).toBeUndefined()
    expect(result.config).toEqual(sampleConfig)
    expect(loadDaemonConfig()).toEqual(sampleConfig)
  })

  test('keeps valid config without recovery', () => {
    const existingConfig: DaemonConfig = {
      ...sampleConfig,
      port: 4500,
      accountType: 'business',
      rateLimit: 8,
      rateLimitWait: true,
      showToken: true,
      proxyEnv: true,
    }
    const fallbackConfig: DaemonConfig = {
      ...sampleConfig,
      port: 4600,
    }
    saveDaemonConfig(existingConfig)

    const result = loadDaemonConfigWithRecovery(fallbackConfig)
    expect(result.recovered).toBe(false)
    expect(result.persisted).toBe(false)
    expect(result.reason).toBeUndefined()
    expect(result.backupPath).toBeUndefined()
    expect(result.config).toEqual(existingConfig)
    expect(loadDaemonConfig()).toEqual(existingConfig)
  })

  test('backs up invalid config and rewrites fallback', () => {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(PATHS.DAEMON_JSON, '{invalid json')

    const result = loadDaemonConfigWithRecovery(sampleConfig)
    expect(result.recovered).toBe(true)
    expect(result.persisted).toBe(true)
    expect(result.reason).toBe('invalid')
    expect(typeof result.backupPath).toBe('string')
    expect(fs.existsSync(result.backupPath!)).toBe(true)
    expect(fs.readFileSync(result.backupPath!, 'utf8')).toBe('{invalid json')
    if (process.platform !== 'win32') {
      const mode = fs.statSync(result.backupPath!).mode & 0o777
      expect(mode).toBe(0o600)
    }
    expect(loadDaemonConfig()).toEqual(sampleConfig)
  })

  test('backs up schema-invalid config and rewrites fallback', () => {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.writeFileSync(PATHS.DAEMON_JSON, JSON.stringify({ ...sampleConfig, port: '4399' }))

    const result = loadDaemonConfigWithRecovery(sampleConfig)
    expect(result.recovered).toBe(true)
    expect(result.persisted).toBe(true)
    expect(result.reason).toBe('invalid')
    expect(typeof result.backupPath).toBe('string')
    expect(fs.existsSync(result.backupPath!)).toBe(true)
    expect(loadDaemonConfig()).toEqual(sampleConfig)
  })

  test('prunes old backup files and keeps only latest N', () => {
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    const oldBackupNames = Array.from(
      { length: MAX_DAEMON_CONFIG_BACKUPS + 3 },
      (_, index) => `daemon.json.bak.${1000 + index}`,
    )
    for (const backupName of oldBackupNames) {
      fs.writeFileSync(path.join(PATHS.APP_DIR, backupName), backupName)
    }

    fs.writeFileSync(PATHS.DAEMON_JSON, '{invalid json')
    const result = loadDaemonConfigWithRecovery(sampleConfig)

    expect(result.recovered).toBe(true)
    expect(result.reason).toBe('invalid')
    expect(typeof result.backupPath).toBe('string')
    expect(fs.existsSync(result.backupPath!)).toBe(true)

    const backups = fs.readdirSync(PATHS.APP_DIR)
      .filter(name => name.startsWith('daemon.json.bak.'))
      .sort()

    expect(backups.length).toBe(MAX_DAEMON_CONFIG_BACKUPS)
    const removedCount = oldBackupNames.length + 1 - MAX_DAEMON_CONFIG_BACKUPS
    for (const removedName of oldBackupNames.slice(0, removedCount)) {
      expect(backups).not.toContain(removedName)
    }
    expect(backups).toContain(path.basename(result.backupPath!))
  })
})
