import { afterEach, describe, expect, mock, test } from 'bun:test'

import { UpstreamTimeoutError } from '~/lib/error'
import {
  DEFAULT_COPILOT_BODY_TIMEOUT_MS,
  DEFAULT_COPILOT_CONNECT_TIMEOUT_MS,
  DEFAULT_COPILOT_HEADERS_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
} from '~/lib/http-timeouts'
import {
  configureCopilotFetchTimeouts,
  fetchCopilot,
  fetchCopilotUnderNode,
  fetchWithTimeout,
  normalizeUndiciTimeoutError,
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

  test('rejects timeout configuration above the runtime timer limit', () => {
    expect(() => configureCopilotFetchTimeouts({
      headersTimeoutMs: MAX_TIMER_DELAY_MS + 1,
    })).toThrow(`headersTimeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`)
  })

  test('rejects one-off fetch timeouts above the runtime timer limit', async () => {
    await expect(fetchWithTimeout('https://example.test', {}, {
      timeoutLabel: 'too-large-timeout',
      timeoutMs: MAX_TIMER_DELAY_MS + 1,
    })).rejects.toThrow(`timeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`)
  })

  test('normalizes Node Undici timeout cause codes with the configured phase timeout', () => {
    configureCopilotFetchTimeouts({
      headersTimeoutMs: 11,
      bodyTimeoutMs: 12,
      connectTimeoutMs: 13,
    })

    for (const [code, phase, timeoutMs] of [
      ['UND_ERR_HEADERS_TIMEOUT', 'headers', 11],
      ['UND_ERR_BODY_TIMEOUT', 'body', 12],
      ['UND_ERR_CONNECT_TIMEOUT', 'connect', 13],
    ] as const) {
      const cause = Object.assign(new Error(`${phase} timeout`), { code })
      const original = new TypeError('fetch failed', { cause })
      const normalized = normalizeUndiciTimeoutError(original, 'https://example.test')

      expect(normalized).toBeInstanceOf(UpstreamTimeoutError)
      expect(normalized).toMatchObject({
        timeoutMs,
        target: 'https://example.test',
      })
      expect((normalized as Error).message).toContain(`Upstream ${phase} timed out`)
    }
  })

  test('uses Copilot defaults when normalizing Node Undici timeout errors', () => {
    for (const [code, timeoutMs] of [
      ['UND_ERR_HEADERS_TIMEOUT', DEFAULT_COPILOT_HEADERS_TIMEOUT_MS],
      ['UND_ERR_BODY_TIMEOUT', DEFAULT_COPILOT_BODY_TIMEOUT_MS],
      ['UND_ERR_CONNECT_TIMEOUT', DEFAULT_COPILOT_CONNECT_TIMEOUT_MS],
    ] as const) {
      const normalized = normalizeUndiciTimeoutError(
        Object.assign(new Error('timeout'), { code }),
        'https://api.githubcopilot.com/responses',
      )
      expect(normalized).toMatchObject({ timeoutMs })
    }
  })

  test('normalizes Node Undici body timeouts while consuming the response', async () => {
    configureCopilotFetchTimeouts({ bodyTimeoutMs: 17 })
    globalThis.fetch = mock(async () => new Response(new ReadableStream({
      pull(controller) {
        controller.error(new TypeError('fetch failed', {
          cause: Object.assign(new Error('body timeout'), {
            code: 'UND_ERR_BODY_TIMEOUT',
          }),
        }))
      },
    }))) as unknown as typeof fetch

    const response = await fetchCopilotUnderNode('https://api.githubcopilot.com/responses')
    await expect(response.text()).rejects.toMatchObject({
      name: 'UpstreamTimeoutError',
      timeoutMs: 17,
    })
  })
})
