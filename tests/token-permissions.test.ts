import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'

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
})
