import type { GetCopilotTokenResponse } from '~/services/github/get-copilot-token'
import type { DeviceCodeResponse } from '~/services/github/get-device-code'
import fs from 'node:fs/promises'
import consola from 'consola'

import { writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'
import { PATHS } from '~/lib/paths'
import { getCopilotToken } from '~/services/github/get-copilot-token'
import { getDeviceCode } from '~/services/github/get-device-code'
import { getGitHubUser } from '~/services/github/get-user'
import { pollAccessToken } from '~/services/github/poll-access-token'

import { TOKEN_MAX_RETRIES as MAX_RETRIES, TOKEN_RETRY_DELAYS as RETRY_DELAYS } from './constants'
import { HTTPError } from './error'
import { state } from './state'
import { sleep } from './utils'

const readGithubToken = async () => (await fs.readFile(PATHS.GITHUB_TOKEN_PATH, 'utf8')).trim()

export function writeGithubTokenFile(filePath: string, token: string): Promise<void> {
  const normalizedToken = token.trim()
  if (!normalizedToken)
    throw new Error('GitHub token cannot be empty')
  writeOwnerOnlyFileAtomically(filePath, normalizedToken)
  return Promise.resolve()
}

function writeGithubToken(token: string) {
  return writeGithubTokenFile(PATHS.GITHUB_TOKEN_PATH, token)
}

export function redactDeviceCodeResponse(response: DeviceCodeResponse): DeviceCodeResponse {
  return {
    ...response,
    device_code: '<redacted>',
  }
}

interface RefreshTokenFailureState {
  consecutiveFailures: number
}

const refreshTokenFailureState: RefreshTokenFailureState = {
  consecutiveFailures: 0,
}

export interface RefreshTokenWithRetryDeps {
  fetchToken?: typeof getCopilotToken
  sleepFn?: typeof sleep
  failureState?: RefreshTokenFailureState
  useLock?: boolean
}

let refreshInFlight: Promise<GetCopilotTokenResponse | undefined> | undefined
type RefreshTimer = ReturnType<typeof setTimeout>

const FAILED_REFRESH_RETRY_DELAY_MS = 60_000

export type TokenRefreshFailureKind = 'permanent_auth' | 'transient'
export type ReactiveTokenRefreshOutcome = 'refreshed' | 'already_refreshed' | 'failed'

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

const tokenLifecycleStatus: MutableTokenLifecycleStatus = {
  consecutiveRefreshFailures: 0,
  generation: 0,
}

export interface ReactiveTokenRefreshDeps {
  refreshDeps?: Omit<RefreshTokenWithRetryDeps, 'useLock'>
  schedulerDeps?: TokenRefreshSchedulerDeps
}

export interface TokenRefreshSchedulerDeps {
  setTimeoutFn?: (callback: () => void, delayMs: number) => RefreshTimer
  clearTimeoutFn?: (timer: RefreshTimer) => void
  refreshFn?: typeof refreshTokenWithRetry
}

let copilotTokenRefreshTimer: RefreshTimer | undefined
let clearCopilotTokenRefreshTimer: ((timer: RefreshTimer) => void) | undefined
let copilotTokenRefreshGeneration = 0
let copilotTokenRefreshScheduledForTokenGeneration: number | undefined
let nextCopilotTokenRefreshAt: number | undefined
let reactiveRefreshInFlight: Promise<ReactiveTokenRefreshResult> | undefined
let lastKnownRefreshInSeconds: number | undefined
const copilotTokenSnapshotValues = new WeakMap<CopilotTokenSnapshot, string | undefined>()

export function getCopilotTokenSnapshot(): CopilotTokenSnapshot {
  const snapshot = {
    generation: tokenLifecycleStatus.generation,
  }
  copilotTokenSnapshotValues.set(snapshot, state.copilotToken)
  return snapshot
}

export function getCopilotTokenLifecycleStatus(now = Date.now()): CopilotTokenLifecycleStatus {
  return {
    ...tokenLifecycleStatus,
    expiresInMs: tokenLifecycleStatus.expiresAt === undefined
      ? undefined
      : Math.max(0, tokenLifecycleStatus.expiresAt - now),
    nextRefreshAt: nextCopilotTokenRefreshAt,
    reactiveRefreshInFlight: reactiveRefreshInFlight !== undefined,
    refreshInFlight: refreshInFlight !== undefined,
    refreshScheduled: copilotTokenRefreshTimer !== undefined,
    tokenAvailable: Boolean(state.copilotToken),
  }
}

export async function refreshCopilotTokenAfterFailure(
  failedSnapshot: CopilotTokenSnapshot,
  deps: ReactiveTokenRefreshDeps = {},
): Promise<ReactiveTokenRefreshResult> {
  if (!matchesCurrentTokenSnapshot(failedSnapshot)) {
    return {
      generation: tokenLifecycleStatus.generation,
      outcome: 'already_refreshed',
    }
  }

  if (reactiveRefreshInFlight)
    return reactiveRefreshInFlight

  tokenLifecycleStatus.lastReactiveRefreshAt = Date.now()
  reactiveRefreshInFlight = performReactiveTokenRefresh(deps)
    .finally(() => {
      reactiveRefreshInFlight = undefined
    })
  return reactiveRefreshInFlight
}

function matchesCurrentTokenSnapshot(snapshot: CopilotTokenSnapshot): boolean {
  return snapshot.generation === tokenLifecycleStatus.generation
    && copilotTokenSnapshotValues.has(snapshot)
    && copilotTokenSnapshotValues.get(snapshot) === state.copilotToken
}

async function performReactiveTokenRefresh(
  deps: ReactiveTokenRefreshDeps,
): Promise<ReactiveTokenRefreshResult> {
  try {
    const refreshed = await refreshTokenWithRetry({
      ...deps.refreshDeps,
      useLock: true,
    })
    if (!refreshed) {
      scheduleCopilotTokenRefreshAfterFailure(
        lastKnownRefreshInSeconds ?? 3600,
        deps.schedulerDeps,
        tokenLifecycleStatus.lastRefreshFailureKind ?? 'transient',
      )
      return recordReactiveTokenRefreshOutcome('failed')
    }

    ensureCopilotTokenRefreshScheduled(refreshed.refresh_in, deps.schedulerDeps)
    return recordReactiveTokenRefreshOutcome('refreshed')
  }
  catch (error) {
    consola.error('Unexpected reactive Copilot token refresh failure:', error)
    return recordReactiveTokenRefreshOutcome('failed')
  }
}

function recordReactiveTokenRefreshOutcome(outcome: ReactiveTokenRefreshOutcome): ReactiveTokenRefreshResult {
  tokenLifecycleStatus.lastReactiveRefreshOutcome = outcome
  return {
    generation: tokenLifecycleStatus.generation,
    outcome,
  }
}

export async function refreshTokenWithRetry(deps: RefreshTokenWithRetryDeps = {}): Promise<GetCopilotTokenResponse | undefined> {
  const useLock = deps.useLock ?? (
    deps.fetchToken === undefined
    && deps.sleepFn === undefined
    && deps.failureState === undefined
  )

  if (useLock) {
    if (refreshInFlight)
      return refreshInFlight

    refreshInFlight = refreshTokenWithRetryUnlocked(deps)
      .finally(() => {
        refreshInFlight = undefined
      })
    return refreshInFlight
  }

  return refreshTokenWithRetryUnlocked(deps)
}

async function refreshTokenWithRetryUnlocked(deps: RefreshTokenWithRetryDeps = {}): Promise<GetCopilotTokenResponse | undefined> {
  const fetchToken = deps.fetchToken ?? getCopilotToken
  const sleepFn = deps.sleepFn ?? sleep
  const failureState = deps.failureState ?? refreshTokenFailureState
  let attemptsMade = 0
  let lastFailureKind: TokenRefreshFailureKind = 'transient'
  let lastFailureStatus: number | undefined

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    attemptsMade++
    tokenLifecycleStatus.lastRefreshAttemptAt = Date.now()
    try {
      const response = await fetchToken()
      applyCopilotTokenResponse(response)
      consola.debug('Copilot token refreshed')
      if (state.showToken) {
        consola.info('Refreshed Copilot token:', response.token)
      }
      if (failureState.consecutiveFailures > 0) {
        consola.info(`Token refresh recovered after ${failureState.consecutiveFailures} consecutive failure(s)`)
      }
      failureState.consecutiveFailures = 0
      return response
    }
    catch (error) {
      lastFailureKind = classifyTokenRefreshError(error)
      lastFailureStatus = error instanceof HTTPError ? error.response.status : undefined
      if (lastFailureKind === 'permanent_auth') {
        consola.error('Copilot token refresh rejected by the token endpoint; retries for this refresh cycle are suppressed.', error)
        break
      }
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS.at(-1)!
        consola.warn(`Token refresh attempt ${attempt + 1} failed, retrying in ${delay}ms...`, error)
        await sleepFn(delay)
      }
    }
  }

  failureState.consecutiveFailures++
  tokenLifecycleStatus.consecutiveRefreshFailures++
  tokenLifecycleStatus.lastRefreshFailureAt = Date.now()
  tokenLifecycleStatus.lastRefreshFailureKind = lastFailureKind
  tokenLifecycleStatus.lastRefreshFailureStatus = lastFailureStatus
  consola.error(
    `Token refresh failed after ${attemptsMade} attempt(s)`
    + ` (${failureState.consecutiveFailures} consecutive interval failure(s)).`
    + ` Service may be using a stale token.`,
  )
  return undefined
}

function classifyTokenRefreshError(error: unknown): TokenRefreshFailureKind {
  if (error instanceof HTTPError && (error.response.status === 401 || error.response.status === 403))
    return 'permanent_auth'
  return 'transient'
}

function applyCopilotTokenResponse(response: GetCopilotTokenResponse): void {
  state.copilotToken = response.token
  lastKnownRefreshInSeconds = response.refresh_in
  tokenLifecycleStatus.expiresAt = normalizeTokenExpiration(response.expires_at)
  tokenLifecycleStatus.generation++
  tokenLifecycleStatus.consecutiveRefreshFailures = 0
  tokenLifecycleStatus.lastRefreshSuccessAt = Date.now()
}

function normalizeTokenExpiration(expiresAt: number): number | undefined {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0)
    return undefined
  return expiresAt < 1_000_000_000_000
    ? expiresAt * 1_000
    : expiresAt
}

export async function setupCopilotToken(
  options: { scheduleRefresh?: boolean } = {},
): Promise<GetCopilotTokenResponse> {
  const response = await getCopilotToken()
  const { token, refresh_in } = response
  applyCopilotTokenResponse(response)

  // Display the Copilot token to the screen
  consola.debug('GitHub Copilot Token fetched successfully!')
  if (state.showToken) {
    consola.info('Copilot token:', token)
  }

  if (options.scheduleRefresh ?? true)
    startCopilotTokenRefresh(refresh_in)

  return response
}

export function getCopilotTokenRefreshDelayMs(refreshInSeconds: number): number {
  const rawInterval = (refreshInSeconds - 60) * 1000
  // Clamp to [60s, 24h] to prevent timer issues with extreme values
  const MAX_REFRESH_MS = 24 * 60 * 60 * 1000
  return Number.isFinite(rawInterval)
    ? Math.min(Math.max(rawInterval, 60_000), MAX_REFRESH_MS)
    : 60_000
}

export function startCopilotTokenRefresh(
  refreshInSeconds: number,
  deps: TokenRefreshSchedulerDeps = {},
): void {
  lastKnownRefreshInSeconds = refreshInSeconds
  scheduleCopilotTokenRefresh(refreshInSeconds, getCopilotTokenRefreshDelayMs(refreshInSeconds), deps)
}

function scheduleCopilotTokenRefresh(
  refreshInSeconds: number,
  refreshDelayMs: number,
  deps: TokenRefreshSchedulerDeps,
): void {
  stopCopilotTokenRefresh()
  const generation = copilotTokenRefreshGeneration

  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout
  const refreshFn = deps.refreshFn ?? refreshTokenWithRetry
  clearCopilotTokenRefreshTimer = clearTimeoutFn
  const timer = setTimeoutFn(() => {
    copilotTokenRefreshTimer = undefined
    copilotTokenRefreshScheduledForTokenGeneration = undefined
    nextCopilotTokenRefreshAt = undefined
    consola.debug('Refreshing Copilot token')
    void refreshFn().then((refreshed) => {
      if (generation !== copilotTokenRefreshGeneration)
        return
      if (refreshed) {
        ensureCopilotTokenRefreshScheduled(refreshed.refresh_in, deps)
      }
      else {
        const failureKind = refreshFn === refreshTokenWithRetry
          ? tokenLifecycleStatus.lastRefreshFailureKind ?? 'transient'
          : 'transient'
        scheduleCopilotTokenRefreshAfterFailure(refreshInSeconds, deps, failureKind)
      }
    }).catch((error) => {
      consola.error('Unexpected Copilot token refresh failure:', error)
      if (generation === copilotTokenRefreshGeneration)
        scheduleCopilotTokenRefresh(refreshInSeconds, FAILED_REFRESH_RETRY_DELAY_MS, deps)
    })
  }, refreshDelayMs)
  copilotTokenRefreshTimer = timer
  copilotTokenRefreshScheduledForTokenGeneration = tokenLifecycleStatus.generation
  nextCopilotTokenRefreshAt = Date.now() + refreshDelayMs
  timer.unref?.()
}

function scheduleCopilotTokenRefreshAfterFailure(
  refreshInSeconds: number,
  deps: TokenRefreshSchedulerDeps = {},
  failureKind: TokenRefreshFailureKind,
): void {
  const retryDelayMs = failureKind === 'permanent_auth'
    ? getCopilotTokenRefreshDelayMs(refreshInSeconds)
    : FAILED_REFRESH_RETRY_DELAY_MS
  scheduleCopilotTokenRefresh(refreshInSeconds, retryDelayMs, deps)
}

function ensureCopilotTokenRefreshScheduled(
  refreshInSeconds: number,
  deps: TokenRefreshSchedulerDeps = {},
): void {
  if (
    copilotTokenRefreshTimer !== undefined
    && copilotTokenRefreshScheduledForTokenGeneration === tokenLifecycleStatus.generation
  ) {
    return
  }
  startCopilotTokenRefresh(refreshInSeconds, deps)
}

export function stopCopilotTokenRefresh(): void {
  copilotTokenRefreshGeneration++
  if (copilotTokenRefreshTimer !== undefined) {
    const clearTimeoutFn = clearCopilotTokenRefreshTimer ?? clearTimeout
    clearTimeoutFn(copilotTokenRefreshTimer)
    copilotTokenRefreshTimer = undefined
  }
  clearCopilotTokenRefreshTimer = undefined
  copilotTokenRefreshScheduledForTokenGeneration = undefined
  nextCopilotTokenRefreshAt = undefined
}

export function isCopilotTokenRefreshScheduled(): boolean {
  return copilotTokenRefreshTimer !== undefined
}

interface SetupGitHubTokenOptions {
  force?: boolean
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.githubToken = githubToken
      if (state.showToken) {
        consola.info('GitHub token:', githubToken)
      }
      await tryLogUser()

      return
    }

    consola.info('Not logged in, getting new access token')
    const response = await getDeviceCode()
    consola.debug('Device code response:', redactDeviceCodeResponse(response))

    consola.info(
      `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
    )

    const token = await pollAccessToken(response)
    await writeGithubToken(token)
    state.githubToken = token

    if (state.showToken) {
      consola.info('GitHub token:', token)
    }
    await tryLogUser()
  }
  catch (error) {
    if (error instanceof HTTPError) {
      consola.error('Failed to get GitHub token:', await error.json())
      throw error
    }

    consola.error('Failed to get GitHub token:', error)
    throw error
  }
}

async function logUser() {
  const user = await getGitHubUser()
  consola.info(`Logged in as ${user.login}`)
}

async function tryLogUser() {
  try {
    await logUser()
  }
  catch (error) {
    consola.warn('Failed to fetch GitHub user profile for startup logging; continuing with the cached token.', error)
  }
}
