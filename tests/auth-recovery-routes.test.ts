import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { AsyncConcurrencyLimiter } from '~/lib/concurrency-limiter'
import { state } from '~/lib/state'
import { stopCopilotTokenRefresh } from '~/lib/token'
import { server } from '~/server'
import { getCopilotRecoveryStatus, resetCopilotRecoveryStateForTests } from '~/services/copilot/authenticated-fetch'

const originalFetch = globalThis.fetch
const originalLimiter = state.concurrencyLimiter

function responsesSuccess(model: string): Response {
  return Response.json({
    id: 'resp_recovered',
    object: 'response',
    model,
    output: [{
      id: 'msg_recovered',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'RECOVERED', annotations: [] }],
    }],
    status: 'completed',
    error: null,
    usage: {
      input_tokens: 5,
      output_tokens: 1,
      total_tokens: 6,
    },
  })
}

function messagesSuccess(model: string): Response {
  return Response.json({
    id: 'msg_recovered',
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: 'RECOVERED' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 5,
      output_tokens: 1,
    },
  })
}

interface RecoveryRouteCase {
  name: string
  path: string
  payload: Record<string, unknown>
  upstreamSuffix: string
  success: () => Response
}

const cases: RecoveryRouteCase[] = [
  {
    name: 'direct Responses',
    path: '/v1/responses',
    payload: { model: 'gpt-5.4', input: 'reply recovered', store: false },
    upstreamSuffix: '/responses',
    success: () => responsesSuccess('gpt-5.4'),
  },
  {
    name: 'native Anthropic Messages',
    path: '/v1/messages',
    payload: {
      model: 'claude-opus-4.8',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'reply recovered' }],
    },
    upstreamSuffix: '/v1/messages',
    success: () => messagesSuccess('claude-opus-4.8'),
  },
  {
    name: 'Anthropic translated to Responses',
    path: '/v1/messages',
    payload: {
      model: 'gpt-5.4',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'reply recovered' }],
    },
    upstreamSuffix: '/responses',
    success: () => responsesSuccess('gpt-5.4'),
  },
  {
    name: 'Responses translated to Anthropic',
    path: '/v1/responses',
    payload: {
      model: 'claude-opus-4.8',
      input: 'reply recovered',
      store: false,
    },
    upstreamSuffix: '/v1/messages',
    success: () => messagesSuccess('claude-opus-4.8'),
  },
]

describe('real route authentication recovery', () => {
  beforeEach(() => {
    stopCopilotTokenRefresh()
    resetCopilotRecoveryStateForTests()
    state.accountType = 'individual'
    state.concurrencyLimiter = undefined
    state.copilotToken = 'old-copilot-token'
    state.githubToken = 'github-token'
    state.lastRequestTimestamp = undefined
    state.models = undefined
    state.vsCodeVersion = '1.0.0'
  })

  afterEach(() => {
    stopCopilotTokenRefresh()
    resetCopilotRecoveryStateForTests()
    state.concurrencyLimiter = originalLimiter
    globalThis.fetch = originalFetch
  })

  for (const routeCase of cases) {
    test(`${routeCase.name} transparently refreshes and replays once`, async () => {
      const upstreamAuthorizations: string[] = []
      const upstreamRequestIds: string[] = []
      let upstreamAttempts = 0
      let tokenExchanges = 0

      const fetchMock = mock(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/copilot_internal/v2/token')) {
          tokenExchanges++
          return Response.json({
            token: 'new-copilot-token',
            refresh_in: 1_500,
            expires_at: Math.floor(Date.now() / 1_000) + 1_800,
          })
        }

        expect(url.endsWith(routeCase.upstreamSuffix)).toBe(true)
        upstreamAttempts++
        const headers = new Headers(init?.headers)
        upstreamAuthorizations.push(headers.get('authorization') ?? '')
        upstreamRequestIds.push(headers.get('x-request-id') ?? '')
        if (upstreamAttempts === 1) {
          return new Response('Forbidden\n', {
            status: 403,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'X-Copilot-Service-Request-Id': 'copilot-first-attempt',
              'X-GitHub-Request-Id': 'github-first-attempt',
            },
          })
        }
        return routeCase.success()
      })
      // @ts-expect-error test mock only needs the fetch call signature
      globalThis.fetch = fetchMock

      const response = await server.request(routeCase.path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(routeCase.payload),
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toContain('RECOVERED')
      expect(tokenExchanges).toBe(1)
      expect(upstreamAttempts).toBe(2)
      expect(upstreamAuthorizations).toEqual([
        'Bearer old-copilot-token',
        'Bearer new-copilot-token',
      ])
      expect(upstreamRequestIds[0]).toBeTruthy()
      expect(upstreamRequestIds[1]).toBeTruthy()
      expect(upstreamRequestIds[1]).not.toBe(upstreamRequestIds[0])
    })
  }

  test('closes an opaque scope after a cancelled 401 leader and three successful route followers', async () => {
    const leaderController = new AbortController()
    let finishTokenExchange!: () => void
    let markTokenExchangeStarted!: () => void
    let markOldTokenRequestsReady!: () => void
    const tokenExchangeGate = new Promise<void>((resolve) => {
      finishTokenExchange = resolve
    })
    const tokenExchangeStarted = new Promise<void>((resolve) => {
      markTokenExchangeStarted = resolve
    })
    const oldTokenRequestsReady = new Promise<void>((resolve) => {
      markOldTokenRequestsReady = resolve
    })
    let oldTokenRequests = 0
    let freshTokenRequests = 0
    let tokenExchanges = 0

    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/copilot_internal/v2/token')) {
        tokenExchanges++
        markTokenExchangeStarted()
        await tokenExchangeGate
        return Response.json({
          token: 'new-copilot-token',
          refresh_in: 1_500,
          expires_at: Math.floor(Date.now() / 1_000) + 1_800,
        })
      }

      expect(url.endsWith('/responses')).toBe(true)
      const authorization = new Headers(init?.headers).get('authorization')
      if (authorization === 'Bearer old-copilot-token') {
        oldTokenRequests++
        if (oldTokenRequests === 4)
          markOldTokenRequestsReady()
        if (oldTokenRequests === 1)
          return new Response('Unauthorized', { status: 401 })
        return new Response('Forbidden\n', {
          status: 403,
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-GitHub-Request-Id': crypto.randomUUID(),
          },
        })
      }

      freshTokenRequests++
      return responsesSuccess('gpt-5.4')
    })
    // @ts-expect-error test mock only needs the fetch call signature
    globalThis.fetch = fetchMock

    const payload = JSON.stringify({ model: 'gpt-5.4', input: 'recover', store: false })
    const leader = server.fetch(new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }), { setupProbeSignal: leaderController.signal })
    await tokenExchangeStarted
    leaderController.abort(new Error('setup deadline expired'))
    expect((await leader).status).toBe(500)

    const followers = Array.from({ length: 3 }, () => server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }))
    await oldTokenRequestsReady
    finishTokenExchange()

    const followerResponses = await Promise.all(followers)
    expect(followerResponses.map(response => response.status)).toEqual([200, 200, 200])
    expect(await Promise.all(followerResponses.map(response => response.text())))
      .toEqual([expect.stringContaining('RECOVERED'), expect.stringContaining('RECOVERED'), expect.stringContaining('RECOVERED')])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(getCopilotRecoveryStatus().scopes.open).toBe(0)

    const nextResponse = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
    expect(nextResponse.status).toBe(200)
    expect(await nextResponse.text()).toContain('RECOVERED')
    expect(tokenExchanges).toBe(1)
    expect(oldTokenRequests).toBe(4)
    expect(freshTokenRequests).toBe(4)
  })

  test('maps a full concurrency queue to client-compatible errors without touching upstream', async () => {
    const limiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
    state.concurrencyLimiter = limiter
    const heldLease = await limiter.acquire()
    const fetchMock = mock(async () => {
      throw new Error('upstream must not be called while the concurrency queue is full')
    })
    // @ts-expect-error test mock only needs the fetch call signature
    globalThis.fetch = fetchMock

    try {
      const openAIResponse = await server.request('/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.4', input: 'hello', store: false }),
      })
      expect(openAIResponse.status).toBe(429)
      expect(openAIResponse.headers.get('retry-after')).toBe('1')
      expect(openAIResponse.headers.get('x-copilot-proxy-recovery-state')).toBe('concurrency_limited')
      expect(await openAIResponse.json()).toMatchObject({
        error: {
          type: 'rate_limit_error',
          code: 'concurrency_queue_full',
        },
      })

      const anthropicResponse = await server.request('/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-opus-4.8',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      })
      expect(anthropicResponse.status).toBe(429)
      expect(anthropicResponse.headers.get('retry-after')).toBe('1')
      expect(await anthropicResponse.json()).toMatchObject({
        type: 'error',
        error: { type: 'rate_limit_error' },
      })
      expect(fetchMock).toHaveBeenCalledTimes(0)
    }
    finally {
      heldLease.release()
    }
  })

  test('releases the concurrency lease when an SSE consumer exits on the terminal event', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
    const encoder = new TextEncoder()
    let upstreamCancelled = false
    let upstreamCalls = 0
    const fetchMock = mock(async (url: string) => {
      expect(url.endsWith('/v1/messages')).toBe(true)
      upstreamCalls++
      if (upstreamCalls > 1)
        return messagesSuccess('claude-opus-4.8')

      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            'event: message_start',
            'data: {"type":"message_start","message":{"id":"msg_terminal","type":"message","role":"assistant","model":"claude-opus-4.8","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
            '',
            'event: message_delta',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
            '',
            'event: message_stop',
            'data: {"type":"message_stop"}',
            '',
            'data: [DONE]',
            '',
            '',
          ].join('\n')))
        },
        cancel() {
          upstreamCancelled = true
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    })
    // @ts-expect-error test mock only needs the fetch call signature
    globalThis.fetch = fetchMock

    const streamingResponse = await server.request('/v1/messages', {
      method: 'POST',
      headers: {
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4.8',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'finish at the terminal event' }],
        stream: true,
      }),
    })

    expect(streamingResponse.status).toBe(200)
    expect(await streamingResponse.text()).toContain('event: message_stop')
    expect(upstreamCancelled).toBe(true)
    expect(state.concurrencyLimiter.snapshot().active).toBe(0)

    const followingResponse = await server.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.8',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'the slot must be reusable' }],
      }),
    })
    expect(followingResponse.status).toBe(200)
    expect(await followingResponse.text()).toContain('RECOVERED')
    expect(upstreamCalls).toBe(2)
  })
})
