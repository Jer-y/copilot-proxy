import type { State } from '~/lib/state'

import { describe, expect, test } from 'bun:test'

import { HTTPError } from '~/lib/error'
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

    // Math.ceil(1 - 0.5) = 1 second wait, allow tolerance
    expect(elapsed).toBeGreaterThanOrEqual(800)
    expect(elapsed).toBeLessThan(2000)
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
})
