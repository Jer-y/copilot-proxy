import { beforeEach, expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'
import { server } from '../src/server'

state.copilotToken = 'test-token'
state.vsCodeVersion = '1.0.0'
state.accountType = 'individual'

async function defaultFetchImplementation(_url: string, _opts?: RequestInit) {
  return new Response(JSON.stringify({
    error: {
      message: 'failed to parse request',
      type: 'invalid_request_error',
      code: '',
    },
  }), {
    status: 413,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fetchMock = mock(defaultFetchImplementation)

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(defaultFetchImplementation)
})

test('/v1/responses official subroutes are forwarded to the Copilot backend', async () => {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    return new Response(JSON.stringify({
      ok: true,
      url,
      method: opts?.method,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'req_forwarded',
      },
    })
  })

  const cases = [
    {
      localPath: '/v1/responses/input_tokens',
      upstreamUrl: 'https://api.githubcopilot.com/responses/input_tokens',
      method: 'POST',
      body: { model: 'gpt-5.5', input: 'hello' },
    },
    {
      localPath: '/v1/responses/compact',
      upstreamUrl: 'https://api.githubcopilot.com/responses/compact',
      method: 'POST',
      body: { model: 'gpt-5.5', input: 'hello' },
    },
    {
      localPath: '/v1/responses/resp_123?include[]=reasoning.encrypted_content',
      upstreamUrl: 'https://api.githubcopilot.com/responses/resp_123?include[]=reasoning.encrypted_content',
      method: 'GET',
    },
    {
      localPath: '/v1/responses/resp_123/input_items?limit=1',
      upstreamUrl: 'https://api.githubcopilot.com/responses/resp_123/input_items?limit=1',
      method: 'GET',
    },
    {
      localPath: '/v1/responses/resp_123/cancel',
      upstreamUrl: 'https://api.githubcopilot.com/responses/resp_123/cancel',
      method: 'POST',
    },
    {
      localPath: '/v1/responses/resp_123',
      upstreamUrl: 'https://api.githubcopilot.com/responses/resp_123',
      method: 'DELETE',
    },
  ] as const

  for (const item of cases) {
    const response = await server.request(item.localPath, {
      method: item.method,
      headers: item.body ? { 'Content-Type': 'application/json' } : undefined,
      body: item.body ? JSON.stringify(item.body) : undefined,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('req_forwarded')
  }

  expect(fetchMock.mock.calls.map(call => ({
    url: call[0],
    method: (call[1] as RequestInit | undefined)?.method,
  }))).toEqual(cases.map(item => ({
    url: item.upstreamUrl,
    method: item.method,
  })))
})

test('/v1/responses surfaces upstream 413 with request-size diagnostics', async () => {
  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'inspect this' },
            { type: 'input_image', image_url: 'data:image/png;base64,abcdef' },
          ],
        },
      ],
    }),
  })

  expect(response.status).toBe(413)

  const json = await response.json() as {
    error: {
      message: string
      type: string
      code: string
    }
  }

  expect(json.error.type).toBe('invalid_request_error')
  expect(json.error.code).toBe('payload_too_large')
  expect(json.error.message).toContain('Upstream /responses rejected the request with 413 Payload Too Large.')
  expect(json.error.message).toContain('data_url_images=1')
  expect(json.error.message).toContain('inline_image_chars=28')
})

test('/v1/responses rejects external image URLs locally before forwarding upstream', async () => {
  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect this image.' },
            { type: 'input_image', image_url: 'https://example.com/image.png' },
          ],
        },
      ],
    }),
  })

  expect(response.status).toBe(400)
  expect(fetchMock).toHaveBeenCalledTimes(0)

  const json = await response.json() as {
    error: {
      message: string
      type: string
    }
  }

  expect(json.error.type).toBe('invalid_request_error')
  expect(json.error.message).toContain('external image URLs')
})

test('/v1/responses rejects top-level typed external image URLs locally before forwarding upstream', async () => {
  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: [
        {
          type: 'input_image',
          image_url: 'https://example.com/image.png',
        },
      ],
    }),
  })

  expect(response.status).toBe(400)
  expect(fetchMock).toHaveBeenCalledTimes(0)

  const json = await response.json() as {
    error: {
      message: string
      type: string
    }
  }

  expect(json.error.type).toBe('invalid_request_error')
  expect(json.error.message).toContain('external image URLs')
})
