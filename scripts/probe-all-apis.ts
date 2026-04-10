#!/usr/bin/env bun
/**
 * Probe ALL models against ALL 3 API backends on the Copilot backend.
 * Usage: ACCOUNT_TYPE=individual|enterprise bun scripts/probe-all-apis.ts
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

// ── Config ──────────────────────────────────────────────────────────
const ACCOUNT_TYPE = process.env.ACCOUNT_TYPE || 'individual'
const BASE_URL = ACCOUNT_TYPE === 'individual'
  ? 'https://api.githubcopilot.com'
  : `https://api.${ACCOUNT_TYPE}.githubcopilot.com`

const COPILOT_VERSION = '0.26.7'
const VSCODE_VERSION = '1.104.3'

// ── Auth ────────────────────────────────────────────────────────────
async function getGithubToken(): Promise<string> {
  const tokenPath = join(homedir(), '.local', 'share', 'copilot-proxy', 'github_token')
  const token = (await readFile(tokenPath, 'utf-8')).trim()
  if (!token)
    throw new Error('No GitHub token found')
  return token
}

async function getCopilotToken(githubToken: string): Promise<string> {
  const res = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: {
      'authorization': `token ${githubToken}`,
      'content-type': 'application/json',
      'accept': 'application/json',
      'editor-version': `vscode/${VSCODE_VERSION}`,
      'editor-plugin-version': `copilot-chat/${COPILOT_VERSION}`,
      'user-agent': `GitHubCopilotChat/${COPILOT_VERSION}`,
      'x-github-api-version': '2025-05-01',
    },
  })
  if (!res.ok)
    throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as { token: string }
  return data.token
}

function makeHeaders(copilotToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${copilotToken}`,
    'content-type': 'application/json',
    'copilot-integration-id': 'vscode-chat',
    'editor-version': `vscode/${VSCODE_VERSION}`,
    'editor-plugin-version': `copilot-chat/${COPILOT_VERSION}`,
    'user-agent': `GitHubCopilotChat/${COPILOT_VERSION}`,
    'openai-intent': 'conversation-agent',
    'x-interaction-type': 'conversation-agent',
    'x-github-api-version': '2025-05-01',
    'x-request-id': randomUUID(),
    'x-vscode-user-agent-library-version': 'electron-fetch',
    'X-Initiator': 'user',
  }
}

// ── Model listing ───────────────────────────────────────────────────
interface ModelEntry {
  id: string
  name: string
  vendor: string
  version: string
  preview: boolean
  model_picker_enabled: boolean
  capabilities?: {
    family?: string
    type?: string
    limits?: { max_output_tokens?: number }
  }
}

async function getModels(copilotToken: string): Promise<ModelEntry[]> {
  const res = await fetch(`${BASE_URL}/models`, {
    headers: makeHeaders(copilotToken),
  })
  if (!res.ok)
    throw new Error(`Models fetch failed: ${res.status} ${await res.text()}`)
  const data = await res.json() as { data: ModelEntry[] }
  return data.data
}

// ── API probes ──────────────────────────────────────────────────────
interface ProbeResult {
  status: number
  ok: boolean
  error?: string
  errorCode?: string
  model_used?: string
  content_preview?: string
  stop_reason?: string
  usage?: any
}

async function probeChatCompletions(
  model: string,
  copilotToken: string,
): Promise<ProbeResult> {
  const headers = makeHeaders(copilotToken)
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: PROBE_OK' }],
        max_tokens: 32,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await res.json() as any
    if (!res.ok) {
      return {
        status: res.status,
        ok: false,
        error: body?.error?.message || JSON.stringify(body).slice(0, 200),
        errorCode: body?.error?.code,
      }
    }
    return {
      status: res.status,
      ok: true,
      model_used: body.model,
      content_preview: body.choices?.[0]?.message?.content?.slice(0, 80),
      stop_reason: body.choices?.[0]?.finish_reason,
      usage: body.usage,
    }
  }
  catch (e: any) {
    return { status: 0, ok: false, error: e.message?.slice(0, 200) }
  }
}

async function probeResponses(
  model: string,
  copilotToken: string,
): Promise<ProbeResult> {
  const headers = makeHeaders(copilotToken)
  try {
    const res = await fetch(`${BASE_URL}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: 'Reply with exactly: PROBE_OK',
        max_output_tokens: 32,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await res.json() as any
    if (!res.ok) {
      return {
        status: res.status,
        ok: false,
        error: body?.error?.message || JSON.stringify(body).slice(0, 200),
        errorCode: body?.error?.code,
      }
    }
    const textOutput = body.output?.find((o: any) => o.type === 'message')
    const content = textOutput?.content?.[0]?.text
    return {
      status: res.status,
      ok: true,
      model_used: body.model,
      content_preview: content?.slice(0, 80),
      stop_reason: body.status,
      usage: body.usage,
    }
  }
  catch (e: any) {
    return { status: 0, ok: false, error: e.message?.slice(0, 200) }
  }
}

async function probeAnthropicMessages(
  model: string,
  copilotToken: string,
): Promise<ProbeResult> {
  const headers = makeHeaders(copilotToken)
  try {
    const res = await fetch(`${BASE_URL}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Reply with exactly: PROBE_OK' }],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const body = await res.json() as any
    if (!res.ok) {
      return {
        status: res.status,
        ok: false,
        error: body?.error?.message || JSON.stringify(body).slice(0, 200),
        errorCode: body?.error?.code || body?.type,
      }
    }
    const textBlock = body.content?.find((c: any) => c.type === 'text')
    return {
      status: res.status,
      ok: true,
      model_used: body.model,
      content_preview: textBlock?.text?.slice(0, 80),
      stop_reason: body.stop_reason,
      usage: body.usage,
    }
  }
  catch (e: any) {
    return { status: 0, ok: false, error: e.message?.slice(0, 200) }
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${'='.repeat(80)}`)
  console.log(`  Copilot Backend API Probe — ${new Date().toISOString()}`)
  console.log(`  Base URL: ${BASE_URL}`)
  console.log(`${'='.repeat(80)}\n`)

  // Auth
  console.log('🔑 Authenticating...')
  const githubToken = await getGithubToken()
  const copilotToken = await getCopilotToken(githubToken)
  console.log('✅ Got Copilot token\n')

  // Models
  console.log('📋 Fetching models...')
  const models = await getModels(copilotToken)
  console.log(`✅ Found ${models.length} models:\n`)
  for (const m of models) {
    console.log(`   • ${m.id} (${m.vendor}, ${m.version}, picker=${m.model_picker_enabled}, preview=${m.preview})`)
  }

  // Filter to model-picker-enabled ones + add any extras we want to test
  const testModels = models
    .filter(m => m.model_picker_enabled)
    .map(m => m.id)

  // Also add models that might not be picker-enabled but we know exist
  const extras = models.filter(m => !m.model_picker_enabled).map(m => m.id)
  if (extras.length > 0) {
    console.log(`\n   Non-picker models (also testing): ${extras.join(', ')}`)
    testModels.push(...extras)
  }

  // Deduplicate
  const uniqueModels = [...new Set(testModels)]

  console.log(`\n${'─'.repeat(80)}`)
  console.log(`  Testing ${uniqueModels.length} models × 3 APIs = ${uniqueModels.length * 3} probes`)
  console.log(`${'─'.repeat(80)}\n`)

  // Run probes - sequential to avoid rate limiting
  const results: Array<{
    model: string
    cc: ProbeResult
    resp: ProbeResult
    anthro: ProbeResult
  }> = []

  for (const modelId of uniqueModels) {
    console.log(`🔍 Probing ${modelId}...`)

    const cc = await probeChatCompletions(modelId, copilotToken)
    const statusCC = cc.ok ? '✅' : '❌'
    console.log(`   CC:     ${statusCC} ${cc.status} ${cc.ok ? cc.content_preview : cc.errorCode || cc.error?.slice(0, 60)}`)

    const resp = await probeResponses(modelId, copilotToken)
    const statusResp = resp.ok ? '✅' : '❌'
    console.log(`   Resp:   ${statusResp} ${resp.status} ${resp.ok ? resp.content_preview : resp.errorCode || resp.error?.slice(0, 60)}`)

    const anthro = await probeAnthropicMessages(modelId, copilotToken)
    const statusAnthro = anthro.ok ? '✅' : '❌'
    console.log(`   Anthro: ${statusAnthro} ${anthro.status} ${anthro.ok ? anthro.content_preview : anthro.errorCode || anthro.error?.slice(0, 60)}`)

    results.push({ model: modelId, cc, resp, anthro })
    console.log()
  }

  // ── Summary table ──────────────────────────────────────────────────
  console.log(`\n${'='.repeat(80)}`)
  console.log('  RESULTS SUMMARY')
  console.log(`${'='.repeat(80)}\n`)

  const pad = (s: string, n: number) => s.padEnd(n)

  console.log(
    `${pad('Model', 28)} ${pad('CC', 14)} ${pad('Responses', 14)} ${pad('Anthropic', 14)}`,
  )
  console.log('─'.repeat(70))

  for (const r of results) {
    const ccStatus = r.cc.ok ? `✅ ${r.cc.status}` : `❌ ${r.cc.status} ${r.cc.errorCode || ''}`
    const respStatus = r.resp.ok ? `✅ ${r.resp.status}` : `❌ ${r.resp.status} ${r.resp.errorCode || ''}`
    const anthroStatus = r.anthro.ok ? `✅ ${r.anthro.status}` : `❌ ${r.anthro.status} ${r.anthro.errorCode || ''}`

    console.log(
      `${pad(r.model, 28)} ${pad(ccStatus, 14)} ${pad(respStatus, 14)} ${pad(anthroStatus, 14)}`,
    )
  }

  // ── JSON output ────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(80)}`)
  console.log('  DETAILED RESULTS (JSON)')
  console.log(`${'='.repeat(80)}\n`)

  for (const r of results) {
    console.log(`── ${r.model} ──`)
    console.log(`  CC:     ${JSON.stringify(r.cc)}`)
    console.log(`  Resp:   ${JSON.stringify(r.resp)}`)
    console.log(`  Anthro: ${JSON.stringify(r.anthro)}`)
    console.log()
  }

  // ── Architecture implications ──────────────────────────────────────
  console.log(`\n${'='.repeat(80)}`)
  console.log('  ARCHITECTURE IMPLICATIONS')
  console.log(`${'='.repeat(80)}\n`)

  const nativeAnthroModels = results.filter(r => r.anthro.ok)
  const ccOnlyModels = results.filter(r => r.cc.ok && !r.resp.ok && !r.anthro.ok)
  const respOnlyModels = results.filter(r => !r.cc.ok && r.resp.ok && !r.anthro.ok)
  const multiApiModels = results.filter(r => [r.cc.ok, r.resp.ok, r.anthro.ok].filter(Boolean).length > 1)

  console.log(`Models with native Anthropic API support:`)
  for (const r of nativeAnthroModels)
    console.log(`  • ${r.model} (CC=${r.cc.ok}, Resp=${r.resp.ok}, Anthro=${r.anthro.ok})`)

  console.log(`\nModels with CC only:`)
  for (const r of ccOnlyModels)
    console.log(`  • ${r.model}`)

  console.log(`\nModels with Responses only:`)
  for (const r of respOnlyModels)
    console.log(`  • ${r.model}`)

  console.log(`\nModels with multiple API support:`)
  for (const r of multiApiModels) {
    const apis = [
      r.cc.ok && 'CC',
      r.resp.ok && 'Responses',
      r.anthro.ok && 'Anthropic',
    ].filter(Boolean)
    console.log(`  • ${r.model}: ${apis.join(', ')}`)
  }

  // Check if non-Claude models support Anthropic API
  const nonClaudeAnthro = nativeAnthroModels.filter(r => !r.model.startsWith('claude'))
  if (nonClaudeAnthro.length > 0) {
    console.log(`\n⚠️  NON-CLAUDE models supporting Anthropic API:`)
    for (const r of nonClaudeAnthro)
      console.log(`  • ${r.model}`)
  }

  // Check if Claude models support Responses API
  const claudeResp = results.filter(r => r.model.startsWith('claude') && r.resp.ok)
  if (claudeResp.length > 0) {
    console.log(`\n⚠️  Claude models supporting Responses API:`)
    for (const r of claudeResp)
      console.log(`  • ${r.model}`)
  }
}

main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})
