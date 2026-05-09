import { afterEach, describe, expect, mock, test } from 'bun:test'

import { UpstreamTimeoutError } from '~/lib/error'
import { fetchWithTimeout } from '~/lib/upstream-fetch'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchWithTimeout', () => {
  test('turns timeout aborts into UpstreamTimeoutError', async () => {
    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
      return new Response('{}')
    }) as unknown as typeof fetch

    await expect(fetchWithTimeout('https://example.test', {}, {
      timeoutLabel: 'timeout-test',
      timeoutMs: 5,
    })).rejects.toBeInstanceOf(UpstreamTimeoutError)
  })
})
