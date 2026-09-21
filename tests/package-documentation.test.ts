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

    const manifests = parsePackManifests(result.stdout)
    expect(manifests).toHaveLength(1)
    return manifests[0]
  }
  finally {
    if (stagingParent)
      fs.rmSync(stagingParent, { force: true, recursive: true })
  }
}

function parsePackManifests(output: string): PackManifest[] {
  const candidates = [...output.matchAll(/(?:^|\r?\n)[ \t]*\[/g)]
  for (const candidate of candidates.reverse()) {
    try {
      const parsed = JSON.parse(output.slice(candidate.index).trim()) as unknown
      if (Array.isArray(parsed))
        return parsed as PackManifest[]
    }
    catch {
      // Lifecycle tools can write bracket-prefixed logs before npm's JSON.
    }
  }
  throw new SyntaxError('npm pack did not emit a parseable JSON manifest')
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

  test('parses npm pack JSON after lifecycle output from older npm releases', () => {
    expect(parsePackManifests([
      '[INFO] Successfully set all git hooks',
      JSON.stringify([{ files: [{ path: 'package.json' }] }], null, 2),
    ].join('\n'))).toEqual([{ files: [{ path: 'package.json' }] }])
  })

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

  test('keeps README package-first and complete alternative installation paths in the guide', () => {
    for (const suffix of ['', '.zh-CN']) {
      const readme = fs.readFileSync(path.join(ROOT, `README${suffix}.md`), 'utf8')
      const guide = fs.readFileSync(path.join(ROOT, `docs/getting-started${suffix}.md`), 'utf8')
      expect(readme).toContain('npm install --global @jer-y/copilot-proxy@latest')
      expect(readme).toContain('copilot-proxy setup claude')
      expect(readme).toContain('copilot-proxy doctor')
      expect(readme).toContain('codex')
      expect(readme).toContain('openai-sdk')
      expect(getLocalMarkdownReferences(readme).some(ref => ref.target === `docs/getting-started${suffix}.md`)).toBe(true)
      for (const command of [
        'npm install --global @jer-y/copilot-proxy@latest',
        'npx --yes @jer-y/copilot-proxy@latest --help',
        'npx --yes @jer-y/copilot-proxy@latest setup claude',
        'npx --yes @jer-y/copilot-proxy@<version>',
        'git clone https://github.com/Jer-y/copilot-proxy.git',
        'cd copilot-proxy',
        'bun install --frozen-lockfile',
        'bun run ./src/main.ts',
      ]) {
        expect(guide).toContain(command)
      }
      for (const text of [readme, guide]) {
        expect(text).toMatch(/bundled documentation|随包文档/)
        expect(text).toMatch(/same version|同一版本/)
        expect(text).not.toMatch(/may not yet expose|尚未提供 `setup`/)
      }
    }
  })

  test('keeps current security boundaries explicit and links legacy setting migration', () => {
    const security = fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8')
    expect(security).toMatch(/approval has been removed/i)
    expect(security).toMatch(/no interactive approval step/i)
    expect(security).toContain('--manual')
    expect(security).toMatch(/Hosts[\s\S]*?Origins/)
    expect(security).toMatch(/no downstream user authentication/)
    expect(security).not.toMatch(/`--manual` is an interactive foreground safeguard|approval times out/)
    expect(getLocalMarkdownReferences(security)).toContainEqual({
      target: 'docs/operations.md',
      fragment: 'upgrade-changes-after-v0100',
    })
    expect(security).toContain('endpoint')
    expect(security).toMatch(/browser history|infrastructure logs/)
    expect(security).toMatch(/Never put credentials in the URL/)
  })

  test('keeps migration actions concise while retaining safety conditions and detail links', () => {
    const migrations = [
      { topic: /Messages ↔ Responses/, terms: [], safety: /native API|原生 API/, detail: 'protocol-compatibility' },
      { topic: /Static model|静态模型/, terms: ['models --client all --json', '--account <id>'], detail: 'protocol-compatibility' },
      { topic: /--manual/, terms: ['manual: true', 'manual: false'], safety: /only after accepting unattended forwarding|只有接受无人值守转发后/ },
      { topic: /start --claude-code/, terms: ['start -c', 'setup claude', '--copy'], detail: 'getting-started' },
      { topic: /Doctor/, terms: ['/diagnostics'], detail: '#doctor' },
      { topic: /Plaintext|明文诊断/, terms: ['/token', '--show-token', 'COPILOT_PROXY_EXPOSE_TOKEN', 'showToken'], detail: 'api-reference' },
      { topic: /Dashboard/, terms: ['/usage', '/diagnostics'], safety: /server `\/usage` API remains available|服务端 `\/usage` API 保留/ },
      { topic: /Local token|本地 token/, terms: ['usage'], detail: 'protocol-compatibility' },
      { topic: /document.source/, terms: ['tool_result'], detail: 'api-reference' },
    ]

    for (const [guidePath, heading, oldHeading] of [
      ['docs/operations.md', 'Upgrade changes after v0.10.0', 'Upgrade from pre-v0.10.0 installations'],
      ['docs/operations.zh-CN.md', 'v0.10.0 之后的升级变更', '从 v0.10.0 之前的安装升级'],
    ]) {
      const guide = fs.readFileSync(path.join(ROOT, guidePath), 'utf8')
      const section = guide.split(`## ${heading}\n`)[1]?.split('\n## ')[0]
      expect(section).toBeDefined()
      expect(section).toMatch(/not an announcement of publication|不表示新版本已经发布/)
      const rows = section!.split('\n').filter(line => line.startsWith('| ')).slice(2)
      for (const { topic, terms, safety, detail } of migrations) {
        const matches = rows.filter(row => topic.test(row.split('|')[1]))
        expect(matches).toHaveLength(1)
        for (const term of terms)
          expect(matches[0]).toContain(term)
        if (safety)
          expect(matches[0]).toMatch(safety)
        if (detail)
          expect(getLocalMarkdownReferences(matches[0]).some(ref => `${ref.target}#${ref.fragment ?? ''}`.includes(detail))).toBe(true)
      }
      expect(section).toMatch(/Reads do not rewrite files|读取不改写文件/)
      expect(section).toMatch(/next normal save|下次正常保存/)
      expect(section).toContain('doctor --endpoint <base-url> --client <client>')
      expect(section).toMatch(/real client turn|真实客户端回合/)
      expect(section).toMatch(/do not replace a real request|不能代替真实请求/)

      const oldMigration = guide.split(`## ${oldHeading}\n`)[1]?.split('\n## ')[0]
      expect(oldMigration).toBeDefined()
      expect(oldMigration).toContain('@jer-y/copilot-proxy@0.9.3')
      expect(oldMigration).toContain('@jer-y/copilot-proxy@0.10.0')
      expect(oldMigration).toContain('daemon.json')
    }
  })

  test('links the central upgrade checklist from both language entrypoints', () => {
    for (const [suffix, fragment] of [
      ['', 'upgrade-changes-after-v0100'],
      ['.zh-CN', 'v0100-之后的升级变更'],
    ]) {
      const target = `operations${suffix}.md`
      for (const file of [`README${suffix}.md`, ...['README', 'getting-started', 'deployment', 'protocol-compatibility'].map(name => `docs/${name}${suffix}.md`)]) {
        const references = getLocalMarkdownReferences(fs.readFileSync(path.join(ROOT, file), 'utf8'))
        expect(references.some(reference => path.posix.basename(reference.target) === target && reference.fragment === fragment)).toBe(true)
      }
    }
  })

  test('keeps Codex profile validation reproducible instead of recording versioned launch snapshots', () => {
    const guidePaths = [
      'docs/getting-started.md',
      'docs/getting-started.zh-CN.md',
    ]

    for (const guidePath of guidePaths) {
      const guide = fs.readFileSync(path.join(ROOT, guidePath), 'utf8')
      const namedCodexVersions = [...guide.matchAll(/\bCodex\s+(?:>=\s*)?(\d+\.\d+\.\d+)\b/g)]
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

  test('keeps the single-operator multi-account product boundary consistent', () => {
    const englishGuides = [
      'README.md',
      'docs/deployment.md',
      'docs/product-support.md',
    ].map(filePath => fs.readFileSync(path.join(ROOT, filePath), 'utf8'))
    const chineseGuides = [
      'README.zh-CN.md',
      'docs/deployment.zh-CN.md',
      'docs/product-support.zh-CN.md',
    ].map(filePath => fs.readFileSync(path.join(ROOT, filePath), 'utf8'))

    for (const guide of englishGuides) {
      expect(guide).toMatch(/one or more owner-configured|several owner-configured/)
      expect(guide).not.toContain('owns one GitHub Copilot identity')
      expect(guide).not.toContain('single-identity design')
    }
    for (const guide of chineseGuides) {
      expect(guide).toMatch(/一个或多个由所有者配置|多个由所有者管理/)
      expect(guide).not.toContain('使用一个 GitHub Copilot 身份')
      expect(guide).not.toContain('单身份设计')
    }
  })

  test('documents account concurrency and required-route transaction commands', () => {
    const englishGuide = fs.readFileSync(path.join(ROOT, 'docs/operations.md'), 'utf8')
    const chineseGuide = fs.readFileSync(path.join(ROOT, 'docs/operations.zh-CN.md'), 'utf8')
    const commands = [
      'accounts concurrency set <id> <max>',
      'accounts concurrency clear <id>',
      'accounts required-route set <surface> <model>',
      'accounts required-route remove <surface> <model>',
      'accounts required-route list [--json]',
    ]
    for (const guide of [englishGuide, chineseGuide]) {
      for (const command of commands)
        expect(guide).toContain(command)
      for (const surface of ['responses-http', 'responses-websocket', 'anthropic-messages', 'chat-completions', 'embeddings'])
        expect(guide).toContain(`\`${surface}\``)
    }
  })

  test('keeps detailed protocol contracts in their reference with direct entrypoint links', () => {
    for (const suffix of ['', '.zh-CN']) {
      const protocolPath = `docs/protocol-compatibility${suffix}.md`
      const protocol = fs.readFileSync(path.join(ROOT, protocolPath), 'utf8')
      const api = fs.readFileSync(path.join(ROOT, `docs/api-reference${suffix}.md`), 'utf8')
      const guide = fs.readFileSync(path.join(ROOT, `docs/getting-started${suffix}.md`), 'utf8')
      for (const term of ['supported_endpoints', '503 model_catalog_unavailable', 'ws:/responses', '400 invalid_request_error'])
        expect(protocol).toContain(term)
      expect(protocol).toMatch(/no bundled model table|不使用内置模型表/)
      expect(protocol).toMatch(/missing usage is not synthesized|缺失时不使用本地估算/)
      expect(protocol).toMatch(/not zero|而非零/)
      expect(protocol).toContain('POST /v1/messages/count_tokens')
      for (const term of ['60', '16 MiB', '32 MiB', '64 MiB', 'previous_response_id', 'generate: false'])
        expect(protocol).toContain(term)
      for (const term of ['document.source', 'application/pdf', 'file_id', '400 invalid_request_error', 'copilot_upstream_circuit_open', 'Retry-After', '410'])
        expect(api).toContain(term)
      expect(api).toMatch(/not resource retrieval|不证明资源已获取/)
      expect(guide).toMatch(/not a client smoke|不等于客户端冒烟/)
      expect(guide).toMatch(/before authentication|在认证前/)
      for (const entry of [`README${suffix}.md`, `docs/getting-started${suffix}.md`]) {
        const text = fs.readFileSync(path.join(ROOT, entry), 'utf8')
        expect(getLocalMarkdownReferences(text).some(ref => path.posix.basename(ref.target) === path.posix.basename(protocolPath))).toBe(true)
      }
    }
  })

  test('keeps dashboard operation and privacy in their owning pages', () => {
    const dashboardUrl = 'https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2Flocalhost%3A4399%2Fdiagnostics'
    for (const suffix of ['', '.zh-CN']) {
      const guide = fs.readFileSync(path.join(ROOT, `docs/operations${suffix}.md`), 'utf8')
      expect(guide).toContain(dashboardUrl)
      expect(guide).toContain('/diagnostics')
      expect(guide).toMatch(/JSON API, not an HTML dashboard|JSON API，不是 HTML 面板/)
      expect(guide).toMatch(/reject redirects|拒绝重定向/)
      expect(guide).toContain('model_catalog_stale')
      expect(getLocalMarkdownReferences(guide)).toContainEqual({ target: '../SECURITY.md', fragment: 'diagnostics-privacy' })
    }
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
