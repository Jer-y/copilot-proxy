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
  let sleepDuration = (deviceCode.interval + 1) * 1000
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

    const decision = interpretAccessTokenPollResponse(json, sleepDuration)
    if (decision.type === 'success')
      return decision.accessToken
    if (decision.type === 'error')
      throw new Error(decision.message)

    sleepDuration = decision.nextIntervalMs
    await sleep(sleepDuration)
  }
}

export type AccessTokenPollDecision
  = | { type: 'success', accessToken: string }
    | { type: 'wait', nextIntervalMs: number }
    | { type: 'error', message: string }

export function interpretAccessTokenPollResponse(
  value: unknown,
  currentIntervalMs: number,
): AccessTokenPollDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: 'error', message: 'GitHub returned an invalid device authorization response.' }
  }

  const response = value as Record<string, unknown>
  if (typeof response.access_token === 'string' && response.access_token.length > 0) {
    return { type: 'success', accessToken: response.access_token }
  }

  const description = typeof response.error_description === 'string'
    ? response.error_description
    : undefined

  switch (response.error) {
    case 'authorization_pending':
      return { type: 'wait', nextIntervalMs: currentIntervalMs }
    case 'slow_down':
      return { type: 'wait', nextIntervalMs: currentIntervalMs + 5_000 }
    case 'access_denied':
      return {
        type: 'error',
        message: description ?? 'GitHub device authorization was denied. Please run auth again.',
      }
    case 'expired_token':
      return {
        type: 'error',
        message: description ?? 'Device code expired. Please run auth again.',
      }
    case undefined:
      return { type: 'error', message: 'GitHub device authorization response did not include a token or status.' }
    default:
      return {
        type: 'error',
        message: description ?? `GitHub device authorization failed: ${String(response.error)}`,
      }
  }
}
