import type { State } from '~/lib/state'

import { describe, expect, test, vi } from 'bun:test'

import { HTTPError } from '~/lib/error'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'
import { checkRateLimit } from '~/lib/rate-limit'

type TrackedAbortListener = ((event: Event) => void) | { handleEvent: (event: Event) => void }

function makeState(overrides?: Partial<State>): State {
  return {
    accountType: 'individual',
    manualApprove: false,
    rateLimitWait: false,
    showToken: false,
    ...overrides,
  }
}

function createTrackedAbortSignal(): {
  abort: () => void
  activeListeners: () => number
  addedListeners: () => number
  removedListeners: () => number
  signal: AbortSignal
} {
  let aborted = false
  let addedListeners = 0
  let removedListeners = 0
  const listeners = new Set<TrackedAbortListener>()
  const signal = {
    get aborted() {
      return aborted
    },
    addEventListener(type: string, listener: TrackedAbortListener | null) {
      if (type !== 'abort' || listener === null)
        return
      addedListeners++
      listeners.add(listener)
    },
    removeEventListener(type: string, listener: TrackedAbortListener | null) {
      if (type !== 'abort' || listener === null || !listeners.delete(listener))
        return
      removedListeners++
    },
  } as AbortSignal

  return {
    abort: () => {
      if (aborted)
        return
      aborted = true
      const event = new Event('abort')
      for (const listener of [...listeners]) {
        if (typeof listener === 'function')
          listener(event)
        else
          listener.handleEvent(event)
      }
    },
    activeListeners: () => listeners.size,
    addedListeners: () => addedListeners,
    removedListeners: () => removedListeners,
    signal,
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

  test('aborts a pending wait immediately and rolls back its reservation', async () => {
    const baseline = Date.now()
    const state = makeState({
      rateLimitSeconds: 3600,
      rateLimitWait: true,
      lastRequestTimestamp: baseline,
    })
    const controller = new AbortController()
    const startedAt = Date.now()
    const result = checkRateLimit(state, { signal: controller.signal })
      .catch((error: unknown) => error)

    expect(state.lastRequestTimestamp).toBe(baseline + 3_600_000)
    controller.abort()

    const error = await result
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('AbortError')
    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(state.lastRequestTimestamp).toBe(baseline)
  })

  test('compacts middle and first cancellations without leaving empty slots', async () => {
    const baseline = Date.now()
    const gapMs = 40
    const state = makeState({
      rateLimitSeconds: gapMs / 1000,
      rateLimitWait: true,
      lastRequestTimestamp: baseline,
    })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = checkRateLimit(state, { signal: firstController.signal })
      .catch((error: unknown) => error)
    const second = checkRateLimit(state, { signal: secondController.signal })
      .catch((error: unknown) => error)
    const third = checkRateLimit(state)

    expect(state.lastRequestTimestamp).toBe(baseline + (gapMs * 3))

    secondController.abort()
    expect(state.lastRequestTimestamp).toBe(baseline + (gapMs * 2))

    firstController.abort()
    expect(state.lastRequestTimestamp).toBe(baseline + gapMs)

    await expect(first).resolves.toMatchObject({ name: 'AbortError' })
    await expect(second).resolves.toMatchObject({ name: 'AbortError' })
    await third

    expect(state.lastRequestTimestamp).toBeGreaterThanOrEqual(baseline + gapMs - 5)
    expect(state.lastRequestTimestamp).toBeLessThanOrEqual(Date.now())
  })

  test('keeps a completed request as the baseline when a later wait is aborted', async () => {
    const gapMs = 40
    const state = makeState({
      rateLimitSeconds: gapMs / 1000,
      rateLimitWait: true,
      lastRequestTimestamp: Date.now(),
    })

    await checkRateLimit(state)
    const completedTimestamp = state.lastRequestTimestamp!
    const controller = new AbortController()
    const canceled = checkRateLimit(state, { signal: controller.signal })
      .catch((error: unknown) => error)

    expect(state.lastRequestTimestamp).toBe(completedTimestamp + gapMs)
    controller.abort()
    await expect(canceled).resolves.toMatchObject({ name: 'AbortError' })
    expect(state.lastRequestTimestamp).toBe(completedTimestamp)

    const startedAt = Date.now()
    await checkRateLimit(state)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(gapMs - 10)
  })

  test('removes abort listeners after both completion and cancellation', async () => {
    vi.useFakeTimers()
    try {
      const completedSignal = createTrackedAbortSignal()
      const state = makeState({
        rateLimitSeconds: 0.02,
        rateLimitWait: true,
        lastRequestTimestamp: Date.now(),
      })
      const baselineTimerCount = vi.getTimerCount()

      const completed = checkRateLimit(state, { signal: completedSignal.signal })
      const waitingTimerCount = vi.getTimerCount()
      expect(waitingTimerCount).toBeGreaterThan(baselineTimerCount)
      vi.advanceTimersByTime(20)
      await completed
      expect(completedSignal.addedListeners()).toBe(1)
      expect(completedSignal.removedListeners()).toBe(1)
      expect(completedSignal.activeListeners()).toBe(0)
      const settledTimerCount = vi.getTimerCount()
      expect(settledTimerCount).toBe(waitingTimerCount - 1)

      const canceledSignal = createTrackedAbortSignal()
      const canceled = checkRateLimit(state, { signal: canceledSignal.signal })
        .catch((error: unknown) => error)
      expect(vi.getTimerCount()).toBe(settledTimerCount + 1)
      canceledSignal.abort()
      await expect(canceled).resolves.toMatchObject({ name: 'AbortError' })
      expect(canceledSignal.addedListeners()).toBe(1)
      expect(canceledSignal.removedListeners()).toBe(1)
      expect(canceledSignal.activeListeners()).toBe(0)
      expect(vi.getTimerCount()).toBe(settledTimerCount)
    }
    finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  test('keeps a disabled limiter as a no-op for an aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      checkRateLimit(makeState(), { signal: controller.signal }),
    ).resolves.toBeUndefined()
  })

  test('does not consume the first slot when its signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const state = makeState({
      rateLimitSeconds: 9999,
      rateLimitWait: false,
    })
    const error = await checkRateLimit(state, { signal: controller.signal })
      .catch((error: unknown) => error)

    expect(error).toMatchObject({ name: 'AbortError' })
    expect(state.lastRequestTimestamp).toBeUndefined()
  })
})
