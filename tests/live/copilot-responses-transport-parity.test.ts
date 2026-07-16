import type { ResponsesTransportAttempt, ResponsesTransportOutcome } from './copilot-responses-transport-parity'
import type { State } from '~/lib/state'

import { expect, test } from 'bun:test'
import { state } from '~/lib/state'
import {
  buildResponsesTransportParityScenarios,
  classifyResponsesTransportAttempt,
  evaluateResponsesTransportPair,
} from './copilot-responses-transport-parity'
import {
  runDirectCopilotResponsesSSEProbe,
  runDirectCopilotResponsesWebSocketProbe,
} from './copilot-responses-websocket'

const LIVE_PARITY_ENABLED = process.env.COPILOT_LIVE_WS_PARITY === '1'
const PROBE_TIMEOUT_MS = parsePositiveInteger(
  process.env.COPILOT_LIVE_WS_PARITY_TIMEOUT_MS
  ?? process.env.COPILOT_LIVE_TIMEOUT_MS,
  180_000,
)
const SCENARIO_COUNT = 7
const LIVE_TEST_TIMEOUT_MS = PROBE_TIMEOUT_MS * SCENARIO_COUNT * 2 + 30_000
const runLiveParityTest = LIVE_PARITY_ENABLED ? test : test.skip

runLiveParityTest(
  'keeps Copilot Responses SSE and WebSocket feature semantics in parity',
  async () => {
    const config = getLiveParityConfig()
    const scenarios = buildResponsesTransportParityScenarios({
      fileSearchSentinel: config.fileSearchSentinel,
      mcpServerUrl: config.mcpServerUrl,
      model: config.model,
      vectorStoreId: config.vectorStoreId,
    })
    const failures: Array<string> = []
    const rows: Array<{
      feature: string
      sse: ResponsesTransportOutcome
      verdict: ReturnType<typeof evaluateResponsesTransportPair>
      websocket: ResponsesTransportOutcome
    }> = []

    await withLiveCopilotState(config, async () => {
      for (const scenario of scenarios) {
        const sseAttempt = await captureAttempt('sse', async () =>
          await runDirectCopilotResponsesSSEProbe({
            payload: scenario.payload,
            timeoutMs: PROBE_TIMEOUT_MS,
          }))
        const websocketAttempt = await captureAttempt('websocket', async () =>
          await runDirectCopilotResponsesWebSocketProbe({
            payload: scenario.payload,
            timeoutMs: PROBE_TIMEOUT_MS,
          }))
        const sse = classifyResponsesTransportAttempt(scenario, sseAttempt)
        const websocket = classifyResponsesTransportAttempt(scenario, websocketAttempt)
        const verdict = evaluateResponsesTransportPair(sse, websocket)

        rows.push({ feature: scenario.feature, sse, verdict, websocket })
        if (verdict.status === 'failed')
          failures.push(`${scenario.feature}: ${verdict.detail}`)
      }
    })

    printParitySummary(config, rows)
    expect(failures).toEqual([])
  },
  { timeout: LIVE_TEST_TIMEOUT_MS },
)

interface LiveParityConfig {
  accountType: string
  fileSearchSentinel?: string
  mcpServerUrl: string
  model: string
  token: string
  vectorStoreId?: string
  vsCodeVersion: string
}

function getLiveParityConfig(): LiveParityConfig {
  const token = requiredEnvironmentVariable('COPILOT_TOKEN')
  const model = requiredEnvironmentVariable('COPILOT_LIVE_RESPONSES_MODEL')
  const mcpServerUrl = process.env.COPILOT_LIVE_MCP_SERVER_URL
    ?? 'https://dmcp-server.deno.dev/mcp'

  assertPublicHttpsUrl(mcpServerUrl, 'COPILOT_LIVE_MCP_SERVER_URL')

  return {
    accountType: process.env.COPILOT_ACCOUNT_TYPE ?? 'individual',
    fileSearchSentinel: nonEmptyEnvironmentVariable('COPILOT_LIVE_FILE_SEARCH_SENTINEL'),
    mcpServerUrl,
    model,
    token,
    vectorStoreId: nonEmptyEnvironmentVariable('COPILOT_LIVE_VECTOR_STORE_ID'),
    vsCodeVersion: process.env.COPILOT_VSCODE_VERSION ?? '1.104.3',
  }
}

async function captureAttempt(
  transport: 'sse' | 'websocket',
  probe: () => Promise<ResponsesTransportAttempt['result']>,
): Promise<ResponsesTransportAttempt> {
  try {
    return {
      result: await probe(),
      transport,
    }
  }
  catch (error) {
    return { error, transport }
  }
}

async function withLiveCopilotState<T>(
  config: LiveParityConfig,
  operation: () => Promise<T>,
): Promise<T> {
  const snapshot: State = { ...state }
  state.copilotToken = config.token
  state.accountType = config.accountType
  state.vsCodeVersion = config.vsCodeVersion

  try {
    return await operation()
  }
  finally {
    Object.assign(state, snapshot)
  }
}

function printParitySummary(
  config: LiveParityConfig,
  rows: Array<{
    feature: string
    sse: ResponsesTransportOutcome
    verdict: ReturnType<typeof evaluateResponsesTransportPair>
    websocket: ResponsesTransportOutcome
  }>,
): void {
  process.stdout.write(
    `GitHub Copilot Responses transport parity: account=${config.accountType} model=${config.model}\n`,
  )
  for (const row of rows) {
    process.stdout.write(
      `- ${row.feature} sse=${row.sse.category} websocket=${row.websocket.category} verdict=${row.verdict.status}\n`,
    )
  }

  const confirmed = rows.filter(row => row.verdict.status === 'confirmed').length
  const inconclusive = rows.filter(row => row.verdict.status === 'inconclusive').length
  const failed = rows.filter(row => row.verdict.status === 'failed').length
  process.stdout.write(
    `Totals: confirmed=${confirmed} inconclusive=${inconclusive} failed=${failed}\n`,
  )
}

function requiredEnvironmentVariable(name: string): string {
  const value = nonEmptyEnvironmentVariable(name)
  if (!value)
    throw new Error(`${name} is required when COPILOT_LIVE_WS_PARITY=1`)
  return value
}

function nonEmptyEnvironmentVariable(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

function assertPublicHttpsUrl(value: string, name: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  }
  catch {
    throw new Error(`${name} must be a valid public HTTPS URL`)
  }

  if (parsed.protocol !== 'https:')
    throw new Error(`${name} must use HTTPS`)
  if (parsed.username || parsed.password)
    throw new Error(`${name} must not contain credentials`)
  if (isLocalHostname(parsed.hostname))
    throw new Error(`${name} must be reachable from the Copilot service, not a local address`)
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized.endsWith('.localhost')
    || /^127(?:\.\d{1,3}){3}$/.test(normalized)
    || /^10(?:\.\d{1,3}){3}$/.test(normalized)
    || /^192\.168(?:\.\d{1,3}){2}$/.test(normalized)
    || /^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(normalized)
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
