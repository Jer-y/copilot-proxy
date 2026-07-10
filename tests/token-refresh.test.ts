import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { TOKEN_RETRY_DELAYS } from '~/lib/constants'
import { state } from '~/lib/state'
import {
  getCopilotTokenRefreshDelayMs,
  isCopilotTokenRefreshScheduled,
  refreshTokenWithRetry,
  startCopilotTokenRefresh,
  stopCopilotTokenRefresh,
} from '~/lib/token'

describe('refreshTokenWithRetry', () => {
  let originalCopilotToken: string | undefined
  let originalShowToken: boolean

  const createFailureState = () => ({ consecutiveFailures: 0 })

  beforeEach(() => {
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
})
