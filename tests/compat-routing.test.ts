import { beforeEach, describe, expect, mock, test } from 'bun:test'

import { clearProbeCache } from '../src/lib/api-probe'
import { state } from '../src/lib/state'
import { server } from '../src/server'

state.copilotToken = 'test-token'
state.vsCodeVersion = '1.0.0'
state.accountType = 'individual'

const fetchMock = mock(async (url: string) => {
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
  test('/v1/responses falls back to /responses when CC is unsupported for an unknown model', async () => {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-next',
        input: 'hello',
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.object).toBe('response')
    expect(body.model).toBe('gpt-next')

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/chat/completions',
      'https://api.githubcopilot.com/responses',
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

  test('/v1/responses prefers /chat/completions for Claude json_object and falls back to /responses when CC is unsupported', async () => {
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

    expect(response.status).toBe(200)

    const calledUrls = fetchMock.mock.calls.map(call => call[0] as string)
    expect(calledUrls).toEqual([
      'https://api.githubcopilot.com/chat/completions',
      'https://api.githubcopilot.com/responses',
    ])
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
    expect(body.error?.message).toContain('input_file is not supported')
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
