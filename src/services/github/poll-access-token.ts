import type { DeviceCodeResponse } from './get-device-code'

import consola from 'consola'
import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from '~/lib/api-config'

import { fetchGitHub } from '~/lib/upstream-fetch'
import { sleep } from '~/lib/utils'

export function redactAccessTokenPollResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object') {
    return value
  }

  const redacted = { ...(value as Record<string, unknown>) }
  if (typeof redacted.access_token === 'string') {
    redacted.access_token = '<redacted>'
  }
  return redacted
}

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  const sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

  const startTime = Date.now()
  const expiresInMs = deviceCode.expires_in * 1000

  while (true) {
    if (Date.now() - startTime > expiresInMs) {
      throw new Error('Device code expired. Please run auth again.')
    }

    const response = await fetchGitHub(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: 'POST',
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      },
    )

    if (!response.ok) {
      const errorText = await response.text()
      consola.error('Failed to poll access token:', errorText)
      await sleep(sleepDuration)

      continue
    }

    const json = await response.json()
    consola.debug('Polling access token response:', redactAccessTokenPollResponse(json))

    const { access_token } = json as AccessTokenResponse

    if (access_token) {
      return access_token
    }
    else {
      await sleep(sleepDuration)
    }
  }
}

interface AccessTokenResponse {
  access_token: string
  token_type: string
  scope: string
}
