import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { describe, expect, setDefaultTimeout, test } from 'bun:test'

setDefaultTimeout(120_000)

const FIXTURE_PATH = path.resolve('tests/fixtures/legacy-daemon-token-bootstrap.ts')
const SECRET_ENVIRONMENT_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
] as const

interface EvidenceEvent {
  authorizationMatches?: boolean
  environment?: Record<string, boolean>
  event: string
  pid: number
  tokenMatches?: boolean
  tokenPresent?: boolean
}

interface StartScenarioOptions {
  existingToken?: string
  ghToken?: string
  githubToken?: string
  mode?: 'spawn-failure' | 'startup-failure' | 'success'
}

interface StartScenarioResult {
  cleanup: () => Promise<void>
  dataDir: string
  evidence: () => EvidenceEvent[]
  expectedToken: string
  processResult: ReturnType<typeof spawnSync>
  tokenPath: string
}

describe('legacy start -d environment-token bootstrap', () => {
  test('boots from both aliases, honors priority and blank fallback, and protects existing tokens', async () => {
    if (process.platform !== 'linux')
      return

    const cases: Array<{
      name: string
      options: StartScenarioOptions
      expectedToken: string
    }> = [
      {
        name: 'GH_TOKEN',
        options: { ghToken: 'ghu_legacy_gh_only' },
        expectedToken: 'ghu_legacy_gh_only',
      },
      {
        name: 'GITHUB_TOKEN',
        options: { githubToken: 'ghu_legacy_github_only' },
        expectedToken: 'ghu_legacy_github_only',
      },
      {
        name: 'GH_TOKEN priority',
        options: {
          ghToken: 'ghu_legacy_priority_winner',
          githubToken: 'ghu_legacy_priority_loser',
        },
        expectedToken: 'ghu_legacy_priority_winner',
      },
      {
        name: 'blank GH_TOKEN fallback',
        options: {
          ghToken: '  \t ',
          githubToken: 'ghu_legacy_blank_fallback',
        },
        expectedToken: 'ghu_legacy_blank_fallback',
      },
      {
        name: 'existing token without new input',
        options: { existingToken: 'ghu_legacy_existing_preserved' },
        expectedToken: 'ghu_legacy_existing_preserved',
      },
      {
        name: 'blank inputs preserve existing token',
        options: {
          existingToken: 'ghu_legacy_existing_blank_preserved',
          ghToken: '   ',
          githubToken: '\t',
        },
        expectedToken: 'ghu_legacy_existing_blank_preserved',
      },
      {
        name: 'new input replaces existing token',
        options: {
          existingToken: 'ghu_legacy_existing_replaced',
          githubToken: 'ghu_legacy_replacement',
        },
        expectedToken: 'ghu_legacy_replacement',
      },
    ]

    for (const testCase of cases) {
      const scenario = await startScenario(testCase.options, testCase.expectedToken)
      try {
        expect(scenario.processResult.error, testCase.name).toBeUndefined()
        expect(scenario.processResult.status, formatFailure(testCase.name, scenario)).toBe(0)
        expect(fs.readFileSync(scenario.tokenPath, 'utf8'), testCase.name).toBe(testCase.expectedToken)
        expect(fs.statSync(scenario.tokenPath).mode & 0o777, testCase.name).toBe(0o600)

        const evidence = scenario.evidence()
        expect(evidence.some(event => event.event === 'device-auth-attempt'), testCase.name).toBe(false)
        expect(evidence.find(event => event.event === 'supervisor-entry'), testCase.name).toMatchObject({
          tokenMatches: true,
          tokenPresent: true,
        })
        for (const stage of ['supervisor-entry', 'server-fetch']) {
          const environment = evidence.find(event => event.event === stage)?.environment
          expect(environment, `${testCase.name}: ${stage}`).toBeDefined()
          for (const key of SECRET_ENVIRONMENT_KEYS)
            expect(environment?.[key], `${testCase.name}: ${stage}: ${key}`).toBe(false)
        }
        for (const eventName of ['github-user', 'copilot-token', 'models']) {
          expect(evidence.find(event => event.event === eventName), `${testCase.name}: ${eventName}`)
            .toMatchObject({ authorizationMatches: true })
        }

        const output = `${scenario.processResult.stdout}\n${scenario.processResult.stderr}`
        for (const secret of [
          testCase.options.existingToken,
          testCase.options.ghToken?.trim(),
          testCase.options.githubToken?.trim(),
          ...providerSecretValues(),
        ].filter((value): value is string => Boolean(value))) {
          expect(output, `${testCase.name}: leaked ${secret}`).not.toContain(secret)
        }
        expectDaemonArtifactsNotToContain(
          scenario.dataDir,
          [
            testCase.options.existingToken,
            testCase.options.ghToken?.trim(),
            testCase.options.githubToken?.trim(),
            ...providerSecretValues(),
          ],
          testCase.name,
        )
      }
      finally {
        await scenario.cleanup()
      }
    }
  })

  test('rolls token state back after real spawn and supervisor-start failures', async () => {
    if (process.platform !== 'linux')
      return

    const cases: Array<{
      name: string
      options: StartScenarioOptions
      expectedToken: string
      restoredToken?: string
    }> = [
      {
        name: 'clean spawn failure',
        options: {
          ghToken: 'ghu_legacy_clean_spawn_failure',
          mode: 'spawn-failure',
        },
        expectedToken: 'ghu_legacy_clean_spawn_failure',
      },
      {
        name: 'existing token spawn failure',
        options: {
          existingToken: 'ghu_legacy_spawn_original',
          githubToken: 'ghu_legacy_spawn_replacement',
          mode: 'spawn-failure',
        },
        expectedToken: 'ghu_legacy_spawn_replacement',
        restoredToken: 'ghu_legacy_spawn_original',
      },
      {
        name: 'supervisor startup failure',
        options: {
          githubToken: 'ghu_legacy_startup_failure',
          mode: 'startup-failure',
        },
        expectedToken: 'ghu_legacy_startup_failure',
      },
    ]

    for (const testCase of cases) {
      const scenario = await startScenario(testCase.options, testCase.expectedToken)
      try {
        expect(scenario.processResult.error, testCase.name).toBeUndefined()
        expect(scenario.processResult.status, formatFailure(testCase.name, scenario)).toBe(1)
        expect(`${scenario.processResult.stdout}\n${scenario.processResult.stderr}`, testCase.name)
          .toContain('Failed to start daemon process')

        if (testCase.restoredToken === undefined)
          expect(fs.existsSync(scenario.tokenPath), testCase.name).toBe(false)
        else
          expect(fs.readFileSync(scenario.tokenPath, 'utf8'), testCase.name).toBe(testCase.restoredToken)

        expect(readPid(scenario.dataDir), testCase.name).toBeUndefined()
        const evidence = scenario.evidence()
        expect(evidence.some(event => event.event === 'device-auth-attempt'), testCase.name).toBe(false)
        const supervisorEntry = evidence.find(event => event.event === 'supervisor-entry')
        if (testCase.options.mode === 'startup-failure') {
          expect(supervisorEntry, testCase.name).toMatchObject({
            tokenMatches: true,
            tokenPresent: true,
          })
          for (const key of SECRET_ENVIRONMENT_KEYS)
            expect(supervisorEntry?.environment?.[key], `${testCase.name}: ${key}`).toBe(false)
        }
        else {
          expect(supervisorEntry, testCase.name).toBeUndefined()
        }
        expectDaemonArtifactsNotToContain(
          scenario.dataDir,
          [
            testCase.options.existingToken,
            testCase.options.ghToken?.trim(),
            testCase.options.githubToken?.trim(),
            ...providerSecretValues(),
          ],
          testCase.name,
        )
      }
      finally {
        await scenario.cleanup()
      }
    }
  })
})

async function startScenario(
  options: StartScenarioOptions,
  expectedToken: string,
): Promise<StartScenarioResult> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-legacy-token-'))
  const tokenPath = path.join(dataDir, 'github_token')
  if (options.existingToken !== undefined)
    fs.writeFileSync(tokenPath, options.existingToken, { mode: 0o640 })
  fs.writeFileSync(path.join(dataDir, 'scenario.json'), JSON.stringify({
    expectedToken,
    mode: options.mode ?? 'success',
  }), { mode: 0o600 })

  const port = await getUnusedPort()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COPILOT_PROXY_DATA_DIR: dataDir,
    COPILOT_PROXY_NETWORK_BOOTSTRAPPED: '1',
    GH_TOKEN: options.ghToken,
    GITHUB_TOKEN: options.githubToken,
    ...providerSecrets(),
  }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'ALL_PROXY',
    'all_proxy',
  ]) {
    delete env[key]
  }
  if (options.ghToken === undefined)
    delete env.GH_TOKEN
  if (options.githubToken === undefined)
    delete env.GITHUB_TOKEN

  const processResult = spawnSync(
    process.execPath,
    [
      FIXTURE_PATH,
      'start',
      '-d',
      '--_data-dir',
      dataDir,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      cwd: path.resolve('.'),
      encoding: 'utf8',
      env,
      timeout: 15_000,
    },
  )

  return {
    cleanup: async () => {
      const candidatePids = new Set<number>([
        ...(readPid(dataDir) === undefined ? [] : [readPid(dataDir)!]),
        ...readEvidence(dataDir).map(event => event.pid),
      ])
      for (const pid of candidatePids)
        await stopProcess(pid)
      fs.rmSync(dataDir, { force: true, recursive: true })
      expect(fs.existsSync(dataDir)).toBe(false)
    },
    dataDir,
    evidence: () => readEvidence(dataDir),
    expectedToken,
    processResult,
    tokenPath,
  }
}

function expectDaemonArtifactsNotToContain(
  dataDir: string,
  candidates: Array<string | undefined>,
  context: string,
): void {
  for (const filename of ['daemon.json', 'daemon-env.json', 'daemon.log']) {
    const filePath = path.join(dataDir, filename)
    if (!fs.existsSync(filePath))
      continue
    const contents = fs.readFileSync(filePath, 'utf8')
    for (const secret of candidates.filter((value): value is string => Boolean(value)))
      expect(contents, `${context}: ${filename} leaked ${secret}`).not.toContain(secret)
  }
}

function formatFailure(name: string, scenario: StartScenarioResult): string {
  return `${name}\nstdout:\n${scenario.processResult.stdout}\nstderr:\n${scenario.processResult.stderr}\nevidence:\n${JSON.stringify(scenario.evidence(), null, 2)}`
}

function providerSecrets(): Record<string, string> {
  return {
    COPILOT_TOKEN: 'copilot-provider-secret',
    OPENAI_API_KEY: 'openai-provider-secret',
    ANTHROPIC_API_KEY: 'anthropic-provider-secret',
    AZURE_OPENAI_API_KEY: 'azure-provider-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-provider-secret',
    GOOGLE_API_KEY: 'google-provider-secret',
    GEMINI_API_KEY: 'gemini-provider-secret',
  }
}

function providerSecretValues(): string[] {
  return Object.values(providerSecrets())
}

function readEvidence(dataDir: string): EvidenceEvent[] {
  try {
    return fs.readFileSync(path.join(dataDir, 'evidence.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as EvidenceEvent)
  }
  catch {
    return []
  }
}

function readPid(dataDir: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(dataDir, 'daemon.pid'), 'utf8').split('\n')[0]!, 10)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  }
  catch {
    return undefined
  }
}

async function stopProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid))
    return

  try {
    process.kill(pid, 'SIGTERM')
  }
  catch {}

  const deadline = Date.now() + 5_000
  while (isProcessAlive(pid) && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 25))

  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {}
  }

  const killDeadline = Date.now() + 2_000
  while (isProcessAlive(pid) && Date.now() < killDeadline)
    await new Promise(resolve => setTimeout(resolve, 25))

  expect(isProcessAlive(pid)).toBe(false)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function getUnusedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected an ephemeral TCP port')
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return address.port
}
