import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { TOKEN_RETRY_DELAYS } from '~/lib/constants'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import {
  cancelInFlightCopilotTokenRefreshes,
  getCopilotTokenLifecycleStatus,
  getCopilotTokenRefreshDelayMs,
  getCopilotTokenSnapshot,
  isCopilotTokenRefreshScheduled,
  refreshCopilotTokenAfterFailure,
  refreshTokenWithRetry,
  startCopilotTokenRefresh,
  stopCopilotTokenRefresh,
} from '~/lib/token'

describe('refreshTokenWithRetry', () => {
  let originalCopilotToken: string | undefined
  let originalShowToken: boolean

  const createFailureState = () => ({ consecutiveFailures: 0 })

  beforeEach(() => {
    stopCopilotTokenRefresh()
    originalCopilotToken = state.copilotToken
    originalShowToken = state.showToken
    state.showToken = false
  })

  afterEach(() => {
    stopCopilotTokenRefresh()
    state.copilotToken = originalCopilotToken
    state.showToken = originalShowToken
  })

  test('refreshes token on first attempt', async () => {
    const fetchToken = mock(async () => ({
      token: 'token-success',
      refresh_in: 3600,
      expires_at: Date.now() + 3600 * 1000,
    }))
    const sleepFn = mock(async (_ms: number) => {})
    const failureState = createFailureState()

    await refreshTokenWithRetry({
      fetchToken,
      sleepFn,
      failureState,
    })

    expect(fetchToken).toHaveBeenCalledTimes(1)
    expect(sleepFn).toHaveBeenCalledTimes(0)
    expect(state.copilotToken).toBe('token-success')
  })

  test('retries with configured delays before succeeding', async () => {
    let attempts = 0
    const fetchToken = mock(async () => {
      attempts++
      if (attempts < 3) {
        throw new Error(`temporary-${attempts}`)
      }
      return {
        token: 'token-after-retry',
        refresh_in: 3600,
        expires_at: Date.now() + 3600 * 1000,
      }
    })

    const sleepFn = mock(async (_ms: number) => {})
    const failureState = createFailureState()

    await refreshTokenWithRetry({
      fetchToken,
      sleepFn,
      failureState,
    })

    expect(fetchToken).toHaveBeenCalledTimes(3)
    expect(sleepFn).toHaveBeenCalledTimes(2)
    const sleepCalls = sleepFn.mock.calls as Array<[number]>
    expect(sleepCalls[0][0]).toBe(TOKEN_RETRY_DELAYS[0])
    expect(sleepCalls[1][0]).toBe(TOKEN_RETRY_DELAYS[1])
    expect(state.copilotToken).toBe('token-after-retry')
  })

  test('normalizes live epoch-second token expiration for readiness telemetry', async () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 1_800
    await refreshTokenWithRetry({
      fetchToken: async () => ({
        token: 'token-with-second-expiry',
        refresh_in: 1_500,
        expires_at: expiresAtSeconds,
      }),
      failureState: createFailureState(),
    })

    const lifecycle = getCopilotTokenLifecycleStatus()
    expect(lifecycle.expiresAt).toBe(expiresAtSeconds * 1_000)
    expect(lifecycle.expiresInMs).toBeGreaterThan(1_790_000)
    expect(lifecycle.expiresInMs).toBeLessThanOrEqual(1_800_000)
  })

  test('stops after max retries and keeps previous token', async () => {
    state.copilotToken = 'token-before-failures'
    const fetchToken = mock(async () => {
      throw new Error('always-fail')
    })
    const sleepFn = mock(async (_ms: number) => {})
    const failureState = createFailureState()

    await refreshTokenWithRetry({
      fetchToken,
      sleepFn,
      failureState,
    })

    // 1 initial attempt + 3 retries
    expect(fetchToken).toHaveBeenCalledTimes(4)
    expect(sleepFn).toHaveBeenCalledTimes(3)
    const sleepCalls = sleepFn.mock.calls as Array<[number]>
    expect(sleepCalls[0][0]).toBe(TOKEN_RETRY_DELAYS[0])
    expect(sleepCalls[1][0]).toBe(TOKEN_RETRY_DELAYS[1])
    expect(sleepCalls[2][0]).toBe(TOKEN_RETRY_DELAYS[2])
    expect(state.copilotToken).toBe('token-before-failures')
  })

  test('shares an in-flight locked refresh', async () => {
    let resolveFetch: ((value: {
      token: string
      refresh_in: number
      expires_at: number
    }) => void) | undefined
    const fetchToken = mock(() => new Promise<{
      token: string
      refresh_in: number
      expires_at: number
    }>((resolve) => {
      resolveFetch = resolve
    }))
    const failureState = createFailureState()

    const first = refreshTokenWithRetry({
      fetchToken,
      failureState,
      useLock: true,
    })
    const second = refreshTokenWithRetry({
      fetchToken,
      failureState,
      useLock: true,
    })

    resolveFetch?.({
      token: 'locked-refresh-token',
      refresh_in: 1800,
      expires_at: Date.now() + 1800 * 1000,
    })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(fetchToken).toHaveBeenCalledTimes(1)
    expect(firstResult?.token).toBe('locked-refresh-token')
    expect(secondResult?.token).toBe('locked-refresh-token')
    expect(state.copilotToken).toBe('locked-refresh-token')
  })

  test('cancels a fulfilled token fetch before its continuation can apply or reschedule it', async () => {
    state.copilotToken = 'token-before-cancel'
    const failedSnapshot = getCopilotTokenSnapshot()
    let finishFetch: (() => void) | undefined
    const fetchFinished = new Promise<void>((resolve) => {
      finishFetch = resolve
    })
    const fetchToken = mock(async (signal?: AbortSignal) => {
      expect(signal?.aborted).toBe(false)
      await fetchFinished
      return {
        token: 'late-token-after-cancel',
        refresh_in: 1800,
        expires_at: Date.now() + 1800 * 1000,
      }
    })
    const setTimeoutFn = mock((_callback: () => void, _delayMs: number) => setTimeout(() => {}, 60_000))

    const refresh = refreshCopilotTokenAfterFailure(failedSnapshot, {
      refreshDeps: { fetchToken },
      schedulerDeps: { setTimeoutFn },
    })
    expect(fetchToken).toHaveBeenCalledTimes(1)

    finishFetch?.()
    await cancelInFlightCopilotTokenRefreshes(new Error('Setup probe finished.'))
    const result = await refresh

    expect(result).toEqual({
      generation: failedSnapshot.generation,
      outcome: 'cancelled',
    })
    expect(state.copilotToken).toBe('token-before-cancel')
    expect(setTimeoutFn).toHaveBeenCalledTimes(0)
    expect(getCopilotTokenLifecycleStatus()).toMatchObject({
      lastReactiveRefreshOutcome: 'cancelled',
      reactiveRefreshInFlight: false,
      refreshScheduled: false,
    })
  })

  test('does not retry permanent token-endpoint authorization failures', async () => {
    state.copilotToken = 'token-before-permanent-failure'
    const fetchToken = mock(async () => {
      throw new HTTPError('token exchange rejected', new Response('forbidden', { status: 403 }))
    })
    const sleepFn = mock(async (_ms: number) => {})
    const failureState = createFailureState()

    const result = await refreshTokenWithRetry({
      fetchToken,
      sleepFn,
      failureState,
    })

    expect(result).toBeUndefined()
    expect(fetchToken).toHaveBeenCalledTimes(1)
    expect(sleepFn).toHaveBeenCalledTimes(0)
    expect(state.copilotToken).toBe('token-before-permanent-failure')
    expect(getCopilotTokenLifecycleStatus()).toMatchObject({
      lastRefreshFailureKind: 'permanent_auth',
      lastRefreshFailureStatus: 403,
    })
  })

  test('reactively refreshes a failed token once for concurrent callers and reschedules', async () => {
    state.copilotToken = 'failed-token-secret'
    const failedSnapshot = getCopilotTokenSnapshot()
    expect(failedSnapshot).toEqual({ generation: expect.any(Number) })
    expect(JSON.stringify(failedSnapshot)).not.toContain('failed-token-secret')
    let resolveFetch: ((value: {
      token: string
      refresh_in: number
      expires_at: number
    }) => void) | undefined
    const fetchToken = mock(() => new Promise<{
      token: string
      refresh_in: number
      expires_at: number
    }>((resolve) => {
      resolveFetch = resolve
    }))
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const delays: number[] = []
    const setTimeoutFn = (_callback: () => void, delayMs: number) => {
      delays.push(delayMs)
      const timer = setTimeout(() => {}, 60_000)
      timers.push(timer)
      return timer
    }
    const clearTimeoutFn = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
    const deps = {
      refreshDeps: { fetchToken },
      schedulerDeps: { setTimeoutFn, clearTimeoutFn },
    }

    const refreshes = Array.from(
      { length: 32 },
      () => refreshCopilotTokenAfterFailure(failedSnapshot, deps),
    )
    expect(getCopilotTokenLifecycleStatus().reactiveRefreshInFlight).toBe(true)

    resolveFetch?.({
      token: 'recovered-token-secret',
      refresh_in: 1800,
      expires_at: Date.now() + 1800 * 1000,
    })
    const results = await Promise.all(refreshes)

    expect(fetchToken).toHaveBeenCalledTimes(1)
    expect(results.every(result => result.outcome === 'refreshed')).toBe(true)
    expect(new Set(results.map(result => result.generation)).size).toBe(1)
    expect(state.copilotToken).toBe('recovered-token-secret')
    expect(delays).toEqual([getCopilotTokenRefreshDelayMs(1800)])
    expect(timers).toHaveLength(1)

    const lifecycle = getCopilotTokenLifecycleStatus()
    expect(lifecycle).toMatchObject({
      consecutiveRefreshFailures: 0,
      lastReactiveRefreshOutcome: 'refreshed',
      reactiveRefreshInFlight: false,
      refreshScheduled: true,
      tokenAvailable: true,
    })
    expect(lifecycle).not.toHaveProperty('token')
    expect(lifecycle).not.toHaveProperty('tokenHash')
    expect(JSON.stringify(lifecycle)).not.toContain('failed-token-secret')
    expect(JSON.stringify(lifecycle)).not.toContain('recovered-token-secret')

    const unnecessaryFetch = mock(async () => {
      throw new Error('stale failure must not trigger another exchange')
    })
    const alreadyRefreshed = await refreshCopilotTokenAfterFailure(failedSnapshot, {
      refreshDeps: { fetchToken: unnecessaryFetch },
      schedulerDeps: { setTimeoutFn, clearTimeoutFn },
    })
    expect(alreadyRefreshed.outcome).toBe('already_refreshed')
    expect(unnecessaryFetch).toHaveBeenCalledTimes(0)
    expect(timers).toHaveLength(1)
  })

  test('starts a new exchange when the next token fails before the prior reactive promise clears', async () => {
    state.copilotToken = 'first-failed-token'
    const firstSnapshot = getCopilotTokenSnapshot()
    let fetchCount = 0
    const fetchToken = mock(async () => {
      fetchCount++
      return {
        token: `refreshed-token-${fetchCount}`,
        refresh_in: 1800,
        expires_at: Date.now() + 1800 * 1000,
      }
    })
    const timers: Array<ReturnType<typeof setTimeout>> = []
    let nextRefresh: Promise<Awaited<ReturnType<typeof refreshCopilotTokenAfterFailure>>> | undefined
    const setTimeoutFn = (_callback: () => void, _delayMs: number) => {
      const timer = setTimeout(() => {}, 60_000)
      timers.push(timer)
      if (!nextRefresh) {
        const nextFailedSnapshot = getCopilotTokenSnapshot()
        nextRefresh = refreshCopilotTokenAfterFailure(nextFailedSnapshot, {
          refreshDeps: { fetchToken },
          schedulerDeps: { setTimeoutFn, clearTimeoutFn: clearTimeout },
        })
      }
      return timer
    }

    const firstRefresh = await refreshCopilotTokenAfterFailure(firstSnapshot, {
      refreshDeps: { fetchToken },
      schedulerDeps: { setTimeoutFn, clearTimeoutFn: clearTimeout },
    })
    const secondRefresh = await nextRefresh

    expect(firstRefresh.outcome).toBe('refreshed')
    expect(secondRefresh?.outcome).toBe('refreshed')
    expect(fetchToken).toHaveBeenCalledTimes(2)
    expect(state.copilotToken).toBe('refreshed-token-2')
    for (const timer of timers)
      clearTimeout(timer)
  })

  test('cleanup drains a successor refresh queued behind an older token generation', async () => {
    state.copilotToken = 'cleanup-failed-token'
    const failedSnapshot = getCopilotTokenSnapshot()
    const timers: Array<ReturnType<typeof setTimeout>> = []
    let fetchCount = 0
    const fetchToken = mock(async (signal?: AbortSignal) => {
      fetchCount++
      if (fetchCount > 1) {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      return {
        token: `cleanup-refreshed-token-${fetchCount}`,
        refresh_in: 1800,
        expires_at: Date.now() + 1800 * 1000,
      }
    })
    let successorRefresh: ReturnType<typeof refreshCopilotTokenAfterFailure> | undefined
    let cleanup: Promise<void> | undefined
    const clearTimeoutFn = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
    const setTimeoutFn = (_callback: () => void, _delayMs: number) => {
      const timer = setTimeout(() => {}, 60_000)
      timers.push(timer)
      if (!successorRefresh) {
        successorRefresh = refreshCopilotTokenAfterFailure(getCopilotTokenSnapshot(), {
          refreshDeps: { fetchToken },
          schedulerDeps: { setTimeoutFn, clearTimeoutFn },
        })
        cleanup = cancelInFlightCopilotTokenRefreshes(new Error('setup cleanup started'))
      }
      return timer
    }

    const firstRefresh = await refreshCopilotTokenAfterFailure(failedSnapshot, {
      refreshDeps: { fetchToken },
      schedulerDeps: { setTimeoutFn, clearTimeoutFn },
    })
    await cleanup
    const successorResult = await successorRefresh

    expect(firstRefresh.outcome).toBe('cancelled')
    expect(successorResult?.outcome).toBe('cancelled')
    expect(fetchToken).toHaveBeenCalledTimes(1)
    expect(getCopilotTokenLifecycleStatus()).toMatchObject({
      reactiveRefreshInFlight: false,
      refreshInFlight: false,
      refreshScheduled: false,
    })
    for (const timer of timers)
      clearTimeout(timer)
  })

  test('clamps token refresh delay and leaves room before expiry', () => {
    expect(getCopilotTokenRefreshDelayMs(30)).toBe(60_000)
    expect(getCopilotTokenRefreshDelayMs(3600)).toBe(3_540_000)
    expect(getCopilotTokenRefreshDelayMs(Number.NaN)).toBe(60_000)
    expect(getCopilotTokenRefreshDelayMs(48 * 60 * 60)).toBe(24 * 60 * 60 * 1000)
  })

  test('keeps a single refresh timer when startup is initialized repeatedly', () => {
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const cleared: Array<ReturnType<typeof setTimeout>> = []
    const setTimeoutFn = (_callback: () => void, _delayMs: number) => {
      const timer = setTimeout(() => {}, 60_000)
      timers.push(timer)
      return timer
    }
    const clearTimeoutFn = (timer: ReturnType<typeof setTimeout>) => {
      cleared.push(timer)
      clearTimeout(timer)
    }

    startCopilotTokenRefresh(3600, { setTimeoutFn, clearTimeoutFn })
    startCopilotTokenRefresh(1800, { setTimeoutFn, clearTimeoutFn })

    expect(timers).toHaveLength(2)
    expect(cleared).toEqual([timers[0]])
    expect(isCopilotTokenRefreshScheduled()).toBe(true)
  })

  test('retries a fully failed scheduled refresh cycle after one minute', async () => {
    const callbacks: Array<() => void> = []
    const delays: number[] = []
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const setTimeoutFn = (callback: () => void, delayMs: number) => {
      callbacks.push(callback)
      delays.push(delayMs)
      const timer = setTimeout(() => {}, 60_000)
      timers.push(timer)
      return timer
    }
    const clearTimeoutFn = (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)
    const refreshFn = mock(async () => undefined)

    startCopilotTokenRefresh(3600, { setTimeoutFn, clearTimeoutFn, refreshFn })
    expect(delays).toEqual([getCopilotTokenRefreshDelayMs(3600)])

    callbacks[0]?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([getCopilotTokenRefreshDelayMs(3600), 60_000])
    expect(timers).toHaveLength(2)
    expect(isCopilotTokenRefreshScheduled()).toBe(true)
  })
})
