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

interface RefreshTokenWithRetryDeps {
  fetchToken?: typeof getCopilotToken
  sleepFn?: typeof sleep
  failureState?: RefreshTokenFailureState
  useLock?: boolean
}

let refreshInFlight: Promise<GetCopilotTokenResponse | undefined> | undefined
type RefreshTimer = ReturnType<typeof setTimeout>

export interface TokenRefreshSchedulerDeps {
  setTimeoutFn?: (callback: () => void, delayMs: number) => RefreshTimer
  clearTimeoutFn?: (timer: RefreshTimer) => void
  refreshFn?: typeof refreshTokenWithRetry
}

let copilotTokenRefreshTimer: RefreshTimer | undefined
let clearCopilotTokenRefreshTimer: ((timer: RefreshTimer) => void) | undefined
let copilotTokenRefreshGeneration = 0

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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchToken()
      const { token } = response
      state.copilotToken = token
      consola.debug('Copilot token refreshed')
      if (state.showToken) {
        consola.info('Refreshed Copilot token:', token)
      }
      if (failureState.consecutiveFailures > 0) {
        consola.info(`Token refresh recovered after ${failureState.consecutiveFailures} consecutive failure(s)`)
      }
      failureState.consecutiveFailures = 0
      return response
    }
    catch (error) {
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS.at(-1)!
        consola.warn(`Token refresh attempt ${attempt + 1} failed, retrying in ${delay}ms...`, error)
        await sleepFn(delay)
      }
    }
  }

  failureState.consecutiveFailures++
  consola.error(
    `Token refresh failed after ${MAX_RETRIES + 1} attempts`
    + ` (${failureState.consecutiveFailures} consecutive interval failure(s)).`
    + ` Service may be using a stale token.`,
  )
  return undefined
}

export async function setupCopilotToken(
  options: { scheduleRefresh?: boolean } = {},
): Promise<GetCopilotTokenResponse> {
  const response = await getCopilotToken()
  const { token, refresh_in } = response
  state.copilotToken = token

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
  stopCopilotTokenRefresh()
  const generation = copilotTokenRefreshGeneration

  const refreshDelay = getCopilotTokenRefreshDelayMs(refreshInSeconds)
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout
  const refreshFn = deps.refreshFn ?? refreshTokenWithRetry
  clearCopilotTokenRefreshTimer = clearTimeoutFn
  const timer = setTimeoutFn(() => {
    copilotTokenRefreshTimer = undefined
    consola.debug('Refreshing Copilot token')
    void refreshFn().then((refreshed) => {
      if (generation === copilotTokenRefreshGeneration)
        startCopilotTokenRefresh(refreshed?.refresh_in ?? refreshInSeconds, deps)
    }).catch((error) => {
      consola.error('Unexpected Copilot token refresh failure:', error)
      if (generation === copilotTokenRefreshGeneration)
        startCopilotTokenRefresh(refreshInSeconds, deps)
    })
  }, refreshDelay)
  copilotTokenRefreshTimer = timer
  timer.unref?.()
}

export function stopCopilotTokenRefresh(): void {
  copilotTokenRefreshGeneration++
  if (copilotTokenRefreshTimer !== undefined) {
    const clearTimeoutFn = clearCopilotTokenRefreshTimer ?? clearTimeout
    clearTimeoutFn(copilotTokenRefreshTimer)
    copilotTokenRefreshTimer = undefined
  }
  clearCopilotTokenRefreshTimer = undefined
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
