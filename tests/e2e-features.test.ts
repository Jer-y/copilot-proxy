/**
 * E2E feature tests for native Anthropic passthrough.
 *
 * These tests hit the REAL Copilot backend via the proxy's native
 * /v1/messages path. They verify which Claude features are supported
 * by the Copilot API when passed through without translation.
 *
 * Run: bun test tests/e2e-features.test.ts --timeout 30000
 * Requires: valid GitHub Copilot token (~/.local/share/copilot-proxy/github_token)
 *
 * Last validated: 2026-04-09
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import consola from 'consola'

import { state } from '~/lib/state'
import { setupCopilotToken, setupGitHubToken } from '~/lib/token'
import { cacheModels, cacheVSCodeVersion } from '~/lib/utils'
import { server } from '~/server'

const TIMEOUT = 30_000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sendRequest(body: Record<string, unknown>, headers?: Record<string, string>) {
  return server.request('/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function parseResponse(res: Response) {
  return res.json() as Promise<Record<string, unknown>>
}

async function collectStreamEvents(res: Response) {
  const text = await res.text()
  const events: Array<{ event: string, data: Record<string, unknown> }> = []
  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      events.push({ event: line.slice(7), data: {} })
    }
    if (line.startsWith('data: ') && events.length > 0) {
      try {
        events[events.length - 1].data = JSON.parse(line.slice(6))
      }
      catch {}
    }
  }
  return { events, raw: text }
}

/** Log probe result without hard assertion — for feature discovery */
function logProbe(name: string, status: number, body?: Record<string, unknown>) {
  const icon = status === 200 ? '✅' : '❌'
  const detail = status !== 200 && body ? ` — ${(body.error as Record<string, unknown>)?.message ?? JSON.stringify(body).slice(0, 150)}` : ''
  consola.info(`  ${icon} ${name}: ${status}${detail}`)
}

// Shared tool definition
const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get weather for a location',
  input_schema: {
    type: 'object',
    properties: { location: { type: 'string' } },
    required: ['location'],
  },
}

// ---------------------------------------------------------------------------
// Setup: initialize real Copilot auth
// ---------------------------------------------------------------------------

beforeAll(async () => {
  state.accountType = 'enterprise'
  await cacheVSCodeVersion()
  await setupGitHubToken()
  await setupCopilotToken()
  await cacheModels()

  if (!state.copilotToken) {
    throw new Error('Failed to obtain Copilot token. Ensure GitHub auth is configured.')
  }
}, TIMEOUT)

afterAll(() => {
  state.copilotToken = undefined
})

// ======================================================================
// Shared test suite — run identical tests on both Sonnet 4.6 and Opus 4.6
// ======================================================================

function defineModelTests(model: string) {
  test('baseline — simple request', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    expect(res.status).toBe(200)
    const body = await parseResponse(res)
    expect(body.type).toBe('message')
    expect(body.role).toBe('assistant')
  }, TIMEOUT)

  test('cache_control — system + message level ephemeral', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      system: [
        { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Say hi', cache_control: { type: 'ephemeral' } },
        ],
      }],
    })
    expect(res.status).toBe(200)
    const body = await parseResponse(res)
    expect(body.type).toBe('message')
  }, TIMEOUT)

  test('output_config — effort low', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    expect(res.status).toBe(200)
  }, TIMEOUT)

  test('thinking adaptive — no budget', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    })
    expect(res.status).toBe(200)
  }, TIMEOUT)

  test('thinking enabled + budget_tokens', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 8000,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [{ role: 'user', content: 'What is 2+2? Think step by step.' }],
    })
    expect(res.status).toBe(200)
    const body = await parseResponse(res)
    const content = body.content as Array<Record<string, unknown>>
    const hasThinking = content?.some(b => b.type === 'thinking')
    consola.info(`  → thinking blocks in response: ${hasThinking}`)
    expect(hasThinking).toBe(true)
  }, TIMEOUT)

  test('metadata — user_id', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      metadata: { user_id: 'e2e-test' },
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    expect(res.status).toBe(200)
  }, TIMEOUT)

  test('streaming — full SSE event chain', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    expect(res.status).toBe(200)
    const { events } = await collectStreamEvents(res)
    const types = events.map(e => e.event)
    expect(types).toContain('message_start')
    expect(types).toContain('content_block_start')
    expect(types).toContain('content_block_delta')
    expect(types).toContain('content_block_stop')
    expect(types).toContain('message_delta')
    expect(types).toContain('message_stop')
  }, TIMEOUT)

  test('streaming + thinking — thinking events in stream', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 8000,
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [{ role: 'user', content: 'What is 17 * 23? Think step by step.' }],
    })
    expect(res.status).toBe(200)
    const { raw } = await collectStreamEvents(res)
    const hasThinkingBlock = raw.includes('"type":"thinking"')
    const hasThinkingDelta = raw.includes('thinking_delta')
    consola.info(`  → thinking stream: block=${hasThinkingBlock}, delta=${hasThinkingDelta}`)
    expect(hasThinkingDelta).toBe(true)
  }, TIMEOUT)

  test('tool_choice auto', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 128,
      tool_choice: { type: 'auto' },
      tools: [WEATHER_TOOL],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    })
    expect(res.status).toBe(200)
  }, TIMEOUT)

  test('tool_choice specific tool', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 128,
      tool_choice: { type: 'tool', name: 'get_weather' },
      tools: [WEATHER_TOOL],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    })
    expect(res.status).toBe(200)
    const body = await parseResponse(res)
    const content = body.content as Array<Record<string, unknown>>
    expect(content?.some(b => b.type === 'tool_use')).toBe(true)
  }, TIMEOUT)

  test('top_k', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      top_k: 40,
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    expect(res.status).toBe(200)
  }, TIMEOUT)

  test('stop_sequences', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 64,
      stop_sequences: ['STOP'],
      messages: [{ role: 'user', content: 'Count from 1 to 10, say STOP after 5' }],
    })
    expect(res.status).toBe(200)
  }, TIMEOUT)

  test('temperature', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      temperature: 0.1,
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    expect(res.status).toBe(200)
  }, TIMEOUT)
}

describe('Claude Sonnet 4.6', () => {
  defineModelTests('claude-sonnet-4.6')
})

describe('Claude Opus 4.6', () => {
  defineModelTests('claude-opus-4.6')
})

// ======================================================================
// Feature probes — edge cases and features that need special handling
// ======================================================================

describe('Feature probes', () => {
  const model = 'claude-sonnet-4.6'

  // --- thinking edge cases ---

  test('thinking adaptive + budget_tokens → rejected (budget_tokens only for enabled)', async () => {
    // Per Claude API docs: budget_tokens is ONLY valid with type:"enabled".
    // With type:"adaptive", use budget_tokens_max instead.
    const res = await sendRequest({
      model,
      max_tokens: 8000,
      thinking: { type: 'adaptive', budget_tokens: 5000 },
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    })
    const body = await parseResponse(res)
    logProbe('thinking adaptive + budget_tokens (invalid combo)', res.status, body)
    expect(res.status).toBe(400)
  }, TIMEOUT)

  test('thinking adaptive + budget_tokens_max → should work', async () => {
    // budget_tokens_max is the correct field for adaptive thinking
    const res = await sendRequest({
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive', budget_tokens_max: 8000 },
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    })
    const body = await parseResponse(res)
    logProbe('thinking adaptive + budget_tokens_max', res.status, body)
  }, TIMEOUT)

  // --- defer_loading ---

  test('defer_loading — mixed (one deferred + one non-deferred) → should work', async () => {
    // Per API docs: at least one tool must have defer_loading=false
    const res = await sendRequest({
      model,
      max_tokens: 128,
      tools: [
        { ...WEATHER_TOOL, defer_loading: true },
        {
          name: 'get_time',
          description: 'Get current time',
          input_schema: { type: 'object', properties: { tz: { type: 'string' } }, required: ['tz'] },
          // defer_loading defaults to false
        },
      ],
      messages: [{ role: 'user', content: 'What is the weather and time in Tokyo?' }],
    })
    const body = await parseResponse(res)
    logProbe('defer_loading (mixed)', res.status, body)
  }, TIMEOUT)

  test('defer_loading — all deferred → rejected', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 128,
      tools: [{ ...WEATHER_TOOL, defer_loading: true }],
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
    })
    const body = await parseResponse(res)
    logProbe('defer_loading (all deferred)', res.status, body)
    expect(res.status).toBe(400)
  }, TIMEOUT)

  // --- context_management ---

  test('context_management without beta flag → rejected', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      context_management: { enabled: true },
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    const body = await parseResponse(res)
    logProbe('context_management (no beta flag)', res.status, body)
  }, TIMEOUT)

  test('context_management with beta flag → probe', async () => {
    // context_management may require the beta flag in anthropic-beta header
    const res = await sendRequest({
      model,
      max_tokens: 32,
      context_management: { enabled: true },
      messages: [{ role: 'user', content: 'Say hi' }],
    }, {
      'anthropic-beta': 'context-management-2025-06-27',
    })
    const body = await parseResponse(res)
    logProbe('context_management (with beta flag)', res.status, body)
  }, TIMEOUT)

  // --- disable_parallel_tool_use ---

  test('disable_parallel_tool_use', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 128,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      tools: [
        WEATHER_TOOL,
        {
          name: 'get_time',
          description: 'Get current time in a timezone',
          input_schema: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] },
        },
      ],
      messages: [{ role: 'user', content: 'What is the weather and time in Tokyo?' }],
    })
    expect(res.status).toBe(200)
  }, TIMEOUT)

  // --- service_tier ---

  test('service_tier auto', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      service_tier: 'auto',
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    const body = await parseResponse(res)
    logProbe('service_tier auto', res.status, body)
  }, TIMEOUT)

  // --- speed fast ---

  test('speed fast', async () => {
    const res = await sendRequest({
      model,
      max_tokens: 32,
      speed: 'fast',
      messages: [{ role: 'user', content: 'Say hi' }],
    })
    const body = await parseResponse(res)
    logProbe('speed fast', res.status, body)
  }, TIMEOUT)
})
