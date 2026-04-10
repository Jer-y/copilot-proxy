import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { clearProbeCache } from '~/lib/api-probe'
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
  clearProbeCache()
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  state.models = undefined
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

describe('messages route upstream adaptation', () => {
  test('Claude json_object requests are routed to chat-completions instead of native /v1/messages', async () => {
    const res = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
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
    expect(url).toBe('https://api.githubcopilot.com/chat/completions')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      response_format?: { type?: string }
      model?: string
    }

    expect(forwardedPayload.model).toBe('claude-opus-4.6')
    expect(forwardedPayload.response_format).toEqual({ type: 'json_object' })
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

  test('Claude json_schema requests are routed natively to /v1/messages with Copilot-safe output_config normalization', async () => {
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
        schema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
        },
      },
    })
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

  test('Claude non-streaming responses forward the effective model to upstream', async () => {
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
    expect(forwardedPayload.model).toBe('claude-opus-4.6-fast')

    const body = await res.json() as { model?: string }
    expect(body.model).toBe('claude-opus-4-6-20250514')
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

  test('Claude falls back to chat-completions when native /v1/messages is unsupported and caches the probe result', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/messages')) {
        return new Response(JSON.stringify({
          error: {
            message: 'unsupported_api_for_model',
            code: 'unsupported_api_for_model',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.endsWith('/chat/completions')) {
        return new Response([
          'data: {"id":"chatcmpl_fallback_stream","object":"chat.completion.chunk","created":0,"model":"claude-opus-4.6","choices":[{"index":0,"delta":{"content":"fallback ok"},"finish_reason":"stop","logprobs":null}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n',
          'data: [DONE]\n\n',
        ].join(''), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }

      throw new Error(`Unexpected upstream URL: ${url} body=${String(init?.body)}`)
    })

    const makeRequest = () => server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })

    const first = await makeRequest()
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { content?: Array<{ text?: string, type?: string }> }
    expect(firstBody.content).toEqual([{ type: 'text', text: 'fallback ok' }])

    const second = await makeRequest()
    expect(second.status).toBe(200)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/v1/messages',
      'https://api.githubcopilot.com/chat/completions',
      'https://api.githubcopilot.com/chat/completions',
    ])
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

  test('Claude native passthrough accepts official text-source documents with source.data', async () => {
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
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: 'Hello from source.data',
      },
    })
  })

  test('Claude native passthrough normalizes legacy source.text to source.data', async () => {
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
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: 'Hello from legacy source.text',
      },
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

  test('Claude native passthrough strips unsupported top-level cache_control and preserves adaptive display', async () => {
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
    expect(forwardedPayload.cache_control).toBeUndefined()
    expect(forwardedPayload.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
  })

  test('Claude document URL requests bypass native passthrough and expand locally', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (url === 'https://example.com/doc.txt') {
        return new Response('The capital of France is Paris.', {
          status: 200,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }

      return defaultFetchMock(url, init)
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

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const calledUrls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(calledUrls).toEqual([
      'https://example.com/doc.txt',
      'https://api.githubcopilot.com/chat/completions',
    ])
  })

  test('/v1/responses routes Claude json_object requests to /chat/completions before considering /responses', async () => {
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

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.githubcopilot.com/chat/completions')

    const forwardedPayload = JSON.parse(String(init?.body)) as {
      response_format?: { type?: string }
      model?: string
    }
    expect(forwardedPayload.model).toBe('claude-opus-4.6')
    expect(forwardedPayload.response_format).toEqual({ type: 'json_object' })
  })

  test('count_tokens with document blocks returns default when model not found', async () => {
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

    // Model not found in test env → early return with default, no document expansion attempted
    expect(res.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()

    const body = await res.json() as { input_tokens?: number }
    expect(body.input_tokens).toBe(1)
  })
})

afterEach(() => {
  clearProbeCache()
  globalThis.fetch = originalFetch
})
