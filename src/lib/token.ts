import type { DeviceCodeResponse } from '~/services/github/get-device-code'
import fs from 'node:fs/promises'

import consola from 'consola'
import { writeOwnerOnlyFileAtomically } from '~/daemon/atomic-file'
import { PATHS } from '~/lib/paths'
import { getDeviceCode } from '~/services/github/get-device-code'
import { getGitHubUser } from '~/services/github/get-user'

import { pollAccessToken } from '~/services/github/poll-access-token'

import { HTTPError } from './error'
import { state } from './state'

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
      if (options?.logUser !== false)
        await tryLogUser()

      return
    }

    consola.info('Not logged in, getting new access token')
    const token = await runDeviceFlow()
    await writeGithubToken(token)
    state.defaultAccount.githubToken = token

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
