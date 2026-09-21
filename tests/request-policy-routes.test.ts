import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch

const fetchMock = mock(async (): Promise<Response> => {
  return new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

function restoreRequestPolicyState(snapshot: {
  rateLimitSeconds?: number
  rateLimitWait: boolean
  lastRequestTimestamp?: number
  copilotToken?: string
  vsCodeVersion?: string
  accountType: typeof state.defaultAccount.accountType
}) {
  state.rateLimitSeconds = snapshot.rateLimitSeconds
  state.rateLimitWait = snapshot.rateLimitWait
  state.lastRequestTimestamp = snapshot.lastRequestTimestamp
  state.defaultAccount.copilotToken = snapshot.copilotToken
  state.defaultAccount.vsCodeVersion = snapshot.vsCodeVersion
  state.defaultAccount.accountType = snapshot.accountType
}

let stateSnapshot: {
  rateLimitSeconds?: number
  rateLimitWait: boolean
  lastRequestTimestamp?: number
  copilotToken?: string
  vsCodeVersion?: string
  accountType: typeof state.defaultAccount.accountType
}

beforeEach(() => {
  stateSnapshot = {
    rateLimitSeconds: state.rateLimitSeconds,
    rateLimitWait: state.rateLimitWait,
    lastRequestTimestamp: state.lastRequestTimestamp,
    copilotToken: state.defaultAccount.copilotToken,
    vsCodeVersion: state.defaultAccount.vsCodeVersion,
    accountType: state.defaultAccount.accountType,
  }
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.defaultAccount.copilotToken = 'test-token'
  state.defaultAccount.vsCodeVersion = '1.0.0'
  state.defaultAccount.accountType = 'individual'
  fetchMock.mockClear()
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  restoreRequestPolicyState(stateSnapshot)
  globalThis.fetch = originalFetch
})

async function expectSecondInvalidRequestRateLimited(path: string): Promise<void> {
  state.rateLimitSeconds = 9999
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined

  const first = await server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '<<<not json>>>',
  })
  expect(first.status).toBe(400)

  const second = await server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '<<<not json>>>',
  })
  expect(second.status).toBe(429)
  expect(second.headers.get('retry-after')).toBe('9999')
  if (path.startsWith('/v1/messages')) {
    expect(await second.json()).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded',
      },
    })
  }
  else {
    expect(await second.json()).toEqual({
      error: {
        type: 'rate_limit_error',
        message: 'Rate limit exceeded',
      },
    })
  }
  expect(fetchMock).toHaveBeenCalledTimes(0)
}

describe('upstream request policy route coverage', () => {
  test('/v1/embeddings participates in global rate limiting', async () => {
    await expectSecondInvalidRequestRateLimited('/v1/embeddings')
  })

  test('/v1/messages/count_tokens participates in global rate limiting', async () => {
    await expectSecondInvalidRequestRateLimited('/v1/messages/count_tokens')
  })
})
