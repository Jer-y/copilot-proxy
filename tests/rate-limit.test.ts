import type { State } from '~/lib/state'

import { describe, expect, test } from 'bun:test'

import { HTTPError } from '~/lib/error'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'
import { checkRateLimit } from '~/lib/rate-limit'

function makeState(overrides?: Partial<State>): State {
  return {
    accountType: 'individual',
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    ...overrides,
  }
}

describe('checkRateLimit', () => {
  test('no-op when rateLimitSeconds is undefined', async () => {
    const state = makeState({ rateLimitSeconds: undefined })
    await expect(checkRateLimit(state)).resolves.toBeUndefined()
  })

  test('first request passes and sets timestamp', async () => {
    const state = makeState({ rateLimitSeconds: 10 })
    expect(state.lastRequestTimestamp).toBeUndefined()

    await checkRateLimit(state)

    expect(state.lastRequestTimestamp).toBeDefined()
    expect(state.lastRequestTimestamp!).toBeGreaterThan(0)
  })

  test('second request within limit throws 429 when rateLimitWait is false', async () => {
    const state = makeState({
      rateLimitSeconds: 9999,
      rateLimitWait: false,
    })

    // First call — sets the timestamp
    await checkRateLimit(state)

    // Second call — still within the 9999-second window
    try {
      await checkRateLimit(state)
      expect.unreachable('should have thrown')
    }
    catch (error) {
      expect(error).toBeInstanceOf(HTTPError)
      const httpError = error as HTTPError
      expect(httpError.response.status).toBe(429)
      expect(httpError.response.headers.get('retry-after')).toBe('9999')
      expect(await httpError.json()).toEqual({
        error: {
          message: 'Rate limit exceeded',
          type: 'rate_limit_error',
        },
      })
    }
  })

  test('request passes after window expires', async () => {
    const state = makeState({
      rateLimitSeconds: 1,
      lastRequestTimestamp: Date.now() - 2000, // 2 seconds ago
    })

    // Should pass without throwing because the window has expired
    await expect(checkRateLimit(state)).resolves.toBeUndefined()
  })

  test('rateLimitWait mode waits instead of throwing', async () => {
    const state = makeState({
      rateLimitSeconds: 1,
      rateLimitWait: true,
      lastRequestTimestamp: Date.now() - 500, // 0.5s ago
    })

    const start = Date.now()
    await checkRateLimit(state)
    const elapsed = Date.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(1500)
  })

  test('timestamp is updated before sleep completes (race guard)', async () => {
    const state = makeState({
      rateLimitSeconds: 1,
      rateLimitWait: true,
      lastRequestTimestamp: Date.now() - 500, // 0.5s ago
    })

    const timestampBeforeCall = state.lastRequestTimestamp!

    // Start the rate-limited call (it will sleep for ~1s)
    const promise = checkRateLimit(state)

    // After a short delay, verify the timestamp was already updated
    // (before the sleep completes)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(state.lastRequestTimestamp).toBeDefined()
    expect(state.lastRequestTimestamp!).toBeGreaterThan(timestampBeforeCall)

    // Let the sleep finish so the test cleans up properly
    await promise
  })

  test('rateLimitWait mode reserves future slots for concurrent requests', async () => {
    const state = makeState({
      rateLimitSeconds: 1,
      rateLimitWait: true,
      lastRequestTimestamp: Date.now() - 500,
    })

    const first = checkRateLimit(state)
    await new Promise(resolve => setTimeout(resolve, 50))
    const firstReservedTimestamp = state.lastRequestTimestamp!

    const second = checkRateLimit(state)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(state.lastRequestTimestamp!).toBeGreaterThan(firstReservedTimestamp)

    await Promise.all([first, second])
  })

  test('rejects an over-full wait queue without consuming another slot', async () => {
    const requiredGapMs = 86_400 * 1000
    const lastReservedTimestamp = Date.now() + (24 * requiredGapMs)
    const state = makeState({
      rateLimitSeconds: 86_400,
      rateLimitWait: true,
      lastRequestTimestamp: lastReservedTimestamp,
    })

    const error = await checkRateLimit(state).catch((error: unknown) => error)

    expect(error).toBeInstanceOf(HTTPError)
    const httpError = error as HTTPError
    expect(httpError.response.status).toBe(429)
    expect(httpError.response.headers.get('retry-after')).toBeTruthy()
    expect(await httpError.json()).toMatchObject({
      error: { code: 'rate_limit_queue_full' },
    })
    expect(state.lastRequestTimestamp).toBe(lastReservedTimestamp)
    expect(requiredGapMs * 25).toBeGreaterThan(MAX_TIMER_DELAY_MS)
  })
})
