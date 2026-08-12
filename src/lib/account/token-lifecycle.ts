import type { AccountContext } from './types'
import type { GetCopilotTokenResponse } from '~/services/github/get-copilot-token'

import consola from 'consola'

import { TOKEN_MAX_RETRIES as MAX_RETRIES, TOKEN_RETRY_DELAYS as RETRY_DELAYS } from '~/lib/constants'
import { HTTPError } from '~/lib/error'
import { getCopilotToken } from '~/services/github/get-copilot-token'

interface RefreshTokenFailureState {
  consecutiveFailures: number
}

type RefreshTimer = ReturnType<typeof setTimeout>
type CopilotTokenFetcher = (signal?: AbortSignal) => Promise<GetCopilotTokenResponse>
type TokenRefreshFunction = (
  deps?: RefreshTokenWithRetryDeps,
) => Promise<GetCopilotTokenResponse | undefined>

const FAILED_REFRESH_RETRY_DELAY_MS = 60_000

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export type TokenRefreshFailureKind = 'permanent_auth' | 'transient'
export type ReactiveTokenRefreshOutcome = 'refreshed' | 'already_refreshed' | 'cancelled' | 'failed'

export interface CopilotTokenSnapshot {
  generation: number
}

export interface ReactiveTokenRefreshResult {
  generation: number
  outcome: ReactiveTokenRefreshOutcome
}

export interface CopilotTokenLifecycleStatus {
  consecutiveRefreshFailures: number
  expiresAt?: number
  expiresInMs?: number
  generation: number
  lastReactiveRefreshAt?: number
  lastReactiveRefreshOutcome?: ReactiveTokenRefreshOutcome
  lastRefreshAttemptAt?: number
  lastRefreshFailureAt?: number
  lastRefreshFailureKind?: TokenRefreshFailureKind
  lastRefreshFailureStatus?: number
  lastRefreshSuccessAt?: number
  nextRefreshAt?: number
  reactiveRefreshInFlight: boolean
  refreshInFlight: boolean
  refreshScheduled: boolean
  tokenAvailable: boolean
}

interface MutableTokenLifecycleStatus {
  consecutiveRefreshFailures: number
  expiresAt?: number
  generation: number
  lastReactiveRefreshAt?: number
  lastReactiveRefreshOutcome?: ReactiveTokenRefreshOutcome
  lastRefreshAttemptAt?: number
  lastRefreshFailureAt?: number
  lastRefreshFailureKind?: TokenRefreshFailureKind
  lastRefreshFailureStatus?: number
  lastRefreshSuccessAt?: number
}

export interface RefreshTokenWithRetryDeps {
  fetchToken?: CopilotTokenFetcher
  signal?: AbortSignal
  sleepFn?: typeof sleep
  failureState?: RefreshTokenFailureState
  useLock?: boolean
}

export interface ReactiveTokenRefreshDeps {
  refreshDeps?: Omit<RefreshTokenWithRetryDeps, 'useLock'>
  schedulerDeps?: TokenRefreshSchedulerDeps
}

export interface TokenRefreshSchedulerDeps {
  setTimeoutFn?: (callback: () => void, delayMs: number) => RefreshTimer
  clearTimeoutFn?: (timer: RefreshTimer) => void
  refreshFn?: TokenRefreshFunction
}

export interface TokenLifecycleOptions {
  showToken?: () => boolean
  refreshDelay?: (delayMs: number) => number
}

export class TokenLifecycle {
  private readonly ctx: AccountContext
  private readonly refreshTokenFailureState: RefreshTokenFailureState = {
    consecutiveFailures: 0,
  }

  private readonly tokenLifecycleStatus: MutableTokenLifecycleStatus = {
    consecutiveRefreshFailures: 0,
    generation: 0,
  }

  private refreshInFlight: Promise<GetCopilotTokenResponse | undefined> | undefined
  private refreshInFlightAbortController: AbortController | undefined
  private copilotTokenRefreshTimer: RefreshTimer | undefined
  private clearCopilotTokenRefreshTimer: ((timer: RefreshTimer) => void) | undefined
  private copilotTokenRefreshGeneration = 0
  private copilotTokenRefreshScheduledForTokenGeneration: number | undefined
  private nextCopilotTokenRefreshAt: number | undefined
  private reactiveRefreshInFlight: Promise<ReactiveTokenRefreshResult> | undefined
  private reactiveRefreshAbortController: AbortController | undefined
  private reactiveRefreshFailedGeneration: number | undefined
  private tokenRefreshCancellationEpoch = 0
  private tokenRefreshCancellationInFlight: Promise<void> | undefined
  private lastKnownRefreshInSeconds: number | undefined
  private readonly copilotTokenSnapshotValues = new WeakMap<CopilotTokenSnapshot, string | undefined>()
  private showToken: () => boolean
  private refreshDelay: (delayMs: number) => number

  constructor(ctx: AccountContext, options: TokenLifecycleOptions = {}) {
    this.ctx = ctx
    this.showToken = options.showToken ?? (() => false)
    this.refreshDelay = options.refreshDelay ?? (delayMs => delayMs)
  }

  configure(options: TokenLifecycleOptions): void {
    if (options.showToken)
      this.showToken = options.showToken
    if (options.refreshDelay)
      this.refreshDelay = options.refreshDelay
  }

  getSnapshot(): CopilotTokenSnapshot {
    const snapshot = {
      generation: this.tokenLifecycleStatus.generation,
    }
    this.copilotTokenSnapshotValues.set(snapshot, this.ctx.copilotToken)
    return snapshot
  }

  getStatus(now = Date.now()): CopilotTokenLifecycleStatus {
    return {
      ...this.tokenLifecycleStatus,
      expiresInMs: this.tokenLifecycleStatus.expiresAt === undefined
        ? undefined
        : Math.max(0, this.tokenLifecycleStatus.expiresAt - now),
      nextRefreshAt: this.nextCopilotTokenRefreshAt,
      reactiveRefreshInFlight: this.reactiveRefreshInFlight !== undefined,
      refreshInFlight: this.refreshInFlight !== undefined,
      refreshScheduled: this.copilotTokenRefreshTimer !== undefined,
      tokenAvailable: Boolean(this.ctx.copilotToken),
    }
  }

  async refreshAfterFailure(
    failedSnapshot: CopilotTokenSnapshot,
    deps: ReactiveTokenRefreshDeps = {},
  ): Promise<ReactiveTokenRefreshResult> {
    const cancellationEpoch = this.tokenRefreshCancellationEpoch
    if (!this.matchesCurrentTokenSnapshot(failedSnapshot)) {
      return {
        generation: this.tokenLifecycleStatus.generation,
        outcome: 'already_refreshed',
      }
    }

    if (this.tokenRefreshCancellationInFlight)
      return this.recordReactiveTokenRefreshOutcome('cancelled')

    if (this.reactiveRefreshInFlight) {
      if (this.reactiveRefreshFailedGeneration === failedSnapshot.generation)
        return this.reactiveRefreshInFlight
      await this.reactiveRefreshInFlight
      if (
        this.tokenRefreshCancellationInFlight
        || cancellationEpoch !== this.tokenRefreshCancellationEpoch
      ) {
        return this.recordReactiveTokenRefreshOutcome('cancelled')
      }
      return await this.refreshAfterFailure(failedSnapshot, deps)
    }

    this.tokenLifecycleStatus.lastReactiveRefreshAt = Date.now()
    const refreshAbortController = new AbortController()
    this.reactiveRefreshAbortController = refreshAbortController
    this.reactiveRefreshFailedGeneration = failedSnapshot.generation
    const refresh = this.performReactiveTokenRefresh({
      ...deps,
      refreshDeps: {
        ...deps.refreshDeps,
        signal: deps.refreshDeps?.signal
          ? AbortSignal.any([deps.refreshDeps.signal, refreshAbortController.signal])
          : refreshAbortController.signal,
      },
    })
    const trackedRefresh = refresh.finally(() => {
      if (this.reactiveRefreshInFlight === trackedRefresh) {
        this.reactiveRefreshInFlight = undefined
        this.reactiveRefreshFailedGeneration = undefined
      }
      if (this.reactiveRefreshAbortController === refreshAbortController)
        this.reactiveRefreshAbortController = undefined
    })
    this.reactiveRefreshInFlight = trackedRefresh
    return trackedRefresh
  }

  cancelInFlight(
    reason: Error = new Error('Disposable Copilot token refresh was cancelled.'),
  ): Promise<void> {
    if (this.tokenRefreshCancellationInFlight) {
      this.reactiveRefreshAbortController?.abort(reason)
      this.refreshInFlightAbortController?.abort(reason)
      return this.tokenRefreshCancellationInFlight
    }

    this.tokenRefreshCancellationEpoch++
    const cancellation = this.drainInFlightCopilotTokenRefreshes(reason)
    const trackedCancellation = cancellation.finally(() => {
      if (this.tokenRefreshCancellationInFlight === trackedCancellation)
        this.tokenRefreshCancellationInFlight = undefined
    })
    this.tokenRefreshCancellationInFlight = trackedCancellation
    return trackedCancellation
  }

  async refreshWithRetry(
    deps: RefreshTokenWithRetryDeps = {},
  ): Promise<GetCopilotTokenResponse | undefined> {
    const useLock = deps.useLock ?? (
      deps.fetchToken === undefined
      && deps.sleepFn === undefined
      && deps.failureState === undefined
    )

    if (useLock) {
      if (this.refreshInFlight)
        return this.refreshInFlight

      const refreshAbortController = new AbortController()
      this.refreshInFlightAbortController = refreshAbortController
      this.refreshInFlight = this.refreshTokenWithRetryUnlocked({
        ...deps,
        signal: deps.signal
          ? AbortSignal.any([deps.signal, refreshAbortController.signal])
          : refreshAbortController.signal,
      })
        .finally(() => {
          this.refreshInFlight = undefined
          if (this.refreshInFlightAbortController === refreshAbortController)
            this.refreshInFlightAbortController = undefined
        })
      return this.refreshInFlight
    }

    return this.refreshTokenWithRetryUnlocked(deps)
  }

  async setup(
    options: { scheduleRefresh?: boolean } = {},
  ): Promise<GetCopilotTokenResponse> {
    const response = await getCopilotToken(this.ctx)
    const { token, refresh_in: refreshIn } = response
    this.applyCopilotTokenResponse(response)

    consola.debug('GitHub Copilot Token fetched successfully!')
    if (this.showToken())
      consola.info('Copilot token:', token)

    if (options.scheduleRefresh ?? true)
      this.startRefresh(refreshIn)

    return response
  }

  startRefresh(
    refreshInSeconds: number,
    deps: TokenRefreshSchedulerDeps = {},
  ): void {
    this.lastKnownRefreshInSeconds = refreshInSeconds
    const delayMs = this.refreshDelay(getCopilotTokenRefreshDelayMs(refreshInSeconds))
    this.scheduleCopilotTokenRefresh(refreshInSeconds, delayMs, deps)
  }

  stopRefresh(): void {
    this.copilotTokenRefreshGeneration++
    if (this.copilotTokenRefreshTimer !== undefined) {
      const clearTimeoutFn = this.clearCopilotTokenRefreshTimer ?? clearTimeout
      clearTimeoutFn(this.copilotTokenRefreshTimer)
      this.copilotTokenRefreshTimer = undefined
    }
    this.clearCopilotTokenRefreshTimer = undefined
    this.copilotTokenRefreshScheduledForTokenGeneration = undefined
    this.nextCopilotTokenRefreshAt = undefined
  }

  isRefreshScheduled(): boolean {
    return this.copilotTokenRefreshTimer !== undefined
  }

  private async drainInFlightCopilotTokenRefreshes(reason: Error): Promise<void> {
    while (true) {
      const refreshes = new Set<Promise<unknown>>()
      if (this.reactiveRefreshInFlight)
        refreshes.add(this.reactiveRefreshInFlight)
      if (this.refreshInFlight)
        refreshes.add(this.refreshInFlight)
      if (refreshes.size === 0)
        return
      this.reactiveRefreshAbortController?.abort(reason)
      this.refreshInFlightAbortController?.abort(reason)
      await Promise.all(refreshes)
    }
  }

  private matchesCurrentTokenSnapshot(snapshot: CopilotTokenSnapshot): boolean {
    return snapshot.generation === this.tokenLifecycleStatus.generation
      && this.copilotTokenSnapshotValues.has(snapshot)
      && this.copilotTokenSnapshotValues.get(snapshot) === this.ctx.copilotToken
  }

  private async performReactiveTokenRefresh(
    deps: ReactiveTokenRefreshDeps,
  ): Promise<ReactiveTokenRefreshResult> {
    try {
      const refreshed = await this.refreshWithRetry({
        ...deps.refreshDeps,
        useLock: true,
      })
      if (deps.refreshDeps?.signal?.aborted)
        return this.recordReactiveTokenRefreshOutcome('cancelled')
      if (!refreshed) {
        this.scheduleCopilotTokenRefreshAfterFailure(
          this.lastKnownRefreshInSeconds ?? 3600,
          deps.schedulerDeps,
          this.tokenLifecycleStatus.lastRefreshFailureKind ?? 'transient',
        )
        return this.recordReactiveTokenRefreshOutcome('failed')
      }

      this.ensureCopilotTokenRefreshScheduled(refreshed.refresh_in, deps.schedulerDeps)
      if (deps.refreshDeps?.signal?.aborted) {
        this.stopRefresh()
        return this.recordReactiveTokenRefreshOutcome('cancelled')
      }
      return this.recordReactiveTokenRefreshOutcome('refreshed')
    }
    catch (error) {
      if (deps.refreshDeps?.signal?.aborted)
        return this.recordReactiveTokenRefreshOutcome('cancelled')
      consola.error('Unexpected reactive Copilot token refresh failure:', error)
      return this.recordReactiveTokenRefreshOutcome('failed')
    }
  }

  private recordReactiveTokenRefreshOutcome(
    outcome: ReactiveTokenRefreshOutcome,
  ): ReactiveTokenRefreshResult {
    this.tokenLifecycleStatus.lastReactiveRefreshOutcome = outcome
    return {
      generation: this.tokenLifecycleStatus.generation,
      outcome,
    }
  }

  private async refreshTokenWithRetryUnlocked(
    deps: RefreshTokenWithRetryDeps = {},
  ): Promise<GetCopilotTokenResponse | undefined> {
    const fetchToken = deps.fetchToken ?? (signal => getCopilotToken(this.ctx, signal))
    const sleepFn = deps.sleepFn ?? sleep
    const failureState = deps.failureState ?? this.refreshTokenFailureState
    let attemptsMade = 0
    let lastFailureKind: TokenRefreshFailureKind = 'transient'
    let lastFailureStatus: number | undefined

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (deps.signal?.aborted)
        return undefined
      attemptsMade++
      this.tokenLifecycleStatus.lastRefreshAttemptAt = Date.now()
      try {
        const response = await fetchToken(deps.signal)
        if (deps.signal?.aborted) {
          consola.debug('Copilot token refresh was cancelled before completion')
          return undefined
        }
        this.applyCopilotTokenResponse(response)
        consola.debug('Copilot token refreshed')
        if (this.showToken())
          consola.info('Refreshed Copilot token:', response.token)
        if (failureState.consecutiveFailures > 0) {
          consola.info(`Token refresh recovered after ${failureState.consecutiveFailures} consecutive failure(s)`)
        }
        failureState.consecutiveFailures = 0
        return response
      }
      catch (error) {
        if (deps.signal?.aborted) {
          consola.debug('Copilot token refresh was cancelled before completion')
          return undefined
        }
        lastFailureKind = classifyTokenRefreshError(error)
        lastFailureStatus = error instanceof HTTPError ? error.response.status : undefined
        if (lastFailureKind === 'permanent_auth') {
          consola.error('Copilot token refresh rejected by the token endpoint; retries for this refresh cycle are suppressed.', error)
          break
        }
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS.at(-1)!
          consola.warn(`Token refresh attempt ${attempt + 1} failed, retrying in ${delay}ms...`, error)
          await waitForTokenRefreshRetry(delay, sleepFn, deps.signal)
          if (deps.signal?.aborted)
            return undefined
        }
      }
    }

    failureState.consecutiveFailures++
    this.tokenLifecycleStatus.consecutiveRefreshFailures++
    this.tokenLifecycleStatus.lastRefreshFailureAt = Date.now()
    this.tokenLifecycleStatus.lastRefreshFailureKind = lastFailureKind
    this.tokenLifecycleStatus.lastRefreshFailureStatus = lastFailureStatus
    consola.error(
      `Token refresh failed after ${attemptsMade} attempt(s)`
      + ` (${failureState.consecutiveFailures} consecutive interval failure(s)).`
      + ` Service may be using a stale token.`,
    )
    return undefined
  }

  private applyCopilotTokenResponse(response: GetCopilotTokenResponse): void {
    this.ctx.copilotToken = response.token
    this.lastKnownRefreshInSeconds = response.refresh_in
    this.tokenLifecycleStatus.expiresAt = normalizeTokenExpiration(response.expires_at)
    this.tokenLifecycleStatus.generation++
    this.tokenLifecycleStatus.consecutiveRefreshFailures = 0
    this.tokenLifecycleStatus.lastRefreshSuccessAt = Date.now()
  }

  private scheduleCopilotTokenRefresh(
    refreshInSeconds: number,
    refreshDelayMs: number,
    deps: TokenRefreshSchedulerDeps,
  ): void {
    this.stopRefresh()
    const generation = this.copilotTokenRefreshGeneration

    const setTimeoutFn = deps.setTimeoutFn ?? setTimeout
    const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout
    const usingDefaultRefresh = deps.refreshFn === undefined
    const refreshFn = deps.refreshFn ?? (refreshDeps => this.refreshWithRetry(refreshDeps))
    this.clearCopilotTokenRefreshTimer = clearTimeoutFn
    const timer = setTimeoutFn(() => {
      this.copilotTokenRefreshTimer = undefined
      this.copilotTokenRefreshScheduledForTokenGeneration = undefined
      this.nextCopilotTokenRefreshAt = undefined
      consola.debug('Refreshing Copilot token')
      void refreshFn().then((refreshed) => {
        if (generation !== this.copilotTokenRefreshGeneration)
          return
        if (refreshed) {
          this.ensureCopilotTokenRefreshScheduled(refreshed.refresh_in, deps)
        }
        else {
          const failureKind = usingDefaultRefresh
            ? this.tokenLifecycleStatus.lastRefreshFailureKind ?? 'transient'
            : 'transient'
          this.scheduleCopilotTokenRefreshAfterFailure(refreshInSeconds, deps, failureKind)
        }
      }).catch((error) => {
        consola.error('Unexpected Copilot token refresh failure:', error)
        if (generation === this.copilotTokenRefreshGeneration) {
          this.scheduleCopilotTokenRefresh(
            refreshInSeconds,
            FAILED_REFRESH_RETRY_DELAY_MS,
            deps,
          )
        }
      })
    }, refreshDelayMs)
    this.copilotTokenRefreshTimer = timer
    this.copilotTokenRefreshScheduledForTokenGeneration = this.tokenLifecycleStatus.generation
    this.nextCopilotTokenRefreshAt = Date.now() + refreshDelayMs
    timer.unref?.()
  }

  private scheduleCopilotTokenRefreshAfterFailure(
    refreshInSeconds: number,
    deps: TokenRefreshSchedulerDeps = {},
    failureKind: TokenRefreshFailureKind,
  ): void {
    const retryDelayMs = failureKind === 'permanent_auth'
      ? this.refreshDelay(getCopilotTokenRefreshDelayMs(refreshInSeconds))
      : FAILED_REFRESH_RETRY_DELAY_MS
    this.scheduleCopilotTokenRefresh(refreshInSeconds, retryDelayMs, deps)
  }

  private ensureCopilotTokenRefreshScheduled(
    refreshInSeconds: number,
    deps: TokenRefreshSchedulerDeps = {},
  ): void {
    if (
      this.copilotTokenRefreshTimer !== undefined
      && this.copilotTokenRefreshScheduledForTokenGeneration === this.tokenLifecycleStatus.generation
    ) {
      return
    }
    this.startRefresh(refreshInSeconds, deps)
  }
}

export function getCopilotTokenRefreshDelayMs(refreshInSeconds: number): number {
  const rawInterval = (refreshInSeconds - 60) * 1000
  const MAX_REFRESH_MS = 24 * 60 * 60 * 1000
  return Number.isFinite(rawInterval)
    ? Math.min(Math.max(rawInterval, 60_000), MAX_REFRESH_MS)
    : 60_000
}

async function waitForTokenRefreshRetry(
  delayMs: number,
  sleepFn: typeof sleep,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal || sleepFn !== sleep) {
    await sleepFn(delayMs)
    return
  }
  if (signal.aborted)
    return

  await new Promise<void>((resolve) => {
    let settled = false
    let onAbort = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled)
        return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    onAbort = () => {
      if (timer !== undefined)
        clearTimeout(timer)
      finish()
    }
    timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted)
      onAbort()
  })
}

function classifyTokenRefreshError(error: unknown): TokenRefreshFailureKind {
  if (error instanceof HTTPError && (error.response.status === 401 || error.response.status === 403))
    return 'permanent_auth'
  return 'transient'
}

function normalizeTokenExpiration(expiresAt: number): number | undefined {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0)
    return undefined
  return expiresAt < 1_000_000_000_000
    ? expiresAt * 1_000
    : expiresAt
}
