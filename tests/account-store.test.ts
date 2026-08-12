import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'

import { accountTokenPath, readAccountsConfiguration, readAccountToken, writeAccountsConfiguration, writeAccountToken } from '~/lib/account/store'

const temporaryDirectories: string[] = []

if (process.platform === 'win32')
  setDefaultTimeout(15_000)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { force: true, recursive: true })
})

describe('account store', () => {
  test('round-trips strict owner-only configuration and token files', () => {
    const directory = createTemporaryDirectory()
    const configPath = path.join(directory, 'accounts.json')
    const tokensDir = path.join(directory, 'tokens')
    const configuration = {
      version: 1 as const,
      revision: 3,
      defaultAccount: 'personal',
      requiredRoutes: [{ surface: 'responses-http' as const, model: 'gpt-5.4' }],
      accounts: [{
        id: 'personal',
        accountType: 'individual' as const,
        githubLogin: 'alice',
        githubUserId: 123,
      }],
      routes: [{ match: 'gpt-*', account: 'personal' }],
    }

    writeAccountsConfiguration(configuration, configPath)
    writeAccountToken('personal', 'ghp_test_token', tokensDir)

    expect(readAccountsConfiguration(configPath)).toEqual(configuration)
    expect(readAccountToken('personal', tokensDir)).toBe('ghp_test_token')
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
      expect(fs.statSync(accountTokenPath('personal', tokensDir)).mode & 0o777).toBe(0o600)
      expect(fs.statSync(tokensDir).mode & 0o777).toBe(0o700)
    }
  })

  test('rejects unknown fields, duplicate identities, and dangling routes', () => {
    const directory = createTemporaryDirectory()
    const configPath = path.join(directory, 'accounts.json')
    fs.writeFileSync(configPath, JSON.stringify({
      version: 1,
      revision: 0,
      defaultAccount: 'a',
      requiredRoutes: [],
      accounts: [{ id: 'a', accountType: 'individual', githubLogin: 'a', githubUserId: 1 }],
      routes: [],
      unknown: true,
    }))
    expect(() => readAccountsConfiguration(configPath)).toThrow('Invalid accounts configuration')

    expect(() => writeAccountsConfiguration({
      version: 1,
      revision: 0,
      defaultAccount: 'a',
      requiredRoutes: [],
      accounts: [
        { id: 'a', accountType: 'individual', githubLogin: 'a', githubUserId: 1 },
        { id: 'b', accountType: 'enterprise', githubLogin: 'b', githubUserId: 1 },
      ],
      routes: [{ match: '*', account: 'missing' }],
    }, configPath)).toThrow()
  })
})

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-account-store-'))
  temporaryDirectories.push(directory)
  return directory
}
