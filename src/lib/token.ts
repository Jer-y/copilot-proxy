import fs from 'node:fs/promises'
import consola from 'consola'

import { PATHS } from '~/lib/paths'
import { getCopilotToken } from '~/services/github/get-copilot-token'
import { getDeviceCode } from '~/services/github/get-device-code'
import { getGitHubUser } from '~/services/github/get-user'
import { pollAccessToken } from '~/services/github/poll-access-token'

import { TOKEN_MAX_RETRIES as MAX_RETRIES, TOKEN_RETRY_DELAYS as RETRY_DELAYS } from './constants'
import { HTTPError } from './error'
import { state } from './state'
import { sleep } from './utils'

const readGithubToken = () => fs.readFile(PATHS.GITHUB_TOKEN_PATH, 'utf8')

function writeGithubToken(token: string) {
  return fs.writeFile(PATHS.GITHUB_TOKEN_PATH, token)
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
}

export async function refreshTokenWithRetry(deps: RefreshTokenWithRetryDeps = {}): Promise<void> {
  const fetchToken = deps.fetchToken ?? getCopilotToken
  const sleepFn = deps.sleepFn ?? sleep
  const failureState = deps.failureState ?? refreshTokenFailureState

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { token } = await fetchToken()
      state.copilotToken = token
      consola.debug('Copilot token refreshed')
      if (state.showToken) {
        consola.info('Refreshed Copilot token:', token)
      }
      if (failureState.consecutiveFailures > 0) {
        consola.info(`Token refresh recovered after ${failureState.consecutiveFailures} consecutive failure(s)`)
      }
      failureState.consecutiveFailures = 0
      return
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
}

export async function setupCopilotToken() {
  const { token, refresh_in } = await getCopilotToken()
  state.copilotToken = token

  // Display the Copilot token to the screen
  consola.debug('GitHub Copilot Token fetched successfully!')
  if (state.showToken) {
    consola.info('Copilot token:', token)
  }

  const rawInterval = (refresh_in - 60) * 1000
  // Clamp to [60s, 24h] to prevent timer issues with extreme values
  const MAX_REFRESH_MS = 24 * 60 * 60 * 1000
  const refreshInterval = Number.isFinite(rawInterval)
    ? Math.min(Math.max(rawInterval, 60_000), MAX_REFRESH_MS)
    : 60_000
  setInterval(async () => {
    consola.debug('Refreshing Copilot token')
    await refreshTokenWithRetry()
  }, refreshInterval)
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
    consola.debug('Device code response:', response)

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
      consola.error('Failed to get GitHub token:', await error.response.json())
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
