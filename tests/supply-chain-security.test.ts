import { readdir, readFile } from 'node:fs/promises'

import { describe, expect, test } from 'bun:test'

const ROOT = new URL('../', import.meta.url)

describe('build and release supply-chain controls', () => {
  test('pins workflow actions and toolchain versions', async () => {
    const workflowDirectory = new URL('.github/workflows/', ROOT)
    const workflowFiles = (await readdir(workflowDirectory)).filter(file => file.endsWith('.yml'))
    const workflows = await Promise.all(
      workflowFiles.map(file => readFile(new URL(file, workflowDirectory), 'utf8')),
    )
    const combined = workflows.join('\n')

    expect(combined).not.toMatch(/uses:\s+\S+@v\d/)
    expect(combined).not.toContain('bun-version: latest')
    expect(combined).toContain('bun-version: 1.3.6')
    expect(combined).toContain('bun install --frozen-lockfile')
    expect(combined).toContain('Verify tag matches package version')
  })

  test('keeps npm publishing and GitHub release permissions in separate jobs', async () => {
    const release = await readFile(new URL('.github/workflows/release.yml', ROOT), 'utf8')
    const packageJson = JSON.parse(await readFile(new URL('package.json', ROOT), 'utf8')) as {
      devDependencies?: Record<string, string>
    }

    expect(release).toContain('npm-publish:')
    expect(release).toContain('github-release:')
    expect(release).toContain('id-token: write')
    expect(release).toContain('contents: write')
    expect(release).toContain('run: bun run changelog')
    expect(packageJson.devDependencies?.changelogithub).toBe('14.0.0')
  })

  test('builds from explicit source paths and excludes local credentials', async () => {
    const dockerfile = await readFile(new URL('Dockerfile', ROOT), 'utf8')
    const dockerignore = await readFile(new URL('.dockerignore', ROOT), 'utf8')
    const gitignore = await readFile(new URL('.gitignore', ROOT), 'utf8')

    expect(dockerfile).not.toContain('COPY . .')
    expect(dockerfile).toContain('COPY ./src ./src')
    expect(dockerfile).toContain('wget --spider -q http://127.0.0.1:4399/')
    expect(dockerfile).toMatch(/FROM oven\/bun:1\.3\.6-alpine@sha256:[a-f0-9]{64} AS builder/)
    expect(dockerfile).toMatch(/FROM oven\/bun:1\.3\.6-alpine@sha256:[a-f0-9]{64} AS runner/)
    for (const pattern of ['.env', '.npmrc', 'copilot-data/', 'github_token']) {
      expect(dockerignore).toContain(pattern)
      expect(gitignore).toContain(pattern)
    }
  })
})
