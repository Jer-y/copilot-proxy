import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

import { ensureOwnerOnlyFile } from '../src/lib/paths'
import { writeGithubTokenFile } from '../src/lib/token'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })))
})

describe('GitHub token file permissions', () => {
  test('writeGithubTokenFile creates token files with owner-only permissions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-proxy-token-'))
    tempDirs.push(tempDir)
    const tokenPath = path.join(tempDir, 'github_token')

    await writeGithubTokenFile(tokenPath, 'secret-token')

    await expect(fs.readFile(tokenPath, 'utf8')).resolves.toBe('secret-token')
    if (process.platform === 'win32') {
      return
    }

    const stat = await fs.stat(tokenPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test('startup corrects permissions on an existing token file', async () => {
    if (process.platform === 'win32')
      return

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-proxy-token-existing-'))
    tempDirs.push(tempDir)
    const tokenPath = path.join(tempDir, 'github_token')
    await fs.writeFile(tokenPath, 'existing-secret', { mode: 0o644 })
    await fs.chmod(tokenPath, 0o644)

    await ensureOwnerOnlyFile(tokenPath)

    expect(await fs.readFile(tokenPath, 'utf8')).toBe('existing-secret')
    const stat = await fs.stat(tokenPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  test('token file helpers preserve a clean token without trailing whitespace', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-proxy-token-trim-'))
    tempDirs.push(tempDir)
    const tokenPath = path.join(tempDir, 'github_token')
    await writeGithubTokenFile(tokenPath, 'secret-token\n')

    expect(await fs.readFile(tokenPath, 'utf8')).toBe('secret-token')
  })
})
