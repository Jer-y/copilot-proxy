import { afterEach, describe, expect, mock, test } from 'bun:test'

import { UpstreamTimeoutError } from '~/lib/error'
import {
  configureCopilotFetchTimeouts,
  fetchCopilot,
  fetchWithTimeout,
} from '~/lib/upstream-fetch'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  configureCopilotFetchTimeouts({})
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

  test('enforces configured Bun response-header timeouts', async () => {
    configureCopilotFetchTimeouts({
      headersTimeoutMs: 5,
      bodyTimeoutMs: 0,
      connectTimeoutMs: 0,
    })
    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
      return new Response('{}')
    }) as unknown as typeof fetch

    await expect(fetchCopilot('https://example.test/headers')).rejects.toMatchObject({
      name: 'UpstreamTimeoutError',
      timeoutMs: 5,
    })
  })

  test('enforces configured Bun body inactivity timeouts', async () => {
    configureCopilotFetchTimeouts({
      headersTimeoutMs: 0,
      bodyTimeoutMs: 5,
      connectTimeoutMs: 0,
    })
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      start() {},
    }))) as unknown as typeof fetch

    const response = await fetchCopilot('https://example.test/body')
    await expect(response.text()).rejects.toMatchObject({
      name: 'UpstreamTimeoutError',
      timeoutMs: 5,
    })
  })

  test('zero disables all Bun timeout phases', async () => {
    configureCopilotFetchTimeouts({
      headersTimeoutMs: 0,
      bodyTimeoutMs: 0,
      connectTimeoutMs: 0,
    })
    let capturedSignal: AbortSignal | null | undefined
    globalThis.fetch = mock(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capturedSignal = init?.signal
      return Response.json({ ok: true })
    }) as unknown as typeof fetch

    const response = await fetchCopilot('https://example.test/no-timeout')
    expect(await response.json()).toEqual({ ok: true })
    expect(capturedSignal?.aborted).toBe(false)
  })
})
