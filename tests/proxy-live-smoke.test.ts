/**
 * Live smoke tests for the proxy's OpenAI-compatible and auxiliary routes.
 *
 * These tests hit the REAL Copilot backend via the proxy routes:
 * - /v1/chat/completions
 * - /v1/responses
 * - /v1/models
 * - /v1/embeddings
 * - /usage
 * - /token
 *
 * Run:
 *   COPILOT_LIVE_TEST=1 bun test tests/proxy-live-smoke.test.ts --timeout 600000
 *
 * Requires:
 *   valid GitHub auth in ~/.local/share/copilot-proxy/github_token
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { state } from '~/lib/state'
import { setupCopilotToken, setupGitHubToken } from '~/lib/token'
import { cacheModels, cacheVSCodeVersion } from '~/lib/utils'
import { server } from '~/server'

const TIMEOUT = 90_000
const LIVE_TEST_ENABLED = process.env.COPILOT_LIVE_TEST === '1'
const describeLive = LIVE_TEST_ENABLED ? describe : describe.skip

const RESPONSES_MODEL = process.env.COPILOT_LIVE_RESPONSES_MODEL ?? 'gpt-5.4'
const EMBEDDING_MODEL = process.env.COPILOT_LIVE_EMBEDDING_MODEL ?? 'text-embedding-3-small'
const IMAGE_URL
  = process.env.COPILOT_LIVE_IMAGE_URL
    ?? 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png'
const FILE_URL
  = process.env.COPILOT_LIVE_FILE_URL
    ?? 'https://www.berkshirehathaway.com/letters/2024ltr.pdf'

const NOOP_TOOL = {
  type: 'function' as const,
  function: {
    name: 'noop',
    description: 'A no-op tool for smoke testing.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
}

async function sendJsonRequest(
  path: string,
  body?: Record<string, unknown>,
  options?: {
    method?: string
    headers?: Record<string, string>
  },
) {
  return server.request(path, {
    method: options?.method ?? (body ? 'POST' : 'GET'),
    headers: body
      ? { 'Content-Type': 'application/json', ...options?.headers }
      : options?.headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
}

async function parseJson<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>
}

function extractResponsesOutputText(body: Record<string, unknown>): string | undefined {
  const output = Array.isArray(body.output) ? body.output as Array<Record<string, unknown>> : []

  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content)) {
      continue
    }

    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        return part.text
      }
    }
  }

  return undefined
}

function hasResponsesFunctionCall(body: Record<string, unknown>): boolean {
  return Array.isArray(body.output) && body.output.some(item =>
    item && typeof item === 'object' && (item as Record<string, unknown>).type === 'function_call',
  )
}

beforeAll(async () => {
  if (!LIVE_TEST_ENABLED) {
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
  if (!LIVE_TEST_ENABLED) {
    return
  }

  state.copilotToken = undefined
})

describeLive('Proxy live smoke', () => {
  describe('/v1/chat/completions', () => {
    test('baseline text → 200 chat completion', async () => {
      const res = await sendJsonRequest('/v1/chat/completions', {
        model: RESPONSES_MODEL,
        max_tokens: 32,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(body.object).toBe('chat.completion')
      expect(Array.isArray(body.choices)).toBe(true)
    }, TIMEOUT)

    test('streaming → emits chat.completion.chunk and [DONE]', async () => {
      const res = await sendJsonRequest('/v1/chat/completions', {
        model: RESPONSES_MODEL,
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      })

      expect(res.status).toBe(200)
      const raw = await res.text()
      expect(raw).toContain('"object":"chat.completion.chunk"')
      expect(raw).toContain('[DONE]')
    }, TIMEOUT)

    test('image_url input → rejected locally', async () => {
      const res = await sendJsonRequest('/v1/chat/completions', {
        model: RESPONSES_MODEL,
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              {
                type: 'image_url',
                image_url: {
                  url: IMAGE_URL,
                },
              },
            ],
          },
        ],
      })

      expect(res.status).toBe(400)
      const body = await parseJson<Record<string, unknown>>(res)
      const error = body.error as Record<string, unknown>
      expect(error.type).toBe('invalid_request_error')
      expect(String(error.message)).toContain('external image URLs')
    }, TIMEOUT)

    test('tools + tool_choice required → returns tool call', async () => {
      const res = await sendJsonRequest('/v1/chat/completions', {
        model: RESPONSES_MODEL,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Call the noop tool exactly once.' }],
        tools: [NOOP_TOOL],
        tool_choice: 'required',
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      const choices = body.choices as Array<Record<string, unknown>>
      const message = choices[0].message as Record<string, unknown>
      expect(Array.isArray(message.tool_calls)).toBe(true)
      expect((choices[0].finish_reason as string)).toBe('tool_calls')
    }, TIMEOUT)

    test('response_format json_object → returns valid JSON string', async () => {
      const res = await sendJsonRequest('/v1/chat/completions', {
        model: RESPONSES_MODEL,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'Return a JSON object with ok=true.' }],
        response_format: { type: 'json_object' },
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      const choices = body.choices as Array<Record<string, unknown>>
      const message = choices[0].message as Record<string, unknown>
      expect(() => JSON.parse(String(message.content))).not.toThrow()
    }, TIMEOUT)

    test('response_format json_schema → returns schema-valid JSON string', async () => {
      const res = await sendJsonRequest('/v1/chat/completions', {
        model: RESPONSES_MODEL,
        max_tokens: 128,
        messages: [{ role: 'user', content: 'What is 2+2? Return JSON with answer as a string.' }],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'math_answer',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                answer: { type: 'string' },
              },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      const choices = body.choices as Array<Record<string, unknown>>
      const message = choices[0].message as Record<string, unknown>
      expect(JSON.parse(String(message.content))).toEqual({ answer: '4' })
    }, TIMEOUT)
  })

  describe('/v1/responses', () => {
    test('baseline text → 200 response object', async () => {
      const res = await sendJsonRequest('/v1/responses', {
        model: RESPONSES_MODEL,
        input: 'Reply with the single word OK.',
        max_output_tokens: 32,
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(body.object).toBe('response')
      expect(body.status).toBe('completed')
      expect(typeof extractResponsesOutputText(body)).toBe('string')
    }, TIMEOUT)

    test('streaming → emits response.created and response.completed', async () => {
      const res = await sendJsonRequest('/v1/responses', {
        model: RESPONSES_MODEL,
        input: 'Say hello.',
        stream: true,
        max_output_tokens: 64,
      })

      expect(res.status).toBe(200)
      const raw = await res.text()
      expect(raw).toContain('event: response.created')
      expect(raw).toContain('event: response.completed')
    }, TIMEOUT)

    test('text.format json_object → returns valid JSON string', async () => {
      const res = await sendJsonRequest('/v1/responses', {
        model: RESPONSES_MODEL,
        input: 'Return a JSON object with ok=true.',
        max_output_tokens: 128,
        text: {
          format: {
            type: 'json_object',
          },
        },
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(() => JSON.parse(String(extractResponsesOutputText(body)))).not.toThrow()
    }, TIMEOUT)

    test('text.format json_schema → returns schema-valid JSON string', async () => {
      const res = await sendJsonRequest('/v1/responses', {
        model: RESPONSES_MODEL,
        input: 'What is 2+2? Return JSON with answer as a string.',
        max_output_tokens: 128,
        text: {
          format: {
            type: 'json_schema',
            name: 'math_answer',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                answer: { type: 'string' },
              },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(JSON.parse(String(extractResponsesOutputText(body)))).toEqual({ answer: '4' })
    }, TIMEOUT)

    test('input_image URL → rejected locally', async () => {
      const res = await sendJsonRequest('/v1/responses', {
        model: RESPONSES_MODEL,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Reply with the single word image if readable.' },
              { type: 'input_image', image_url: IMAGE_URL },
            ],
          },
        ],
        max_output_tokens: 64,
      })

      expect(res.status).toBe(400)
      const body = await parseJson<Record<string, unknown>>(res)
      const error = body.error as Record<string, unknown>
      expect(error.type).toBe('invalid_request_error')
      expect(String(error.message)).toContain('external image URLs')
    }, TIMEOUT)

    test('input_file URL → 200', async () => {
      const res = await sendJsonRequest('/v1/responses', {
        model: RESPONSES_MODEL,
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Reply with yes if you can read this file.' },
              { type: 'input_file', file_url: FILE_URL },
            ],
          },
        ],
        max_output_tokens: 256,
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(body.status).toBe('completed')
      expect(Array.isArray(body.output)).toBe(true)
      expect((body.output as Array<unknown>).length).toBeGreaterThan(0)
    }, TIMEOUT)

    test('tools + tool_choice required → returns function_call item', async () => {
      const res = await sendJsonRequest('/v1/responses', {
        model: RESPONSES_MODEL,
        input: 'Call the noop tool exactly once.',
        max_output_tokens: 64,
        tools: [
          {
            type: 'function',
            name: 'noop',
            description: 'A no-op tool for smoke testing.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        ],
        tool_choice: 'required',
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(hasResponsesFunctionCall(body)).toBe(true)
    }, TIMEOUT)

    test('reasoning.effort high → 200', async () => {
      const res = await sendJsonRequest('/v1/responses', {
        model: RESPONSES_MODEL,
        input: 'Reply with the single word OK.',
        max_output_tokens: 32,
        reasoning: {
          effort: 'high',
        },
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(body.status).toBe('completed')
    }, TIMEOUT)
  })

  describe('Auxiliary routes', () => {
    test('/v1/models → returns non-empty list', async () => {
      const res = await sendJsonRequest('/v1/models', undefined, { method: 'GET' })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      const models = body.data as Array<Record<string, unknown>>
      expect(Array.isArray(models)).toBe(true)
      expect(models.length).toBeGreaterThan(0)
      expect(models.some(model => model.id === RESPONSES_MODEL)).toBe(true)
    }, TIMEOUT)

    test('/v1/embeddings → returns embedding vector', async () => {
      const res = await sendJsonRequest('/v1/embeddings', {
        model: EMBEDDING_MODEL,
        input: 'hello world',
      })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      const data = body.data as Array<Record<string, unknown>>
      expect(Array.isArray(data)).toBe(true)
      expect(Array.isArray(data[0].embedding)).toBe(true)
      expect((data[0].embedding as Array<unknown>).length).toBeGreaterThan(0)
    }, TIMEOUT)

    test('/token → returns current Copilot token', async () => {
      const res = await sendJsonRequest('/token', undefined, { method: 'GET' })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(body.token).toBe(state.copilotToken)
    }, TIMEOUT)

    test('/usage → returns Copilot usage payload', async () => {
      const res = await sendJsonRequest('/usage', undefined, { method: 'GET' })

      expect(res.status).toBe(200)
      const body = await parseJson<Record<string, unknown>>(res)
      expect(typeof body.copilot_plan).toBe('string')
      expect(typeof body.access_type_sku).toBe('string')
    }, TIMEOUT)
  })
})
