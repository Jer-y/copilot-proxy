import { beforeEach, describe, expect, test } from 'bun:test'

import {
  clearProbeCache,
  isApiProbedUnsupported,
  recordProbeResult,
} from '~/lib/api-probe'
import { runBackendPlan } from '~/lib/backend-plan'
import { HTTPError } from '~/lib/error'

function createUnsupportedApiError(message = 'unsupported_api_for_model'): HTTPError {
  return new HTTPError(message, new Response(JSON.stringify({
    error: {
      message,
      code: 'unsupported_api_for_model',
    },
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  }))
}

beforeEach(() => {
  clearProbeCache()
})

describe('runBackendPlan', () => {
  test('returns immediately when the first step succeeds', async () => {
    const calls: string[] = []

    const result = await runBackendPlan({
      model: 'gpt-5',
      steps: [
        {
          api: 'chat-completions',
          run: async () => {
            calls.push('chat-completions')
            return 'ok'
          },
        },
        {
          api: 'responses',
          run: async () => {
            calls.push('responses')
            return 'fallback'
          },
        },
      ],
    })

    expect(result).toBe('ok')
    expect(calls).toEqual(['chat-completions'])
  })

  test('falls back to the next step when the first step is unsupported', async () => {
    const calls: string[] = []

    const result = await runBackendPlan({
      model: 'gpt-5',
      steps: [
        {
          api: 'chat-completions',
          run: async () => {
            calls.push('chat-completions')
            throw createUnsupportedApiError()
          },
        },
        {
          api: 'responses',
          run: async () => {
            calls.push('responses')
            return 'ok'
          },
        },
      ],
    })

    expect(result).toBe('ok')
    expect(calls).toEqual(['chat-completions', 'responses'])
    expect(isApiProbedUnsupported('gpt-5', 'chat-completions')).toBe(true)
  })

  test('skips cached unsupported steps when another uncached step is available', async () => {
    recordProbeResult('claude-opus-4.6', 'chat-completions')

    const calls: string[] = []
    const result = await runBackendPlan({
      model: 'claude-opus-4.6',
      steps: [
        {
          api: 'chat-completions',
          run: async () => {
            calls.push('chat-completions')
            return 'unexpected'
          },
        },
        {
          api: 'responses',
          run: async () => {
            calls.push('responses')
            return 'ok'
          },
        },
      ],
    })

    expect(result).toBe('ok')
    expect(calls).toEqual(['responses'])
  })

  test('calls onAllUnsupported when every step is unsupported', async () => {
    const unsupportedApis: string[][] = []

    const result = await runBackendPlan({
      model: 'claude-opus-4.6',
      steps: [
        {
          api: 'chat-completions',
          run: async () => {
            throw createUnsupportedApiError()
          },
        },
        {
          api: 'responses',
          run: async () => {
            throw createUnsupportedApiError()
          },
        },
      ],
      onAllUnsupported: (apis) => {
        unsupportedApis.push([...apis])
        return 'handled'
      },
    })

    expect(result).toBe('handled')
    expect(unsupportedApis).toEqual([['chat-completions', 'responses']])
  })

  test('rethrows the last unsupported error when all steps are unsupported without a handler', async () => {
    const firstError = createUnsupportedApiError('first unsupported')
    const lastError = createUnsupportedApiError('last unsupported')

    try {
      await runBackendPlan({
        model: 'gpt-5',
        steps: [
          {
            api: 'chat-completions',
            run: async () => {
              throw firstError
            },
          },
          {
            api: 'responses',
            run: async () => {
              throw lastError
            },
          },
        ],
      })
      throw new Error('Expected runBackendPlan to throw')
    }
    catch (error) {
      expect(error).toBe(lastError)
    }
  })

  test('rethrows non-HTTP errors without falling back', async () => {
    const failure = new Error('boom')
    let fallbackCalled = false

    try {
      await runBackendPlan({
        model: 'gpt-5',
        steps: [
          {
            api: 'chat-completions',
            run: async () => {
              throw failure
            },
          },
          {
            api: 'responses',
            run: async () => {
              fallbackCalled = true
              return 'ok'
            },
          },
        ],
      })
      throw new Error('Expected runBackendPlan to throw')
    }
    catch (error) {
      expect(error).toBe(failure)
      expect(fallbackCalled).toBe(false)
    }
  })

  test('dedupes repeated APIs so the same backend is not attempted twice', async () => {
    let responseCalls = 0

    const result = await runBackendPlan({
      model: 'gpt-5.4',
      steps: [
        {
          api: 'responses',
          run: async () => {
            responseCalls++
            return 'ok'
          },
        },
        {
          api: 'responses',
          run: async () => {
            responseCalls++
            return 'duplicate'
          },
        },
      ],
    })

    expect(result).toBe('ok')
    expect(responseCalls).toBe(1)
  })
})
