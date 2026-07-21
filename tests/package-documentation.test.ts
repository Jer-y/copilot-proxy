import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'

const ROOT = path.resolve(import.meta.dir, '..')

interface PackManifest {
  files: Array<{ path: string }>
}

interface PackageFilesConfig {
  files?: unknown
}

interface LocalMarkdownReference {
  fragment?: string
  target: string
}

const NPM_AUTOMATIC_ROOT_DOCUMENT = /^(?:README|LICENSE|LICENCE|NOTICE|CHANGELOG|HISTORY).*/i

function copyPath(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (fs.statSync(source).isDirectory())
    fs.cpSync(source, destination, { recursive: true })
  else
    fs.copyFileSync(source, destination)
}

function copyNpmPackInputs(sourceRoot: string, destinationRoot: string): void {
  const packageJsonPath = path.join(sourceRoot, 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as PackageFilesConfig
  fs.mkdirSync(destinationRoot, { recursive: true })
  fs.copyFileSync(packageJsonPath, path.join(destinationRoot, 'package.json'))

  if (packageJson.files !== undefined && !Array.isArray(packageJson.files))
    throw new TypeError('package.json files must be an array for UNC pack staging')

  for (const configuredPath of packageJson.files ?? []) {
    if (typeof configuredPath !== 'string')
      throw new TypeError('package.json files entries must be strings for UNC pack staging')
    if (/[*?[\]{}!]/.test(configuredPath))
      throw new TypeError(`UNC pack staging does not support globbed files entry: ${configuredPath}`)

    const sourcePath = path.resolve(sourceRoot, configuredPath)
    const relativePath = path.relative(sourceRoot, sourcePath)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath))
      throw new TypeError(`Unsafe package.json files entry for UNC pack staging: ${configuredPath}`)
    if (fs.existsSync(sourcePath))
      copyPath(sourcePath, path.join(destinationRoot, relativePath))
  }

  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.isFile() && NPM_AUTOMATIC_ROOT_DOCUMENT.test(entry.name))
      fs.copyFileSync(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name))
  }

  const npmIgnorePath = path.join(sourceRoot, '.npmignore')
  if (fs.existsSync(npmIgnorePath))
    fs.copyFileSync(npmIgnorePath, path.join(destinationRoot, '.npmignore'))
}

function getPackManifest(): PackManifest {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const needsLocalStaging = process.platform === 'win32' && ROOT.startsWith('\\\\')
  const stagingParent = needsLocalStaging
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-pack-'))
    : undefined
  const packageRoot = stagingParent ? path.join(stagingParent, 'package') : ROOT

  try {
    // npm.cmd falls back to C:\\Windows for a UNC working directory, while npm
    // itself also normalizes a UNC package argument incorrectly. Mirror only
    // declared publish inputs locally; never copy arbitrary checkout contents.
    if (stagingParent)
      copyNpmPackInputs(ROOT, packageRoot)

    const result = spawnSync(
      npmExecutable,
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        timeout: 30_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)

    const manifests = JSON.parse(result.stdout) as PackManifest[]
    expect(manifests).toHaveLength(1)
    return manifests[0]
  }
  finally {
    if (stagingParent)
      fs.rmSync(stagingParent, { force: true, recursive: true })
  }
}

function getLocalMarkdownReferences(markdown: string): LocalMarkdownReference[] {
  return [...markdown.matchAll(/\]\(([^)]+)\)/g)]
    .map(match => match[1].trim())
    .filter((target) => {
      return target.length > 0
        && !/^[a-z][a-z\d+.-]*:/i.test(target)
    })
    .map((target) => {
      const [pathAndQuery, fragment] = target.split('#', 2)
      return {
        target: decodeURIComponent(pathAndQuery.split('?', 1)[0]),
        ...(fragment && { fragment: decodeURIComponent(fragment) }),
      }
    })
}

function getMarkdownHeadingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>()
  const counts = new Map<string, number>()

  for (const line of markdown.split('\n')) {
    const heading = /^#{1,6} (.*)$/.exec(line)?.[1].trim()
    if (!heading)
      continue

    const base = heading
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
    const duplicate = counts.get(base) ?? 0
    counts.set(base, duplicate + 1)
    anchors.add(duplicate === 0 ? base : `${base}-${duplicate}`)
  }

  return anchors
}

describe('published documentation', () => {
  const manifest = getPackManifest()
  const packedPaths = new Set(manifest.files.map(file => file.path))

  test('includes every repository guide in the actual npm pack manifest', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      files?: string[]
    }
    expect(packageJson.files).toContain('docs')

    const expectedMarkdownPaths = [
      'README.md',
      'README.zh-CN.md',
      'SECURITY.md',
      ...fs.readdirSync(path.join(ROOT, 'docs'))
        .filter(fileName => fileName.endsWith('.md'))
        .map(fileName => `docs/${fileName}`),
    ]

    for (const markdownPath of expectedMarkdownPaths)
      expect(packedPaths).toContain(markdownPath)
  })

  test('keeps every local link in packed Markdown inside the npm package', () => {
    const packedMarkdownPaths = [...packedPaths].filter(filePath => filePath.endsWith('.md'))

    for (const markdownPath of packedMarkdownPaths) {
      const markdown = fs.readFileSync(path.join(ROOT, markdownPath), 'utf8')
      for (const { target } of getLocalMarkdownReferences(markdown)) {
        if (!target)
          continue
        const resolvedTarget = path.posix.normalize(
          path.posix.join(path.posix.dirname(markdownPath), target),
        )
        expect(packedPaths).toContain(resolvedTarget)
      }
    }
  })

  test('keeps every local Markdown anchor valid', () => {
    const packedMarkdownPaths = [...packedPaths].filter(filePath => filePath.endsWith('.md'))
    const anchorsByPath = new Map(packedMarkdownPaths.map((markdownPath) => {
      const markdown = fs.readFileSync(path.join(ROOT, markdownPath), 'utf8')
      return [markdownPath, getMarkdownHeadingAnchors(markdown)] as const
    }))

    for (const markdownPath of packedMarkdownPaths) {
      const markdown = fs.readFileSync(path.join(ROOT, markdownPath), 'utf8')
      for (const reference of getLocalMarkdownReferences(markdown)) {
        if (!reference.fragment)
          continue
        const resolvedTarget = reference.target
          ? path.posix.normalize(path.posix.join(path.posix.dirname(markdownPath), reference.target))
          : markdownPath
        expect(anchorsByPath.get(resolvedTarget)).toContain(reference.fragment)
      }
    }
  })

  test('ships the documentation path returned by models --json', () => {
    const modelsSource = fs.readFileSync(path.join(ROOT, 'src/models.ts'), 'utf8')
    const documentationPath = modelsSource.match(/documentation:\s*'([^']+)'/)?.[1]

    expect(documentationPath).toBe('docs/protocol-compatibility.md')
    expect(packedPaths).toContain(documentationPath!)
    expect(fs.existsSync(path.join(ROOT, documentationPath!))).toBe(true)
  })

  test('copies published documentation and its root README link targets into the final Docker image', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    const runnerStage = dockerfile.slice(dockerfile.indexOf(' AS runner'))

    expect(runnerStage).toContain('COPY --chown=bun:bun ./docs ./docs')
    expect(runnerStage).toContain('COPY --chown=bun:bun ./README.md ./README.zh-CN.md ./SECURITY.md ./')
    expect(dockerignore).toContain('!README.md')
    expect(dockerignore).toContain('!README.zh-CN.md')
    expect(dockerignore).toContain('!SECURITY.md')
    const dockerignoreLines = dockerignore.split(/\r?\n/)
    const markdownExcludeIndex = dockerignoreLines.indexOf('*.md')
    const docsIncludeIndex = dockerignoreLines.indexOf('!docs/**/*.md')
    expect(markdownExcludeIndex).toBeGreaterThanOrEqual(0)
    expect(docsIncludeIndex).toBeGreaterThan(markdownExcludeIndex)
    expect([...packedPaths].filter(filePath => filePath.startsWith('docs/') && filePath.endsWith('.md')).length).toBeGreaterThan(0)
  })

  test('ships the repository license in the npm package and final Docker image', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
    const runnerStage = dockerfile.slice(dockerfile.indexOf(' AS runner'))

    expect(packedPaths).toContain('LICENSE')
    expect(fs.existsSync(path.join(ROOT, 'LICENSE'))).toBe(true)
    expect(runnerStage).toContain('COPY --chown=bun:bun ./LICENSE ./LICENSE')
  })

  test('documents runnable registry and source-checkout entry paths from an empty directory', () => {
    const guidePaths = [
      'README.md',
      'README.zh-CN.md',
      'docs/getting-started.md',
      'docs/getting-started.zh-CN.md',
    ]

    for (const guidePath of guidePaths) {
      const guide = fs.readFileSync(path.join(ROOT, guidePath), 'utf8')

      expect(guide).toContain('npm install --global @jer-y/copilot-proxy@latest')
      expect(guide).toContain('npx --yes @jer-y/copilot-proxy@latest --help')
      expect(guide).toContain('npx --yes @jer-y/copilot-proxy@latest start')
      expect(guide).toContain('git clone https://github.com/Jer-y/copilot-proxy.git')
      expect(guide).toContain('cd copilot-proxy')
      expect(guide).toContain('bun install --frozen-lockfile')

      const releaseWarning = guide.split('\n').find((line) => {
        return line.includes('registry')
          && line.includes('`latest`')
          && line.includes('`setup`')
      })
      expect(releaseWarning).toContain('`models`')
      expect(releaseWarning).toContain('`doctor`')
      expect(releaseWarning).toContain('`--help`')
    }
  })

  test('keeps Codex profile validation reproducible instead of recording versioned launch snapshots', () => {
    const guidePaths = [
      'docs/getting-started.md',
      'docs/getting-started.zh-CN.md',
    ]

    for (const guidePath of guidePaths) {
      const guide = fs.readFileSync(path.join(ROOT, guidePath), 'utf8')
      const namedCodexVersions = [...guide.matchAll(/\bCodex\s+(\d+\.\d+\.\d+)\b/g)]
        .map(match => match[1])

      expect(new Set(namedCodexVersions)).toEqual(new Set(['0.134.0']))
      expect(guide).toContain('Codex model catalog response: client_version=<installed-version> status=200')
      expect(guide).toContain('POST /v1/responses')
      expect(guide).toContain('response.create')
      expect(guide).toContain('auth cannot be combined with env_key')
      expect(guide).toContain('metadata fallback')
      expect(guide).not.toContain('may not yet expose')
      expect(guide).not.toContain('尚未提供 `setup`')
    }
  })

  test('describes setup writes precisely in both published READMEs', () => {
    const englishReadme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    const chineseReadme = fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8')

    expect(englishReadme).toContain('without writing client configuration files')
    expect(englishReadme).toContain('copilot-proxy\'s own authentication data')
    expect(englishReadme).not.toContain('without writing user files')
    expect(chineseReadme).toContain('不写入客户端配置文件')
    expect(chineseReadme).toContain('copilot-proxy 自身的认证数据')
    expect(chineseReadme).not.toContain('不写入用户文件')
  })

  test('documents layered setup route evidence without promoting policy fallback to live proof', () => {
    const englishReadme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    const chineseReadme = fs.readFileSync(path.join(ROOT, 'README.zh-CN.md'), 'utf8')
    const englishGuide = fs.readFileSync(path.join(ROOT, 'docs/getting-started.md'), 'utf8')
    const chineseGuide = fs.readFileSync(path.join(ROOT, 'docs/getting-started.zh-CN.md'), 'utf8')

    expect(englishReadme).toContain('a non-empty live `supported_endpoints` list as authoritative')
    expect(englishReadme).toContain('otherwise may use bundled proxy policy')
    expect(englishReadme).toContain('WebSocket always requires explicit live `ws:/responses`')
    expect(englishReadme).toContain('not live route or semantic proof')
    expect(chineseReadme).toContain('非空的实时 `supported_endpoints` 列表为权威依据')
    expect(chineseReadme).toContain('否则可使用代理内置策略回退')
    expect(chineseReadme).toContain('WebSocket 始终要求实时明确的 `ws:/responses`')
    expect(chineseReadme).toContain('不是实时路由或语义证明')

    expect(englishGuide).toContain('When a model\'s `supported_endpoints` list is present and non-empty, that live metadata is authoritative')
    expect(englishGuide).toContain('When `supported_endpoints` is missing or empty, setup may instead fall back to copilot-proxy\'s bundled routing policy')
    expect(englishGuide).toContain('Responses WebSocket never uses this fallback')
    expect(englishGuide).toContain('Codex further intersects the HTTP Responses-eligible models with the usable installed bundled entries')
    expect(englishGuide).toContain('the setup route probes separately validate observable proxy-route semantics')
    expect(chineseGuide).toContain('`supported_endpoints` 列表存在且非空时，以该实时 metadata 为权威依据')
    expect(chineseGuide).toContain('`supported_endpoints` 缺失或为空时，setup 才可回退到 copilot-proxy 的内置路由策略')
    expect(chineseGuide).toContain('Responses WebSocket 从不使用这项回退')
    expect(chineseGuide).toContain('Codex 还会把具备 HTTP Responses 资格的模型与已安装 bundled catalog 中相同 slug 的可用条目取交集')
    expect(chineseGuide).toContain('setup 路由探测会另行验证可观察的代理路由语义')

    for (const guide of [englishReadme, englishGuide]) {
      expect(guide).not.toContain('must also advertise a live Responses route')
      expect(guide).not.toContain('only when that live catalog advertises a Responses route')
      expect(guide).not.toContain('live Responses models')
    }
    for (const guide of [chineseReadme, chineseGuide]) {
      expect(guide).not.toContain('必须提供实时 Responses 路由')
      expect(guide).not.toContain('同时通过实时 Copilot Responses 路由')
    }
  })

  test('links the hosted dashboard while describing diagnostics as a JSON API', () => {
    const dashboardUrl = 'https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2Flocalhost%3A4399%2Fdiagnostics'
    const guides = [
      'README.md',
      'README.zh-CN.md',
      'docs/operations.md',
      'docs/operations.zh-CN.md',
    ]

    for (const guidePath of guides) {
      const guide = fs.readFileSync(path.join(ROOT, guidePath), 'utf8')
      expect(guide).toContain(dashboardUrl)
      expect(guide).toContain('/diagnostics')
    }
    expect(fs.readFileSync(path.join(ROOT, 'docs/operations.md'), 'utf8')).toContain('JSON API, not an HTML dashboard')
    expect(fs.readFileSync(path.join(ROOT, 'docs/operations.zh-CN.md'), 'utf8')).toContain('JSON API，不是 HTML 面板')
  })

  test('documents every model variable required by the live proxy route suite', () => {
    const guide = fs.readFileSync(path.join(ROOT, 'docs/copilot-capability-validation.md'), 'utf8')
    const routeSuiteRow = guide.split('\n').find(line => line.startsWith('| Live proxy route suite |'))

    expect(routeSuiteRow).toContain('COPILOT_LIVE_CHAT_MODEL=')
    expect(routeSuiteRow).toContain('COPILOT_LIVE_RESPONSES_MODEL=')
    expect(routeSuiteRow).toContain('COPILOT_LIVE_EMBEDDING_MODEL=')
  })

  test('does not describe generic live-probe acceptance as semantic support', () => {
    const guide = fs.readFileSync(path.join(ROOT, 'docs/copilot-capability-validation.md'), 'utf8')

    expect(guide).toContain('https://github.com/Jer-y/copilot-proxy/blob/main/tests/live/copilot-capability-matrix.ts')
    expect(guide).toContain('This is not a uniform semantic-support claim.')
    expect(guide).toContain('the probe used `tool_choice:none`')
    expect(guide).toContain('Parse the generated output and validate it against the requested JSON/schema contract')
    expect(guide).toContain('Verify the requested tool was selected')
    expect(guide).not.toContain('`supported`: the semantic validator passed.')
  })
})

describe('UNC npm pack staging', () => {
  test('copies publish inputs without mirroring ignored checkout secrets', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-pack-source-'))
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-pack-target-'))

    try {
      fs.mkdirSync(path.join(fixtureRoot, 'dist'))
      fs.mkdirSync(path.join(fixtureRoot, 'docs'))
      fs.mkdirSync(path.join(fixtureRoot, '.codex'))
      fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ files: ['dist', 'docs'] }))
      fs.writeFileSync(path.join(fixtureRoot, 'dist', 'main.js'), 'published')
      fs.writeFileSync(path.join(fixtureRoot, 'docs', 'guide.md'), 'published')
      fs.writeFileSync(path.join(fixtureRoot, 'README.md'), 'published')
      fs.writeFileSync(path.join(fixtureRoot, 'LICENSE'), 'published')
      fs.writeFileSync(path.join(fixtureRoot, '.npmignore'), '*.tmp')
      fs.writeFileSync(path.join(fixtureRoot, '.env'), 'sentinel-secret')
      fs.writeFileSync(path.join(fixtureRoot, '.npmrc'), 'sentinel-secret')
      fs.writeFileSync(path.join(fixtureRoot, 'github_token'), 'sentinel-secret')
      fs.writeFileSync(path.join(fixtureRoot, '.codex', 'credentials.json'), 'sentinel-secret')

      copyNpmPackInputs(fixtureRoot, stagingRoot)

      expect(fs.existsSync(path.join(stagingRoot, 'package.json'))).toBe(true)
      expect(fs.existsSync(path.join(stagingRoot, 'dist', 'main.js'))).toBe(true)
      expect(fs.existsSync(path.join(stagingRoot, 'docs', 'guide.md'))).toBe(true)
      expect(fs.existsSync(path.join(stagingRoot, 'README.md'))).toBe(true)
      expect(fs.existsSync(path.join(stagingRoot, 'LICENSE'))).toBe(true)
      expect(fs.existsSync(path.join(stagingRoot, '.npmignore'))).toBe(true)
      expect(fs.existsSync(path.join(stagingRoot, '.env'))).toBe(false)
      expect(fs.existsSync(path.join(stagingRoot, '.npmrc'))).toBe(false)
      expect(fs.existsSync(path.join(stagingRoot, 'github_token'))).toBe(false)
      expect(fs.existsSync(path.join(stagingRoot, '.codex'))).toBe(false)
    }
    finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true })
      fs.rmSync(stagingRoot, { force: true, recursive: true })
    }
  })

  test('rejects package inputs outside the package root', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-pack-source-'))
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-pack-target-'))

    try {
      fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify({ files: ['..'] }))

      expect(() => copyNpmPackInputs(fixtureRoot, stagingRoot)).toThrow(
        'Unsafe package.json files entry for UNC pack staging: ..',
      )
    }
    finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true })
      fs.rmSync(stagingRoot, { force: true, recursive: true })
    }
  })
})
