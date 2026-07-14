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
    expect(combined.match(/persist-credentials: false/g)).toHaveLength(
      combined.match(/uses: actions\/checkout@/g)?.length ?? 0,
    )
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

  test('publishes Pages and Docker artifacts only after validation', async () => {
    const ci = await readFile(new URL('.github/workflows/ci.yml', ROOT), 'utf8')
    const release = await readFile(new URL('.github/workflows/release.yml', ROOT), 'utf8')
    const workflowDirectory = new URL('.github/workflows/', ROOT)
    const workflowFiles = await readdir(workflowDirectory)

    expect(ci).toContain('deploy-pages:')
    expect(ci).toContain('needs: [test, native-service-adapters]')
    expect(ci).toContain('if: (github.event_name == \'push\' && github.ref == \'refs/heads/main\') || github.event_name == \'workflow_dispatch\'')
    expect(ci).toContain('run: bun run test:node:http')
    expect(ci).toContain('native-service-adapters:')
    expect(ci).toContain('os: macos-latest')
    expect(ci).toContain('os: windows-latest')
    expect(release).toContain('docker-publish:')
    expect(release).toContain('native-service-adapters:')
    expect(release.match(/needs: \[validate, native-service-adapters\]/g)).toHaveLength(2)
    expect(release).toContain('needs: [npm-publish, docker-publish]')
    expect(release).toContain('permissions: {}')
    expect(release).toContain('group: release-publish')
    expect(release).not.toMatch(/group: release-\$\{\{ github\.ref \}\}/)
    expect(release).toContain('fetch-depth: 0')
    expect(release).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')
    expect(release).toContain('npm view @jer-y/copilot-proxy dist-tags.latest')
    expect(release).toContain('bun run ./scripts/verify-release-version.ts')
    expect(release.match(/no-cache: true/g)).toHaveLength(4)
    expect(release.match(/package-manager-cache: false/g)).toHaveLength(3)
    expect(release).toContain('aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25')
    expect(release.match(/version: v0\.70\.0/g)).toHaveLength(2)
    expect(release.match(/cache-dir: \$\{\{ runner\.temp \}\}\/trivy-cache/g)).toHaveLength(2)
    expect(release).toContain('platforms: linux/amd64,linux/arm64')
    expect(release.match(/uses: docker\/build-push-action@/g)).toHaveLength(1)
    expect(release).toContain('push-by-digest=true')
    expect(release).toContain('name-canonical=true')
    expect(release).toContain('id: platform-digests')
    expect(release).toContain('steps.platform-digests.outputs.amd64')
    expect(release).toContain('steps.platform-digests.outputs.arm64')
    expect(release).toContain('docker buildx imagetools create')
    expect(release).toContain('--metadata-file "$metadata_file"')
    expect(release).toContain('."containerimage.descriptor".digest')
    expect(release).toContain('if [[ "$published_digest" != "$INDEX_DIGEST" ]]')
    expect(release).not.toContain('load: true')
    expect(release).not.toContain('copilot-proxy:scan-')
    expect(release).toMatch(/image: docker\.io\/tonistiigi\/binfmt@sha256:[a-f0-9]{64}/)
    expect(release).not.toContain('tonistiigi/binfmt:latest')
    expect(release).toContain('version: v0.35.0')
    expect(release).toContain('cache-binary: false')
    expect(release).toMatch(/driver-opts: image=moby\/buildkit@sha256:[a-f0-9]{64}/)
    expect(release).not.toContain('moby/buildkit:buildx-stable-1')
    expect(workflowFiles).not.toContain('deploy-pages.yml')
    expect(workflowFiles).not.toContain('release-docker.yml')
  })

  test('builds from explicit source paths and excludes local credentials', async () => {
    const dockerfile = await readFile(new URL('Dockerfile', ROOT), 'utf8')
    const dockerignore = await readFile(new URL('.dockerignore', ROOT), 'utf8')
    const gitignore = await readFile(new URL('.gitignore', ROOT), 'utf8')

    expect(dockerfile).not.toContain('COPY . .')
    expect(dockerfile).toContain('COPY ./src ./src')
    expect(dockerfile).toContain('CMD /entrypoint.sh --healthcheck')
    expect(dockerfile).toContain('COPY --chown=bun:bun scripts/resolve-container-port.sh /resolve-container-port.sh')
    expect(dockerfile).not.toContain('wget --spider -q http://127.0.0.1:4399/')
    expect(dockerfile).toMatch(/FROM oven\/bun:1\.3\.6-alpine@sha256:[a-f0-9]{64} AS builder/)
    expect(dockerfile).toMatch(/FROM oven\/bun:1\.3\.6-alpine@sha256:[a-f0-9]{64} AS runner/)
    expect(dockerfile.match(/RUN apk upgrade --no-cache/g)).toHaveLength(2)
    for (const pattern of ['.env', '.npmrc', 'copilot-data/', 'github_token']) {
      expect(dockerignore).toContain(pattern)
      expect(gitignore).toContain(pattern)
    }
  })

  test('pins the optional Playwright MCP image and does not grant host networking', async () => {
    const config = JSON.parse(await readFile(new URL('opencode.json', ROOT), 'utf8')) as {
      mcp?: { playwright?: { command?: string[] } }
    }
    const command = config.mcp?.playwright?.command ?? []
    const image = command.find(value => value.startsWith('mcr.microsoft.com/playwright/mcp'))

    expect(image).toMatch(/^mcr\.microsoft\.com\/playwright\/mcp@sha256:[a-f0-9]{64}$/)
    expect(command.join(' ')).not.toContain('--network host')
  })
})
