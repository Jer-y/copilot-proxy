import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch

async function defaultFetchMock(url: string, init?: RequestInit) {
  if (url.endsWith('/responses')) {
    return new Response(JSON.stringify({
      id: 'resp_route_test',
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

  if (url.endsWith('/v1/messages/count_tokens')) {
    return new Response(JSON.stringify({
      input_tokens: 26,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Native Anthropic passthrough for Claude models
  if (url.endsWith('/v1/messages')) {
    const forwardedPayload = init?.body
      ? JSON.parse(String(init.body)) as { stream?: boolean, model?: string }
      : {}

    if (forwardedPayload.stream) {
      return new Response([
        'event: message_start\n',
        `data: {"type":"message_start","message":{"id":"msg_route_stream","type":"message","role":"assistant","content":[],"model":"${forwardedPayload.model ?? 'claude-opus-4.6'}","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n`,
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\n',
        'data: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\n',
        `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n`,
        'event: message_stop\n',
        'data: {"type":"message_stop"}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    return new Response(JSON.stringify({
      id: 'msg_route_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok', citations: [{ type: 'char_location', cited_text: 'test', document_index: 0, start_char_index: 0, end_char_index: 4 }] }],
      model: forwardedPayload.model ?? 'claude-opus-4.6',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (url.endsWith('/chat/completions')) {
    const forwardedPayload = init?.body
      ? JSON.parse(String(init.body)) as { stream?: boolean }
      : {}

    if (forwardedPayload.stream) {
      return new Response([
        'data: {"id":"chatcmpl_route_stream","object":"chat.completion.chunk","created":0,"model":"claude-opus-4.6","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\n',
        'data: [DONE]\n\n',
      ].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    }

    return new Response(JSON.stringify({
      id: 'chatcmpl_route_test',
      object: 'chat.completion',
      created: 0,
      model: 'claude-opus-4.6',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'ok',
        },
        logprobs: null,
        finish_reason: 'stop',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  throw new Error(`Unexpected upstream URL: ${url} body=${String(init?.body)}`)
}

const fetchMock = mock(defaultFetchMock)

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(defaultFetchMock)
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  state.models = undefined
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

describe('messages route upstream adaptation', () => {
  test('Claude json_object requests are forwarded natively (proxy no longer translates to chat-completions)', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (!url.endsWith('/v1/messages')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'output_config.format json_object: not supported',
        },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Return JSON.' }],
        output_config: { format: { type: 'json_object' } },
      }),
    })

    // Native upstream is allowed to surface its own rejection. The proxy no
    // longer fabricates a chat-completions fallback for unsupported features.
    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')
  })

  test('Responses-backed json_object requests are forwarded to /responses with text.format', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Return JSON.' }],
        output_config: {
          format: {
            type: 'json_object',
          },
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/responses')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      text?: { format?: { type?: string } }
      model?: string
    }

    expect(forwardedPayload.model).toBe('gpt-5.4')
    expect(forwardedPayload.text).toEqual({ format: { type: 'json_object' } })
  })

  test('Claude json_schema requests are routed natively so unsupported output_config.format is not falsely treated as supported', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Return JSON.' }],
        output_config: {
          format: {
            type: 'json_schema',
            name: 'sample',
            strict: true,
            json_schema: {
              name: 'sample',
              schema: {
                type: 'object',
                properties: { answer: { type: 'string' } },
                required: ['answer'],
              },
            },
          },
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      output_config?: { format?: { type?: string, schema?: unknown, name?: string, strict?: boolean } }
      model?: string
    }

    expect(forwardedPayload.model).toBe('claude-opus-4.6')
    expect(forwardedPayload.output_config).toEqual({
      format: {
        type: 'json_schema',
        name: 'sample',
        strict: true,
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
    })
  })

  test('Claude json_schema native rejection is not retried through chat-completions', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/messages')) {
        return new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'output_config.format: Extra inputs are not permitted',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({
          id: 'chatcmpl_false_success',
          object: 'chat.completion',
          created: 0,
          model: 'claude-opus-4.6',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: '4' },
            logprobs: null,
            finish_reason: 'stop',
          }],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected upstream URL: ${url} body=${String(init?.body)}`)
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'What is 2+2? Return answer.' }],
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const body = await res.json() as { error?: { message?: string } }
    expect(body.error?.message).toContain('output_config.format')
  })

  test('Claude non-streaming requests are forwarded natively and return Anthropic JSON directly', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)

    const body = await res.json() as {
      type?: string
      content?: Array<Record<string, unknown>>
      usage?: {
        input_tokens?: number
        output_tokens?: number
      }
    }

    // Native passthrough returns Anthropic format directly
    expect(body.type).toBe('message')
    expect(body.content).toEqual([{ type: 'text', text: 'ok', citations: [{ type: 'char_location', cited_text: 'test', document_index: 0, start_char_index: 0, end_char_index: 4 }] }])
    expect(body.usage?.input_tokens).toBe(5)
    expect(body.usage?.output_tokens).toBe(1)
  })

  test('Claude non-streaming responses normalize dated model names without fast variant routing', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'fast-mode-2026-02-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6-20250514',
        speed: 'fast',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const forwardedPayload = JSON.parse(String(init?.body)) as { model?: string }
    expect(forwardedPayload.model).toBe('claude-opus-4.6')

    const headers = init.headers as Record<string, string>
    expect(headers['anthropic-beta']).toBe('fast-mode-2026-02-01')

    const body = await res.json() as { model?: string }
    expect(body.model).toBe('claude-opus-4-6-20250514')
  })

  test('Claude Opus 4.7 context beta keeps normalized base upstream model', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'context-1m-2025-08-07',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const forwardedPayload = JSON.parse(String(init?.body)) as { model?: string }
    expect(forwardedPayload.model).toBe('claude-opus-4.7')

    const body = await res.json() as { model?: string }
    expect(body.model).toBe('claude-opus-4-7')
  })

  test('Claude Opus 4.7 strips advisor beta while forwarding context beta', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'context-1m-2025-08-07, advisor-tool-2026-03-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 64,
        tools: [
          {
            type: 'advisor_20260301',
            name: 'advisor',
            model: 'claude-opus-4-7',
          },
          {
            name: 'noop',
            input_schema: { type: 'object', properties: {} },
          },
        ],
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      model?: string
      tools?: Array<{ name?: string, type?: string, input_schema?: unknown }>
    }
    expect(forwardedPayload.model).toBe('claude-opus-4.7')
    expect(forwardedPayload.tools).toEqual([
      {
        name: 'noop',
        input_schema: { type: 'object', properties: {} },
      },
    ])

    const headers = init.headers as Record<string, string>
    expect(headers['anthropic-beta']).toBe('context-1m-2025-08-07')
  })

  test('Claude Opus 4.7 context beta forwards xhigh effort to native upstream model', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'context-1m-2025-08-07',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 64,
        output_config: { effort: 'xhigh' },
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const forwardedPayload = JSON.parse(String(init?.body)) as {
      model?: string
      output_config?: { effort?: string }
    }
    expect(forwardedPayload.model).toBe('claude-opus-4.7')
    expect(forwardedPayload.output_config?.effort).toBe('xhigh')
  })

  test('Claude streaming responses are piped through natively', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'fast-mode-2026-02-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6-20250514',
        speed: 'fast',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)

    const body = await res.text()
    expect(body).toContain('event: message_start')
    expect(body).toContain('\"model\":\"claude-opus-4-6-20250514\"')
    expect(body).not.toContain('\"model\":\"claude-opus-4.6-fast\"')
    expect(body).toContain('event: content_block_delta')
    expect(body).toContain('event: message_stop')
  })

  test('Claude native /v1/messages errors are surfaced verbatim (no automatic chat-completions fallback)', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (!url.endsWith('/v1/messages')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }
      return new Response(JSON.stringify({
        error: {
          message: 'unsupported_api_for_model',
          code: 'unsupported_api_for_model',
        },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')
  })

  test('Claude native passthrough synthesizes message_stop when upstream stream terminates after visible text', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (!url.endsWith('/v1/messages')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      return new Response([
        'event: message_start\n',
        'data: {"type":"message_start","message":{"id":"msg_partial","type":"message","role":"assistant","content":[],"model":"claude-opus-4-6-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
        'event: content_block_start\n',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-6-20250514',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)

    const body = await res.text()
    expect(body).toContain('event: content_block_delta')
    expect(body).toContain('\"text\":\"partial\"')
    expect(body).toContain('event: content_block_stop')
    expect(body).toContain('event: message_stop')
    expect(body).toContain('\"model\":\"claude-opus-4-6-20250514\"')
  })

  test('Responses translated stream emits an error when upstream EOF arrives before terminal event', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (!url.endsWith('/responses')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      return new Response([
        'event: response.created\n',
        'data: {"type":"response.created","response":{"id":"resp_partial","object":"response","model":"gpt-5.4","output":[],"status":"in_progress","error":null}}\n\n',
        'event: response.output_text.delta\n',
        'data: {"type":"response.output_text.delta","output_index":0,"content_index":0,"delta":"partial"}\n\n',
      ].join(''), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)

    const body = await res.text()
    expect(body).toContain('event: message_start')
    expect(body).toContain('event: content_block_delta')
    expect(body).toContain('event: error')
    expect(body).toContain('Upstream Copilot connection terminated before the response completed.')
    expect(body).not.toContain('event: message_stop')
    expect(body).not.toContain('"stop_reason":"end_turn"')
  })

  test('Claude non-streaming requests forward error responses from upstream', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (!url.endsWith('/v1/messages')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'api_error',
          message: 'Backend error from Copilot',
        },
      }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    // Upstream error is forwarded as HTTP error
    expect(res.status).toBe(502)
  })

  test('Claude native passthrough retries once after stripping replayed assistant thinking blocks', async () => {
    const forwardedPayloads: Array<{
      messages?: Array<{
        role?: string
        content?: unknown
      }>
    }> = []

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/v1/messages')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      const forwardedPayload = init?.body
        ? JSON.parse(String(init.body)) as {
          messages?: Array<{
            role?: string
            content?: unknown
          }>
        }
        : {}
      forwardedPayloads.push(forwardedPayload)

      if (forwardedPayloads.length === 1) {
        return new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'messages.1.content.0: Invalid `signature` in `thinking` block',
          },
        }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'x-request-id': 'req_invalid_signature',
          },
        })
      }

      return new Response(JSON.stringify({
        id: 'msg_self_healed',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'healed' }],
        model: 'claude-opus-4.6',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 1 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'Hello.' },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Old replay-only reasoning.',
                signature: 'sig_old_only',
              },
            ],
          },
          { role: 'user', content: 'Continue.' },
          {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'Signed reasoning to strip.',
                signature: 'sig_mixed',
              },
              { type: 'text', text: 'Visible answer.' },
            ],
          },
          { role: 'user', content: 'Follow up.' },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    expect(forwardedPayloads[0]?.messages?.[1]?.content).toEqual([
      {
        type: 'thinking',
        thinking: 'Old replay-only reasoning.',
        signature: 'sig_old_only',
      },
    ])
    expect(forwardedPayloads[0]?.messages?.[3]?.content).toEqual([
      {
        type: 'thinking',
        thinking: 'Signed reasoning to strip.',
        signature: 'sig_mixed',
      },
      { type: 'text', text: 'Visible answer.' },
    ])

    expect(forwardedPayloads[1]?.messages?.map(message => message.role)).toEqual([
      'user',
      'user',
      'assistant',
      'user',
    ])
    expect(forwardedPayloads[1]?.messages?.[2]?.content).toEqual([
      { type: 'text', text: 'Visible answer.' },
    ])

    const body = await res.json() as {
      content?: Array<Record<string, unknown>>
    }
    expect(body.content).toEqual([{ type: 'text', text: 'healed' }])
  })

  test('Claude invalid signature errors are forwarded when there is no assistant thinking history to strip', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.endsWith('/v1/messages')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }

      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'messages.1.content.0: Invalid `signature` in `thinking` block',
        },
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const body = await res.json() as {
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('Invalid `signature` in `thinking` block')
  })

  test('Claude URL image requests fail locally with Anthropic invalid_request_error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'url',
                  url: 'https://example.com/cat.png',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('external image URLs')
    expect(body.error?.message).toContain('base64')
  })

  test('Responses-backed URL image requests fail locally with Anthropic invalid_request_error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'url',
                  url: 'https://example.com/cat.png',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('external image URLs')
    expect(body.error?.message).toContain('base64')
  })

  test('tool_result URL image requests fail locally with Anthropic invalid_request_error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: [
                  { type: 'text', text: 'See attached image' },
                  {
                    type: 'image',
                    source: {
                      type: 'url',
                      url: 'https://example.com/result.png',
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('external image URLs')
    expect(body.error?.message).toContain('base64')
  })

  test('document blocks with invalid PDF data return extraction error', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                title: 'report.pdf',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'JVBERi0xLjQK',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: {
        type?: string
        message?: string
      }
    }

    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('Failed to extract text from PDF document')
  })

  test('Claude document blocks are forwarded natively without local expansion', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                title: 'report.pdf',
                citations: { enabled: true },
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'JVBERi0xLjQK',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      messages?: Array<{ content?: Array<Record<string, unknown>> }>
    }
    expect(forwardedPayload.messages?.[0]?.content?.[0]).toEqual({
      type: 'document',
      title: 'report.pdf',
      citations: { enabled: true },
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'JVBERi0xLjQK',
      },
    })

    // Verify the response body preserves citations in the text block
    const body = await res.json() as {
      content?: Array<{ type?: string, text?: string, citations?: unknown[] }>
    }
    expect(body.content?.[0]?.citations).toEqual([
      { type: 'char_location', cited_text: 'test', document_index: 0, start_char_index: 0, end_char_index: 4 },
    ])
  })

  test('Claude native passthrough expands official text-source documents with source.data', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'text',
                  media_type: 'text/plain',
                  data: 'Hello from source.data',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      messages?: Array<{ content?: Array<Record<string, unknown>> }>
    }

    expect(forwardedPayload.messages?.[0]?.content?.[0]).toEqual({
      type: 'text',
      text: 'Hello from source.data',
    })
  })

  test('Claude native passthrough rejects citations on text documents before upstream', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [{
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'Citation source.',
            },
            citations: { enabled: true },
          }],
        }],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as {
      type?: string
      error?: { type?: string, message?: string }
    }
    expect(body.type).toBe('error')
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('Document citations cannot be preserved')
  })

  test('Claude native passthrough rejects inner content cache breakpoints before upstream', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [{
            type: 'document',
            source: {
              type: 'content',
              content: [{
                type: 'text',
                text: 'Cached paragraph.',
                cache_control: { type: 'ephemeral' },
              }],
            },
          }],
        }],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    const body = await res.json() as { error?: { type?: string, message?: string } }
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('document.source.content cache_control cannot be preserved')
  })

  test('Responses-backed document translation rejects citations before upstream', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [{
            type: 'document',
            source: {
              type: 'text',
              media_type: 'text/plain',
              data: 'Citation source.',
            },
            citations: { enabled: true },
          }],
        }],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
    const body = await res.json() as { error?: { type?: string, message?: string } }
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('Document citations cannot be preserved')
  })

  test('Claude native passthrough expands legacy source.text documents', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'text',
                  media_type: 'text/plain',
                  text: 'Hello from legacy source.text',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      messages?: Array<{ content?: Array<Record<string, unknown>> }>
    }

    expect(forwardedPayload.messages?.[0]?.content?.[0]).toEqual({
      type: 'text',
      text: 'Hello from legacy source.text',
    })
  })

  test('Claude with file source type is rejected with 400', async () => {
    // Send a request with source.type = 'file' through the proxy
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: [{
            type: 'document',
            source: { type: 'file', file_id: 'file-abc123' },
          }],
        }],
      }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('Files API')
  })

  test('Claude native passthrough preserves top-level cache_control and adaptive display', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        cache_control: { type: 'ephemeral' },
        thinking: { type: 'adaptive', display: 'omitted' },
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      cache_control?: { type?: string }
      thinking?: { type?: string, display?: string }
    }
    expect(forwardedPayload.cache_control).toEqual({ type: 'ephemeral' })
    expect(forwardedPayload.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
  })

  test('Claude document URL requests are forwarded natively (proxy no longer expands them locally)', async () => {
    // Native /v1/messages will reject URL-backed documents itself; the proxy
    // simply forwards. We mock the upstream returning a 4xx and assert the
    // proxy did not pre-fetch the URL or fall back to chat-completions.
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (!url.endsWith('/v1/messages')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'document.source.type=url is not supported',
        },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    })

    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'url', url: 'https://example.com/doc.txt' },
            },
            { type: 'text', text: 'What is the capital mentioned in the document?' },
          ],
        }],
      }),
    })

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')
  })

  test('/v1/responses Claude json_object requests are translated to /v1/messages and surface upstream rejection', async () => {
    fetchMock.mockImplementationOnce(async (url: string) => {
      if (!url.endsWith('/v1/messages')) {
        throw new Error(`Unexpected upstream URL: ${url}`)
      }
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'output_config.format json_object: not supported',
        },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    })

    const res = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        input: 'Return JSON.',
        text: {
          format: {
            type: 'json_object',
          },
        },
      }),
    })

    // Claude does not advertise /responses, so /v1/responses requests are
    // translated to /v1/messages. The proxy no longer falls back to
    // chat-completions when v1/messages cannot honor json_object.
    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages')
  })

  test('count_tokens with document blocks is forwarded natively without local expansion', async () => {
    const res = await server.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4.6',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                title: 'report.pdf',
                source: {
                  type: 'base64',
                  media_type: 'application/pdf',
                  data: 'JVBERi0xLjQK',
                },
              },
            ],
          },
        ],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages/count_tokens')
    const forwardedPayload = JSON.parse(String(init.body)) as { messages: Array<{ content: Array<{ type: string }> }> }
    expect(forwardedPayload.messages[0].content[0].type).toBe('document')

    const body = await res.json() as { input_tokens?: number }
    expect(body.input_tokens).toBe(26)
  })

  test('count_tokens normalizes model names and strips advisor beta feature', async () => {
    const res = await server.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'claude-code-2025-01-01, fast-mode-2026-02-01, advisor-tool-2026-03-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        tools: [
          {
            type: 'advisor_20260301',
            name: 'advisor',
            model: 'claude-opus-4-7',
          },
        ],
        messages: [{ role: 'user', content: 'Count this.' }],
      }),
    })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/v1/messages/count_tokens')
    const forwardedPayload = JSON.parse(String(init.body)) as { model?: string, tools?: unknown }
    expect(forwardedPayload.model).toBe('claude-opus-4.6')
    expect(forwardedPayload.tools).toBeUndefined()
    const headers = init.headers as Record<string, string>
    expect(headers['anthropic-beta']).toBe('claude-code-2025-01-01, fast-mode-2026-02-01')
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})
