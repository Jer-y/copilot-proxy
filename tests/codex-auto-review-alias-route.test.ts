import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'
import { server } from '../src/server'

const originalFetch = globalThis.fetch
const originalAlias = state.codexAutoReviewModel

const COMPLETED_SSE = `event: response.completed\ndata: ${JSON.stringify({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-5.4-mini',
    status: 'completed',
    output: [],
  },
})}\n\n`

let lastUpstreamBody: { model?: string } | undefined

const fetchMock = mock(async (url: string, init?: { body?: unknown }): Promise<Response> => {
  if (!url.endsWith('/responses')) {
    throw new Error(`Unexpected upstream URL: ${url}`)
  }
  lastUpstreamBody = typeof init?.body === 'string'
    ? JSON.parse(init.body) as { model?: string }
    : undefined
  return new Response(COMPLETED_SSE, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
})

beforeEach(() => {
  fetchMock.mockClear()
  lastUpstreamBody = undefined
  state.lastRequestTimestamp = undefined
  state.models = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  // @ts-expect-error test mock only needs a callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.codexAutoReviewModel = originalAlias
})

async function postCodexAutoReview(): Promise<Response> {
  return server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'codex-auto-review', input: 'ping', stream: true }),
  })
}

describe('codex-auto-review alias on /responses', () => {
  test('aliases to the configured model and sends it upstream when set', async () => {
    state.codexAutoReviewModel = 'gpt-5.4-mini'
    const response = await postCodexAutoReview()
    expect(response.status).toBe(200)
    await response.text()
    expect(fetchMock).toHaveBeenCalled()
    expect(lastUpstreamBody?.model).toBe('gpt-5.4-mini')
  })

  test('returns the today-behavior 400 when the alias is unset', async () => {
    state.codexAutoReviewModel = undefined
    const response = await postCodexAutoReview()
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain('cannot be reached via /responses')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
