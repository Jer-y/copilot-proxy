import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { clearProbeCache } from '../src/lib/api-probe'
import { state } from '../src/lib/state'
import { server } from '../src/server'

state.copilotToken = 'test-token'
state.vsCodeVersion = '1.0.0'
state.accountType = 'individual'

const fetchMock = mock(async (url: string) => {
  if (url.endsWith('/v1/messages')) {
    return new Response(JSON.stringify({
      id: 'msg_fallback',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.6',
      content: [{ type: 'text', text: 'fallback ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (url.endsWith('/chat/completions')) {
    return new Response(JSON.stringify({
      error: {
        message: 'unsupported_api_for_model',
        type: 'invalid_request_error',
        code: 'unsupported_api_for_model',
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({
    id: 'resp_fallback',
    object: 'response',
    model: 'gpt-next',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'fallback ok' }] }],
    status: 'completed',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockClear()
  clearProbeCache()
  state.lastRequestTimestamp = undefined
})

describe('compat routing fallback', () => {
  test('/v1/responses only tries /chat/completions for unknown models', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-next',
        input: 'hello',
      }),
    })

    expect(response.status).toBe(400)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/chat/completions',
    ])
  })

  test('/v1/responses accepts typed input items when routing directly to responses', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: [
          {
            type: 'reasoning',
            encrypted_content: 'opaque-reasoning-state',
          },
        ],
      }),
    })

    expect(response.status).toBe(200)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/responses',
    ])
  })

  test('/v1/responses keeps Claude json_object requests on /chat/completions only', async () => {
    const response = await server.request('/v1/responses', {
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

    expect(response.status).toBe(400)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/chat/completions',
    ])
  })

  test('/v1/responses keeps Claude json_schema requests on native Anthropic so unsupported format is not falsely treated as supported', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        input: 'Return JSON.',
        text: {
          format: {
            type: 'json_schema',
            name: 'sample',
            schema: {
              type: 'object',
              properties: { answer: { type: 'string' } },
              required: ['answer'],
            },
          },
        },
      }),
    })

    expect(response.status).toBe(200)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/v1/messages',
    ])
  })

  test('/v1/responses does not retry Claude json_schema native rejection through chat-completions', async () => {
    fetchMock.mockImplementation(async (url: string) => {
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
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '4',
              },
              finish_reason: 'stop',
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected upstream URL: ${url}`)
    })

    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        input: 'What is 2+2? Return answer.',
        text: {
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

    expect(response.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/v1/messages',
    ])

    const body = await response.json() as { error?: { message?: string } }
    expect(body.error?.message).toContain('output_config.format')
  })

  test('/v1/responses rejects Claude input_file payloads locally instead of silently dropping file parts in Anthropic translation', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Summarize this file.' },
              { type: 'input_file', file_url: 'https://example.com/report.pdf' },
            ],
          },
        ],
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(0)

    const body = await response.json() as {
      error?: {
        type?: string
        message?: string
      }
    }
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('input_file is only supported')
  })

  test('/v1/responses rejects hosted tools locally when the model cannot route directly to /responses', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        input: 'Search the web for nothing.',
        tools: [
          {
            type: 'web_search',
          },
        ],
      }),
    })

    expect(response.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(0)

    const body = await response.json() as {
      error?: {
        type?: string
        message?: string
      }
    }
    expect(body.error?.type).toBe('invalid_request_error')
    expect(body.error?.message).toContain('Hosted Responses tools are only supported')
  })

  test('/v1/responses skips /responses after unsupported probe is cached and goes straight to /chat/completions', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({
          error: {
            message: 'unsupported_api_for_model',
            type: 'invalid_request_error',
            code: 'unsupported_api_for_model',
          },
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({
          id: 'chatcmpl_fallback',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-5.1',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'ok',
              },
              logprobs: null,
              finish_reason: 'stop',
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      throw new Error(`Unexpected URL ${url}`)
    })

    const request = () => server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-5.1',
        input: 'hello',
      }),
    })

    const first = await request()
    expect(first.status).toBe(200)
    const second = await request()
    expect(second.status).toBe(200)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/responses',
      'https://api.githubcopilot.com/chat/completions',
      'https://api.githubcopilot.com/chat/completions',
    ])
  })
})
