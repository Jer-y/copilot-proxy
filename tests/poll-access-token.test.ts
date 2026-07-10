import { describe, expect, test } from 'bun:test'

import { interpretAccessTokenPollResponse } from '~/services/github/poll-access-token'

describe('interpretAccessTokenPollResponse', () => {
  test('returns an access token', () => {
    expect(interpretAccessTokenPollResponse({ access_token: 'secret' }, 6_000)).toEqual({
      type: 'success',
      accessToken: 'secret',
    })
  })

  test('keeps polling while authorization is pending', () => {
    expect(interpretAccessTokenPollResponse({ error: 'authorization_pending' }, 6_000)).toEqual({
      type: 'wait',
      nextIntervalMs: 6_000,
    })
  })

  test('adds five seconds after slow_down', () => {
    expect(interpretAccessTokenPollResponse({ error: 'slow_down' }, 6_000)).toEqual({
      type: 'wait',
      nextIntervalMs: 11_000,
    })
  })

  test('stops on denial and expiry', () => {
    expect(interpretAccessTokenPollResponse({ error: 'access_denied' }, 6_000)).toEqual({
      type: 'error',
      message: 'GitHub device authorization was denied. Please run auth again.',
    })
    expect(interpretAccessTokenPollResponse({ error: 'expired_token' }, 6_000)).toEqual({
      type: 'error',
      message: 'Device code expired. Please run auth again.',
    })
  })

  test('surfaces other errors instead of polling forever', () => {
    expect(interpretAccessTokenPollResponse({ error: 'incorrect_device_code', error_description: 'bad code' }, 6_000)).toEqual({
      type: 'error',
      message: 'bad code',
    })
    expect(interpretAccessTokenPollResponse({}, 6_000).type).toBe('error')
  })
})
