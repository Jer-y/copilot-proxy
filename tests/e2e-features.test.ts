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
const E2E_TEST_ENABLED = process.env.COPILOT_LIVE_TEST === '1'
const describeE2E = E2E_TEST_ENABLED ? describe : describe.skip

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
  if (!E2E_TEST_ENABLED) {
    return
  }

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
  if (!E2E_TEST_ENABLED) {
    return
  }

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

describeE2E('Claude Sonnet 4.6', () => {
  defineModelTests('claude-sonnet-4.6')
})

describeE2E('Claude Opus 4.6', () => {
  defineModelTests('claude-opus-4.6')
})

// ======================================================================
// Feature probes — edge cases and features that need special handling
// ======================================================================

describeE2E('Feature probes', () => {
  const model = 'claude-sonnet-4.6'

  describe('Official Anthropic contract validation', () => {
    // Tests here MUST have expect() assertions proving official API correctness
    // These are not Copilot-specific — they validate the native Claude API contract

    test('thinking adaptive + budget_tokens → rejected (budget_tokens only for enabled)', async () => {
      // Per Claude API docs: budget_tokens is ONLY valid with type:"enabled".
      // budget_tokens_max is not part of the official adaptive thinking shape;
      // the proxy strips it for compatibility. See A2 in the review plan.
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

    test('thinking adaptive + display omitted → 200 with thinking block', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive', display: 'omitted' },
        messages: [{ role: 'user', content: 'What is 2+2?' }],
      })
      expect(res.status).toBe(200)
      const body = await parseResponse(res)
      expect((body as any).content.some((b: any) => b.type === 'thinking')).toBe(true)
    }, TIMEOUT)

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

    test('json_schema structured output → 200 with valid JSON response', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 1024,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                answer: { type: 'string' },
              },
              required: ['answer'],
            },
          },
        },
        messages: [{ role: 'user', content: 'What is 2+2? Return answer as a string.' }],
      })
      expect(res.status).toBe(200)
      const body = await parseResponse(res)
      const textBlock = (body as any).content.find((b: any) => b.type === 'text')
      expect(textBlock).toBeDefined()
      expect(() => JSON.parse(textBlock.text)).not.toThrow()
    }, TIMEOUT)

    test('document source text → 200', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 128,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', text: 'The capital of France is Paris.' },
            },
            { type: 'text', text: 'What is the capital mentioned in the document?' },
          ],
        }],
      })
      expect(res.status).toBe(200)
    }, TIMEOUT)

    test('document source content → 200', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 128,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'content',
                content: [{ type: 'text', text: 'The speed of light is approximately 300,000 km/s.' }],
              },
            },
            { type: 'text', text: 'What speed is mentioned in the document?' },
          ],
        }],
      })
      expect(res.status).toBe(200)
    }, TIMEOUT)

    test('document source URL with real PDF → 200', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 128,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'url', url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' },
            },
            { type: 'text', text: 'Is there any text in this PDF document? Reply with yes or no.' },
          ],
        }],
      })
      expect(res.status).toBe(200)
    }, TIMEOUT)

    test('document citations → 200 with citations in response', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'text', media_type: 'text/plain', text: 'The capital of France is Paris. The Eiffel Tower is located in Paris.' },
              citations: { enabled: true },
            },
            { type: 'text', text: 'What is the capital of France? Cite your source.' },
          ],
        }],
      })
      expect(res.status).toBe(200)
      const body = await parseResponse(res)
      // At least one text block should have a citations array
      const hasCitations = (body as any).content.some((b: any) => b.type === 'text' && Array.isArray(b.citations) && b.citations.length > 0)
      expect(hasCitations).toBe(true)
    }, TIMEOUT)

    test('top-level cache_control → 200', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 32,
        cache_control: { type: 'ephemeral' },
        messages: [{ role: 'user', content: 'Say hi' }],
      })
      expect(res.status).toBe(200)
    }, TIMEOUT)
  })

  describe('Copilot upstream compatibility probes', () => {
    // Tests here use logProbe() to record upstream behavior
    // They may or may not have expect() assertions — exploratory by nature

    test('thinking adaptive + budget_tokens_max → stripped by proxy (Copilot upstream probe)', async () => {
      // budget_tokens_max is not part of the official adaptive thinking shape;
      // the proxy strips it for compatibility. See A2 in the review plan.
      const res = await sendRequest({
        model,
        max_tokens: 16000,
        thinking: { type: 'adaptive', budget_tokens_max: 8000 },
        messages: [{ role: 'user', content: 'What is 2+2?' }],
      })
      const body = await parseResponse(res)
      logProbe('thinking adaptive + budget_tokens_max', res.status, body)
    }, TIMEOUT)

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

    test('service_tier auto', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 32,
        service_tier: 'auto',
        messages: [{ role: 'user', content: 'Say hi' }],
      })
      const body = await parseResponse(res)
      logProbe('service_tier auto', res.status, body)
      expect(res.status).toBe(200)
    }, TIMEOUT)

    test('speed fast', async () => {
      const res = await sendRequest({
        model,
        max_tokens: 32,
        speed: 'fast',
        messages: [{ role: 'user', content: 'Say hi' }],
      })
      const body = await parseResponse(res)
      logProbe('speed fast', res.status, body)
      expect(res.status).toBe(200)
    }, TIMEOUT)
  })
})
