import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

interface LegacyDaemonTokenScenario {
  expectedToken: string
  mode: 'spawn-failure' | 'startup-failure' | 'success'
}

const configuredDataDir = process.env.COPILOT_PROXY_DATA_DIR
if (!configuredDataDir)
  throw new Error('Legacy daemon token fixture requires COPILOT_PROXY_DATA_DIR')
const dataDir: string = configuredDataDir

const scenarioPath = path.join(dataDir, 'scenario.json')
const evidencePath = path.join(dataDir, 'evidence.jsonl')
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) as LegacyDaemonTokenScenario
const mainSource = new URL('../../src/main.ts', import.meta.url).href
const supervisor = process.argv.includes('--_supervisor')
const secretEnvironmentKeys = [
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

function appendEvidence(event: string, details: Record<string, unknown> = {}): void {
  fs.appendFileSync(evidencePath, `${JSON.stringify({
    event,
    pid: process.pid,
    ...details,
  })}\n`)
}

function environmentPresence(): Record<string, boolean> {
  return Object.fromEntries(secretEnvironmentKeys.map(key => [
    key,
    process.env[key] !== undefined,
  ]))
}

function readPersistedToken(): string | undefined {
  try {
    return fs.readFileSync(path.join(dataDir, 'github_token'), 'utf8').trim()
  }
  catch {
    return undefined
  }
}

if (supervisor) {
  const persistedToken = readPersistedToken()
  appendEvidence('supervisor-entry', {
    environment: environmentPresence(),
    tokenMatches: persistedToken === scenario.expectedToken,
    tokenPresent: persistedToken !== undefined,
  })

  if (scenario.mode === 'startup-failure') {
    appendEvidence('synthetic-startup-failure')
    process.exit(87)
  }
}
else if (scenario.mode === 'spawn-failure') {
  // daemonStart uses process.argv[1] as the detached supervisor script. Point
  // only the parent invocation at a nonexistent copy so the production spawn
  // and rollback path is exercised without deleting a repository fixture.
  process.argv[1] = path.join(dataDir, 'missing-supervisor-entrypoint.ts')
}

let recordedServerEnvironment = false
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const headers = input instanceof Request
    ? new Headers(input.headers)
    : new Headers(init?.headers)

  if (supervisor && !recordedServerEnvironment) {
    recordedServerEnvironment = true
    appendEvidence('server-fetch', {
      environment: environmentPresence(),
    })
  }

  if (url.hostname === 'update.code.visualstudio.com')
    return Response.json(['1.104.3'])

  if (url.hostname === 'github.com' && url.pathname === '/login/device/code') {
    appendEvidence('device-auth-attempt')
    // A missing persisted token would otherwise make the real supervisor retry
    // device auth with exponential backoff. Exit immediately after proving the
    // unintended network path so the regression remains deterministic.
    process.exit(86)
  }

  if (url.hostname === 'api.github.com' && url.pathname === '/user') {
    const authorizationMatches = headers.get('authorization') === `token ${scenario.expectedToken}`
    appendEvidence('github-user', { authorizationMatches })
    return authorizationMatches
      ? Response.json({ login: 'legacy-daemon-fixture' })
      : new Response('unauthorized', { status: 401 })
  }

  if (url.hostname === 'api.github.com' && url.pathname === '/copilot_internal/v2/token') {
    const authorizationMatches = headers.get('authorization') === `token ${scenario.expectedToken}`
    appendEvidence('copilot-token', { authorizationMatches })
    return authorizationMatches
      ? Response.json({
          expires_at: Math.floor(Date.now() / 1_000) + 3_600,
          refresh_in: 3_600,
          token: 'copilot-fixture-token',
        })
      : new Response('unauthorized', { status: 401 })
  }

  if (url.hostname.endsWith('githubcopilot.com') && url.pathname === '/models') {
    const authorizationMatches = headers.get('authorization') === 'Bearer copilot-fixture-token'
    appendEvidence('models', { authorizationMatches })
    return authorizationMatches
      ? Response.json({
          data: [{
            id: 'gpt-fixture',
            name: 'gpt-fixture',
            vendor: 'OpenAI',
            version: '1',
            object: 'model',
            preview: false,
            model_picker_enabled: true,
            supported_endpoints: ['/responses'],
            capabilities: {
              family: 'gpt-fixture',
              limits: {
                max_context_window_tokens: 128_000,
                max_output_tokens: 16_000,
              },
              object: 'model_capabilities',
              supports: { tool_calls: true },
              tokenizer: 'o200k_base',
              type: 'chat',
            },
          }],
          object: 'list',
        })
      : new Response('unauthorized', { status: 401 })
  }

  appendEvidence('unexpected-fetch', {
    hostname: url.hostname,
    pathname: url.pathname,
  })
  return new Response('unexpected fixture request', { status: 500 })
}) as typeof fetch

void import(mainSource).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
