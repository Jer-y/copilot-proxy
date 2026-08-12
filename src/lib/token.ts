import type {
  CopilotTokenLifecycleStatus,
  CopilotTokenSnapshot,
  ReactiveTokenRefreshDeps,
  ReactiveTokenRefreshResult,
  RefreshTokenWithRetryDeps,
  TokenRefreshSchedulerDeps,
} from './account/token-lifecycle'

import type { DeviceCodeResponse } from '~/services/github/get-device-code'
import fs from 'node:fs/promises'

import consola from 'consola'
import { writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'
import { PATHS } from '~/lib/paths'
import { getDeviceCode } from '~/services/github/get-device-code'
import { getGitHubUser } from '~/services/github/get-user'

import { pollAccessToken } from '~/services/github/poll-access-token'

import { getCopilotTokenRefreshDelayMs } from './account/token-lifecycle'
import { HTTPError } from './error'
import { state } from './state'

export type {
  CopilotTokenLifecycleStatus,
  CopilotTokenSnapshot,
  ReactiveTokenRefreshDeps,
  ReactiveTokenRefreshOutcome,
  ReactiveTokenRefreshResult,
  RefreshTokenWithRetryDeps,
  TokenRefreshFailureKind,
  TokenRefreshSchedulerDeps,
} from './account/token-lifecycle'
export { getCopilotTokenRefreshDelayMs }

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

export function getCopilotTokenSnapshot(): CopilotTokenSnapshot {
  return state.defaultAccount.tokens.getSnapshot()
}

export function getCopilotTokenLifecycleStatus(
  now = Date.now(),
): CopilotTokenLifecycleStatus {
  return state.defaultAccount.tokens.getStatus(now)
}

export function refreshCopilotTokenAfterFailure(
  failedSnapshot: CopilotTokenSnapshot,
  deps: ReactiveTokenRefreshDeps = {},
): Promise<ReactiveTokenRefreshResult> {
  return state.defaultAccount.tokens.refreshAfterFailure(failedSnapshot, deps)
}

export function cancelInFlightCopilotTokenRefreshes(
  reason: Error = new Error('Disposable Copilot token refresh was cancelled.'),
): Promise<void> {
  return state.defaultAccount.tokens.cancelInFlight(reason)
}

export function refreshTokenWithRetry(
  deps: RefreshTokenWithRetryDeps = {},
) {
  return state.defaultAccount.tokens.refreshWithRetry(deps)
}

export function setupCopilotToken(
  options: { scheduleRefresh?: boolean } = {},
) {
  return state.defaultAccount.tokens.setup(options)
}

export function startCopilotTokenRefresh(
  refreshInSeconds: number,
  deps: TokenRefreshSchedulerDeps = {},
): void {
  state.defaultAccount.tokens.startRefresh(refreshInSeconds, deps)
}

export function stopCopilotTokenRefresh(): void {
  state.defaultAccount.tokens.stopRefresh()
}

export function isCopilotTokenRefreshScheduled(): boolean {
  return state.defaultAccount.tokens.isRefreshScheduled()
}

interface SetupGitHubTokenOptions {
  force?: boolean
  logUser?: boolean
}

/** Pure device authorization: returns a GitHub token without persisting it. */
export async function runDeviceFlow(): Promise<string> {
  const response = await getDeviceCode()
  consola.debug('Device code response:', redactDeviceCodeResponse(response))

  consola.info(
    `Please enter the code "${response.user_code}" in ${response.verification_uri}`,
  )

  return await pollAccessToken(response)
}

export async function setupGitHubToken(
  options?: SetupGitHubTokenOptions,
): Promise<void> {
  try {
    const githubToken = await readGithubToken()

    if (githubToken && !options?.force) {
      state.defaultAccount.githubToken = githubToken
      if (state.showToken)
        consola.info('GitHub token:', githubToken)
      if (options?.logUser !== false)
        await tryLogUser()

      return
    }

    consola.info('Not logged in, getting new access token')
    const token = await runDeviceFlow()
    await writeGithubToken(token)
    state.defaultAccount.githubToken = token

    if (state.showToken)
      consola.info('GitHub token:', token)
    if (options?.logUser !== false)
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
  const user = await getGitHubUser(state.defaultAccount)
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
