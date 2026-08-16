import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { normalizeChatCompletionContent } from '../src/lib/chat-completions-content'
import { ChatCompletionsPayloadSchema } from '../src/lib/schemas'
import { server } from '~/server'

function textPayload(messages: unknown[]): unknown {
  return { model: 'gpt-test', messages }
}

test('schema accepts a single text content-part object', () => {
  const result = ChatCompletionsPayloadSchema.safeParse(textPayload([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: { type: 'text', text: 'checking' }, tool_calls: [] },
  ]))
  expect(result.success).toBe(true)
})

test('schema still accepts string, array, and null content', () => {
  const result = ChatCompletionsPayloadSchema.safeParse(textPayload([
    { role: 'user', content: 'hi' },
    { role: 'user', content: [{ type: 'text', text: 'multi' }] },
    { role: 'assistant', content: null, tool_calls: [] },
    { role: 'tool', content: '4', tool_call_id: 'c1' },
  ]))
  expect(result.success).toBe(true)
})

test('normalizer converts a text object to a plain string', () => {
  const out = normalizeChatCompletionContent({
    model: 'gpt-test',
    messages: [
      { role: 'assistant', content: { type: 'text', text: 'checking' } as never, tool_calls: [] },
    ],
  })
  expect(out.messages[0]!.content).toBe('checking')
})

test('normalizer wraps a non-text object content part in an array', () => {
  const objectContent = { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } }
  const out = normalizeChatCompletionContent({
    model: 'gpt-test',
    messages: [{ role: 'user', content: objectContent as never }],
  })
  expect(out.messages[0]!.content).toEqual([objectContent])
})

test('normalizer leaves string, array, and null content unchanged', () => {
  const arrayContent = [{ type: 'text', text: 'multi' }]
  const out = normalizeChatCompletionContent({
    model: 'gpt-test',
    messages: [
      { role: 'user', content: 'plain' },
      { role: 'user', content: arrayContent },
      { role: 'assistant', content: null, tool_calls: [] },
    ],
  })
  expect(out.messages[0]!.content).toBe('plain')
  expect(out.messages[1]!.content).toBe(arrayContent)
  expect(out.messages[2]!.content).toBeNull()
})

// ─── End-to-end: full /chat/completions route with a mocked upstream ───

const originalFetch = globalThis.fetch
let lastUpstreamBody: string | undefined

const fetchMock = mock(async (_url: string, init?: RequestInit): Promise<Response> => {
  lastUpstreamBody = typeof init?.body === 'string' ? init.body : undefined
  return new Response(
    JSON.stringify({
      id: '1',
      object: 'chat.completion',
      model: 'gpt-5.2',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
})

beforeEach(() => {
  fetchMock.mockClear()
  lastUpstreamBody = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  state.models = undefined
  // @ts-expect-error test mock only needs a callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('e2e: object content is normalized and forwarded (no validation 400)', async () => {
  const res = await server.request('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.2',
      messages: [
        { role: 'user', content: 'use tool' },
        {
          role: 'assistant',
          content: { type: 'text', text: 'checking' },
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'add', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: { type: 'text', text: '4' } },
      ],
    }),
  })

  expect(res.status).toBe(200)
  expect(lastUpstreamBody).toBeDefined()
  const upstream = JSON.parse(lastUpstreamBody!) as { messages: Array<{ content: unknown }> }
  // assistant text object -> plain string
  expect(upstream.messages[1]!.content).toBe('checking')
  // tool text object -> plain string
  expect(upstream.messages[2]!.content).toBe('4')
})

test('e2e: before the fix this same payload returned 400 validation error', async () => {
  // Regression guard: a non-text single object must be wrapped in an array and
  // still reach the upstream (proving validation no longer rejects object content).
  const res = await server.request('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.2',
      messages: [
        {
          role: 'user',
          content: { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
        },
      ],
    }),
  })

  expect(res.status).toBe(200)
  const upstream = JSON.parse(lastUpstreamBody!) as { messages: Array<{ content: unknown }> }
  expect(Array.isArray(upstream.messages[0]!.content)).toBe(true)
  expect((upstream.messages[0]!.content as Array<unknown>)[0]).toEqual(
    { type: 'image_url', image_url: { url: 'data:image/png;base64,xx' } },
  )
})
