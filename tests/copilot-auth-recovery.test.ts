import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { AsyncConcurrencyLimiter } from '~/lib/concurrency-limiter'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import {
  fetchAuthenticatedCopilot,
  getCopilotRecoveryStatus,
  resetCopilotRecoveryStateForTests,
} from '~/services/copilot/authenticated-fetch'

function opaqueForbidden(): Response {
  return new Response('Forbidden\n', {
    status: 403,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Copilot-Service-Request-Id': crypto.randomUUID(),
      'X-GitHub-Request-Id': crypto.randomUUID(),
    },
  })
}

function completed(body = 'ok'): Response {
  return new Response(body, { status: 200 })
}

describe('authenticated Copilot recovery', () => {
  let originalToken: string | undefined
  let originalLimiter: typeof state.concurrencyLimiter

  beforeEach(() => {
    originalToken = state.copilotToken
    originalLimiter = state.concurrencyLimiter
    state.copilotToken = 'old-token'
    state.concurrencyLimiter = undefined
    resetCopilotRecoveryStateForTests()
  })

  afterEach(() => {
    state.copilotToken = originalToken
    state.concurrencyLimiter = originalLimiter
    resetCopilotRecoveryStateForTests()
  })

  test('refreshes after a 401 and rebuilds the request once', async () => {
    const authorizations: string[] = []
    const refreshToken = mock(async () => {
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })

    const response = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-test',
      request: async (attempt) => {
        authorizations.push(`Bearer ${state.copilotToken}`)
        return attempt === 0
          ? new Response('Unauthorized', { status: 401 })
          : completed()
      },
    }, { refreshToken })

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(authorizations).toEqual(['Bearer old-token', 'Bearer new-token'])
    expect(getCopilotRecoveryStatus().metrics.replaySuccesses).toBe(1)
  })

  test('only treats eligible authentication failures as recoverable', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const cases = [
      new Response(JSON.stringify({ error: { code: 'model_not_allowed', message: 'no' } }), { status: 403 }),
      new Response('Forbidden\n', { status: 403 }),
      new Response('Forbidden\n', {
        status: 403,
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Request-Id': 'wrong-mime-request-id',
        },
      }),
      new Response('Forbidden\n', {
        status: 403,
        headers: {
          'Content-Type': 'text/html',
          'X-GitHub-Request-Id': 'html-request-id',
        },
      }),
      new Response('Forbidden\n', {
        status: 403,
        headers: {
          'Retry-After': '60',
          'X-Copilot-Service-Request-Id': 'request-id',
        },
      }),
      new Response('rate limited', { status: 429 }),
      new Response('upstream failed', { status: 500 }),
    ]

    for (const [index, upstreamResponse] of cases.entries()) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: `/responses/${index}`,
        request: async () => upstreamResponse,
      }, { refreshToken })
      expect(response.status).toBe(upstreamResponse.status)
    }

    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses/transport-error',
      request: async () => {
        throw new Error('connection reset')
      },
    }, { refreshToken })).rejects.toThrow('connection reset')

    expect(refreshToken).toHaveBeenCalledTimes(0)
  })

  test('refreshes an explicit invalid-token 403 once', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const request = mock(async (attempt: 0 | 1) => attempt === 0
      ? Response.json({ error: { code: 'invalid_token', message: 'expired' } }, { status: 403 })
      : completed('recovered'))

    const response = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-expired-token',
      request,
    }, { refreshToken })

    expect(await response.text()).toBe('recovered')
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(2)
  })

  test('coalesces concurrent same-scope failures into one refresh and one canary', async () => {
    const refreshToken = mock(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      state.copilotToken = 'new-token'
      return { outcome: 'refreshed' as const, generation: 2 }
    })
    let firstAttempts = 0
    let replays = 0

    const responses = await Promise.all(Array.from({ length: 32 }, () =>
      fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-test',
        request: async (attempt) => {
          if (attempt === 0) {
            firstAttempts++
            return opaqueForbidden()
          }
          replays++
          return completed()
        },
      }, { refreshToken })))

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(firstAttempts).toBe(32)
    expect(replays).toBe(32)
    expect(responses.every(response => response.status === 200)).toBe(true)
  })

  test('does not evict a closed scope while one of its requests is still in flight', async () => {
    let resolveFirstResponse!: (response: Response) => void
    let markFirstStarted!: () => void
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirstResponse = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const firstRequest = mock(async (attempt: 0 | 1) => {
      if (attempt === 0) {
        markFirstStarted()
        return await firstResponse
      }
      return opaqueForbidden()
    })

    const pending = fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-in-flight-oldest',
      request: firstRequest,
    }, { refreshToken })
    await firstStarted

    for (let index = 0; index < 127; index++) {
      await fetchAuthenticatedCopilot({
        endpoint: `/responses/fill-${index}`,
        request: async () => completed(),
      })
    }
    await fetchAuthenticatedCopilot({
      endpoint: '/responses/overflow',
      request: async () => completed(),
    })

    resolveFirstResponse(opaqueForbidden())
    expect((await pending).status).toBe(403)
    expect(firstRequest).toHaveBeenCalledTimes(2)
    expect(getCopilotRecoveryStatus().scopes.open).toBe(1)

    const bypassRequest = mock(async () => completed('must not reach upstream'))
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-in-flight-oldest',
      request: bypassRequest,
    }, { refreshToken })).rejects.toBeInstanceOf(HTTPError)
    expect(bypassRequest).toHaveBeenCalledTimes(0)
  })

  test('does not open the global circuit when healthy in-flight scopes saturate the registry', async () => {
    let releaseRequests!: () => void
    let markAllStarted!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      releaseRequests = resolve
    })
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve
    })
    let started = 0
    const pending = Array.from({ length: 128 }, (_, index) =>
      fetchAuthenticatedCopilot({
        endpoint: `/responses/healthy-in-flight-${index}`,
        request: async () => {
          started++
          if (started === 128)
            markAllStarted()
          await releaseGate
          return completed()
        },
      }))

    await allStarted
    try {
      const overflowRequest = mock(async () => completed('healthy overflow'))
      const overflowResponse = await fetchAuthenticatedCopilot({
        endpoint: '/responses/healthy-in-flight-overflow',
        request: overflowRequest,
      })

      expect(await overflowResponse.text()).toBe('healthy overflow')
      expect(overflowRequest).toHaveBeenCalledTimes(1)
      expect(getCopilotRecoveryStatus().globalCircuit.phase).toBe('closed')
      expect(getCopilotRecoveryStatus().metrics.globalCircuitOpens).toBe(0)
    }
    finally {
      releaseRequests()
      await Promise.all(pending)
    }
  })

  test('suppresses staggered followers after a failed fresh-token canary opens the scope', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    let replays = 0

    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-persistent',
        request: async (attempt) => {
          if (attempt === 0 && index > 0)
            await new Promise(resolve => setTimeout(resolve, 20))
          if (attempt === 1)
            replays++
          return opaqueForbidden()
        },
      }, { refreshToken })))

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(replays).toBe(1)
    expect(responses.every(response => response.status === 403)).toBe(true)
    expect(getCopilotRecoveryStatus().scopes.open).toBe(1)
  })

  test('opens a scoped circuit when a fresh-token canary is still rejected', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const request = mock(async () => opaqueForbidden())

    const rejected = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-blocked',
      request,
    }, { now: () => now, refreshToken })
    expect(rejected.status).toBe(403)
    expect(request).toHaveBeenCalledTimes(2)

    let circuitError: HTTPError | undefined
    try {
      await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model: 'gpt-blocked',
        request,
      }, { now: () => now, refreshToken })
    }
    catch (error) {
      circuitError = error as HTTPError
    }
    expect(circuitError).toBeInstanceOf(HTTPError)
    expect(circuitError?.response.status).toBe(503)
    expect(circuitError?.response.headers.get('retry-after')).toBe('60')
    expect(request).toHaveBeenCalledTimes(2)

    now += 60_001
    const halfOpen = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-blocked',
      request: async () => completed('recovered'),
    }, { now: () => now, refreshToken })
    expect(await halfOpen.text()).toBe('recovered')
    expect(getCopilotRecoveryStatus(now).scopes.open).toBe(0)
  })

  test('suppresses repeated token exchanges for other scopes after refresh itself fails', async () => {
    const refreshToken = mock(async () => ({ outcome: 'failed' as const, generation: 1 }))

    for (const model of ['gpt-refresh-failure-a', 'gpt-refresh-failure-b']) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { refreshToken })
      expect(response.status).toBe(403)
    }

    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(getCopilotRecoveryStatus().metrics.reactiveRefreshSuppressions).toBe(1)
    expect(typeof getCopilotRecoveryStatus().reactiveRefreshSuppressedUntil).toBe('number')
  })

  test('aggregates scopes opened by repeated opaque failures while refresh is suppressed', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'failed' as const, generation: 1 }))
    const request = mock(async () => opaqueForbidden())

    for (const model of ['gpt-threshold-a', 'gpt-threshold-b']) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await fetchAuthenticatedCopilot({
          endpoint: '/responses',
          model,
          request,
        }, { now: () => now++, refreshToken })
        expect(response.status).toBe(403)
      }
    }

    const status = getCopilotRecoveryStatus(now)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(6)
    expect(status.scopes.open).toBe(2)
    expect(status.globalCircuit.phase).toBe('open')
    expect(status.metrics.globalCircuitOpens).toBe(1)
  })

  test('opens the global circuit after persistent failures in two scopes', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    for (const model of ['gpt-a', 'gpt-b']) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { refreshToken })
      expect(response.status).toBe(403)
    }

    expect(getCopilotRecoveryStatus().globalCircuit.phase).toBe('open')
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/v1/messages',
      model: 'claude-c',
      request: async () => completed(),
    }, { refreshToken })).rejects.toBeInstanceOf(HTTPError)
  })

  test('reopens scoped and global cooldowns when a half-open transport probe throws', async () => {
    let now = 1_000
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    for (const model of ['gpt-transport-a', 'gpt-transport-b']) {
      const response = await fetchAuthenticatedCopilot({
        endpoint: '/responses',
        model,
        request: async () => opaqueForbidden(),
      }, { now: () => now, refreshToken })
      expect(response.status).toBe(403)
    }
    expect(getCopilotRecoveryStatus(now).globalCircuit.phase).toBe('open')

    now += 60_001
    const transportProbe = mock(async () => {
      throw new Error('connection reset during half-open probe')
    })
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-transport-a',
      request: transportProbe,
    }, { now: () => now, refreshToken })).rejects.toThrow('connection reset during half-open probe')

    const status = getCopilotRecoveryStatus(now)
    expect(transportProbe).toHaveBeenCalledTimes(1)
    expect(status.globalCircuit.phase).toBe('open')
    expect(status.globalCircuit.retryAfterSeconds).toBe(120)
    expect(status.scopes.open).toBe(1)

    const blockedRequest = mock(async () => completed('must not reach upstream'))
    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses',
      model: 'gpt-transport-a',
      request: blockedRequest,
    }, { now: () => now, refreshToken })).rejects.toBeInstanceOf(HTTPError)
    expect(blockedRequest).toHaveBeenCalledTimes(0)
  })

  test('holds the concurrency lease until the response body completes', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })

    const first = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      request: async () => completed('first'),
    })

    await expect(fetchAuthenticatedCopilot({
      endpoint: '/responses/second',
      request: async () => completed('second'),
    })).rejects.toMatchObject({ response: { status: 429 } })

    expect(await first.text()).toBe('first')
    const third = await fetchAuthenticatedCopilot({
      endpoint: '/responses/third',
      request: async () => completed('third'),
    })
    expect(await third.text()).toBe('third')
    expect(state.concurrencyLimiter.snapshot().active).toBe(0)
  })

  test('releases the concurrency lease when the response body is cancelled', async () => {
    state.concurrencyLimiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
    let upstreamCancelled = false
    const response = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      request: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
        },
        cancel() {
          upstreamCancelled = true
        },
      })),
    })

    expect(state.concurrencyLimiter.snapshot().active).toBe(1)
    await response.body?.cancel('client disconnected')
    expect(upstreamCancelled).toBe(true)
    expect(state.concurrencyLimiter.snapshot().active).toBe(0)
  })

  test('never refreshes after a successful streaming response has begun', async () => {
    const refreshToken = mock(async () => ({ outcome: 'refreshed' as const, generation: 2 }))
    const response = await fetchAuthenticatedCopilot({
      endpoint: '/responses',
      request: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('event-one'))
          controller.error(new Error('stream failed'))
        },
      }), { status: 200 }),
    }, { refreshToken })

    await expect(response.text()).rejects.toThrow('stream failed')
    expect(refreshToken).toHaveBeenCalledTimes(0)
  })
})
