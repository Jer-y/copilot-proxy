import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const fetchMock = mock(async (url: string, init?: RequestInit) => {
  if (url.endsWith('/responses')) {
    return new Response(JSON.stringify({
      id: 'resp_test',
      object: 'response',
      model: 'gpt-5.4',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }],
      }],
      status: 'completed',
      error: null,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const forwardedPayload = init?.body
    ? JSON.parse(String(init.body)) as { stream?: boolean }
    : {}

  if (forwardedPayload.stream) {
    return new Response([
      'event: message_start\n',
      'data: {"type":"message_start","message":{"id":"msg_test_stream","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ].join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  return new Response(JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 1 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

beforeEach(() => {
  fetchMock.mockClear()
  state.lastRequestTimestamp = undefined
  state.copilotToken = undefined
  state.models = undefined
  globalThis.fetch = originalFetch
})

describe('messages error paths', () => {
  test('invalid JSON body returns 400 with invalid_request_error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '<<<not json>>>',
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('missing "model" field returns 400', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 100 }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('count_tokens without Copilot token returns an Anthropic error', async () => {
    const res = await server.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(500)
    const json = await res.json() as {
      type: string
      error: { type: string, message: string }
    }
    expect(json.type).toBe('error')
    expect(json.error.type).toBe('api_error')
    expect(json.error.message).toContain('Copilot token not found')
  })

  test('missing "max_tokens" field is accepted by schema for compatibility', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(result.success).toBe(true)
  })

  test('assistant thinking blocks with signatures are accepted by schema', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'claude-opus-4.6',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'internal reasoning',
              signature: 'sig_123',
            },
            { type: 'text', text: 'visible answer' },
          ],
        },
      ],
    })

    expect(result.success).toBe(true)
  })

  test('assistant server tool blocks are accepted for native pause_turn replay', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'claude-opus-4.8',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'Research and run the example.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'web_fetch',
              input: { url: 'https://example.com' },
            },
            {
              type: 'web_fetch_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: { type: 'web_fetch_result', url: 'https://example.com' },
            },
            {
              type: 'code_execution_tool_result',
              tool_use_id: 'srvtoolu_2',
              content: { stdout: 'ok', stderr: '' },
            },
          ],
        },
        { role: 'user', content: 'Continue.' },
      ],
    })

    expect(result.success).toBe(true)
  })

  test('server block fallback does not accept malformed standard assistant blocks', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'claude-opus-4.8',
      max_tokens: 100,
      messages: [{ role: 'assistant', content: [{ type: 'text' }] }],
    })

    expect(result.success).toBe(false)
  })

  test('server block fallback does not accept malformed server_tool_use blocks', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'claude-opus-4.8',
      max_tokens: 100,
      messages: [{ role: 'assistant', content: [{ type: 'server_tool_use' }] }],
    })

    expect(result.success).toBe(false)
  })

  test('output_config.effort xhigh is accepted for Copilot Claude compatibility', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'claude-opus-4-7',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      output_config: { effort: 'xhigh' },
    })

    expect(result.success).toBe(true)
  })

  test('mid-conversation system messages are accepted by schema', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'claude-opus-4-8',
      max_tokens: 100,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'Use the Skill tool when needed.' },
      ],
    })

    expect(result.success).toBe(true)
  })

  test('tool_use and tool_result cache_control are accepted and preserved by schema', () => {
    const result = AnthropicMessagesPayloadSchema.parse({
      model: 'claude-opus-4.7',
      max_tokens: 100,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_cache',
              name: 'lookup',
              input: { query: 'docs' },
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_cache',
              content: 'result',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    }) as {
      messages: Array<{
        content: Array<{ cache_control?: { type: string } }>
      }>
    }

    expect(result.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  test('typed custom tools still require input_schema', () => {
    const result = AnthropicMessagesPayloadSchema.safeParse({
      model: 'gpt-5.4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'custom', name: 'broken' }],
    })

    expect(result.success).toBe(false)
  })

  test('invalid thinking.budget_tokens type returns 400', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: {
          type: 'enabled',
          budget_tokens: 'oops',
        },
      }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as {
      type: string
      error: { type: string, message: string }
    }
    expect(json.type).toBe('error')
    expect(json.error.type).toBe('invalid_request_error')
    expect(json.error.message).toContain('thinking.budget_tokens')
  })

  test('adaptive thinking with budget_tokens is rejected locally', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
        thinking: {
          type: 'adaptive',
          budget_tokens: 4096,
        },
      }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as {
      type: string
      error: { type: string, message: string }
    }
    expect(json.type).toBe('error')
    expect(json.error.type).toBe('invalid_request_error')
    expect(json.error.message).toContain('thinking.adaptive.budget_tokens')
  })

  test('adaptive thinking with budget_tokens is rejected before translated backend routing', async () => {
    state.copilotToken = 'test-token'
    // @ts-expect-error test mock only needs fetch callable shape
    globalThis.fetch = fetchMock

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 100,
        thinking: {
          type: 'adaptive',
          budget_tokens: 4096,
        },
        output_config: {
          format: { type: 'json_object' },
        },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(0)

    const json = await res.json() as {
      type: string
      error: { type: string, message: string }
    }
    expect(json.type).toBe('error')
    expect(json.error.type).toBe('invalid_request_error')
    expect(json.error.message).toContain('thinking.adaptive.budget_tokens')
  })

  test('missing "max_tokens" is backfilled from model limits before forwarding', async () => {
    state.copilotToken = 'test-token'
    state.vsCodeVersion = '1.0.0'
    state.accountType = 'individual'
    state.models = {
      data: [{
        id: 'claude-sonnet-4',
        capabilities: {
          limits: {
            max_output_tokens: 8192,
          },
        },
      }],
    } as typeof state.models

    // @ts-expect-error test mock only needs fetch callable shape
    globalThis.fetch = fetchMock

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const forwardedPayload = JSON.parse(String(init?.body)) as { max_tokens?: number }
    expect(forwardedPayload.max_tokens).toBe(8192)
  })

  test('max_tokens above model limits are clamped before forwarding', async () => {
    state.copilotToken = 'test-token'
    state.vsCodeVersion = '1.0.0'
    state.accountType = 'individual'
    state.models = {
      data: [{
        id: 'claude-sonnet-4',
        capabilities: {
          limits: {
            max_output_tokens: 8192,
          },
        },
      }],
    } as typeof state.models

    // @ts-expect-error test mock only needs fetch callable shape
    globalThis.fetch = fetchMock

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        max_tokens: 16000,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const forwardedPayload = JSON.parse(String(init?.body)) as { max_tokens?: number }
    expect(forwardedPayload.max_tokens).toBe(8192)
  })

  test('gpt-5.4 anthropic requests without "max_tokens" are backfilled and routed to /responses', async () => {
    state.copilotToken = 'test-token'
    state.vsCodeVersion = '1.0.0'
    state.accountType = 'individual'
    state.models = {
      data: [{
        id: 'gpt-5.4',
        capabilities: {
          limits: {
            max_output_tokens: 8192,
          },
        },
      }],
    } as typeof state.models

    // @ts-expect-error test mock only needs fetch callable shape
    globalThis.fetch = fetchMock

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/responses')

    const forwardedPayload = JSON.parse(String(init?.body)) as { max_output_tokens?: number, model?: string }
    expect(forwardedPayload.model).toBe('gpt-5.4')
    expect(forwardedPayload.max_output_tokens).toBe(8192)
  })

  test('missing "messages" field returns 400', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4', max_tokens: 100 }),
    })

    expect(res.status).toBe(400)
    const json = await res.json() as { error: { type: string } }
    expect(json.error.type).toBe('invalid_request_error')
  })

  test('rate limit exceeded returns 429', async () => {
    const origRateLimitSeconds = state.rateLimitSeconds
    const origRateLimitWait = state.rateLimitWait
    const origLastRequestTimestamp = state.lastRequestTimestamp

    try {
      state.rateLimitSeconds = 9999
      state.rateLimitWait = false
      state.lastRequestTimestamp = undefined

      // First request: passes rate limit check and fails at JSON parsing.
      // This keeps the test fully local (no upstream network call).
      const first = await server.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '<<<not json>>>',
      })
      expect(first.status).toBe(400)

      // Second request: checkRateLimit sees the recent timestamp and
      // throws HTTPError(429) because rateLimitWait is false.
      const res = await server.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '<<<not json>>>',
      })

      expect(res.status).toBe(429)
    }
    finally {
      state.rateLimitSeconds = origRateLimitSeconds
      state.rateLimitWait = origRateLimitWait
      state.lastRequestTimestamp = origLastRequestTimestamp
    }
  })
})
