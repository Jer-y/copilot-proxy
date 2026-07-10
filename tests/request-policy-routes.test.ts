import process from 'node:process'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import consola from 'consola'

import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const originalPrompt = consola.prompt
const originalStdinIsTTY = process.stdin.isTTY
const originalStdoutIsTTY = process.stdout.isTTY

const fetchMock = mock(async (): Promise<Response> => {
  return new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

function restoreRequestPolicyState(snapshot: {
  manualApprove: boolean
  rateLimitSeconds?: number
  rateLimitWait: boolean
  lastRequestTimestamp?: number
  copilotToken?: string
  vsCodeVersion?: string
  accountType: string
}) {
  state.manualApprove = snapshot.manualApprove
  state.rateLimitSeconds = snapshot.rateLimitSeconds
  state.rateLimitWait = snapshot.rateLimitWait
  state.lastRequestTimestamp = snapshot.lastRequestTimestamp
  state.copilotToken = snapshot.copilotToken
  state.vsCodeVersion = snapshot.vsCodeVersion
  state.accountType = snapshot.accountType
}

let stateSnapshot: {
  manualApprove: boolean
  rateLimitSeconds?: number
  rateLimitWait: boolean
  lastRequestTimestamp?: number
  copilotToken?: string
  vsCodeVersion?: string
  accountType: string
}

beforeEach(() => {
  stateSnapshot = {
    manualApprove: state.manualApprove,
    rateLimitSeconds: state.rateLimitSeconds,
    rateLimitWait: state.rateLimitWait,
    lastRequestTimestamp: state.lastRequestTimestamp,
    copilotToken: state.copilotToken,
    vsCodeVersion: state.vsCodeVersion,
    accountType: state.accountType,
  }
  state.manualApprove = false
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  fetchMock.mockClear()
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  restoreRequestPolicyState(stateSnapshot)
  globalThis.fetch = originalFetch
  consola.prompt = originalPrompt
  setIsTTY(process.stdin, originalStdinIsTTY)
  setIsTTY(process.stdout, originalStdoutIsTTY)
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
  expect(fetchMock).toHaveBeenCalledTimes(0)
}

function rejectManualApproval(): ReturnType<typeof mock> {
  const promptMock = mock(async () => false)
  consola.prompt = promptMock as unknown as typeof consola.prompt
  state.manualApprove = true
  setIsTTY(process.stdin, true)
  setIsTTY(process.stdout, true)
  return promptMock
}

function setIsTTY(stream: NodeJS.ReadStream | NodeJS.WriteStream, value: boolean | undefined): void {
  Object.defineProperty(stream, 'isTTY', {
    configurable: true,
    value,
  })
}

describe('upstream request policy route coverage', () => {
  test('/v1/embeddings participates in global rate limiting', async () => {
    await expectSecondInvalidRequestRateLimited('/v1/embeddings')
  })

  test('/v1/messages/count_tokens participates in global rate limiting', async () => {
    await expectSecondInvalidRequestRateLimited('/v1/messages/count_tokens')
  })

  test('/v1/embeddings honors manual approval rejection before upstream fetch', async () => {
    const promptMock = rejectManualApproval()

    const response = await server.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: 'hello',
      }),
    })

    expect(response.status).toBe(403)
    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(promptMock.mock.calls[0]?.[0]).toContain('POST /v1/embeddings')
    expect(promptMock.mock.calls[0]?.[0]).toContain('model=text-embedding-3-small')
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test('/v1/messages/count_tokens honors manual approval rejection before upstream fetch', async () => {
    const promptMock = rejectManualApproval()

    const response = await server.request('/v1/messages/count_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    })

    expect(response.status).toBe(403)
    expect(promptMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })

  test('manual approval fails closed when a service has no TTY', async () => {
    state.manualApprove = true
    setIsTTY(process.stdin, false)
    setIsTTY(process.stdout, false)

    const response = await server.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: 'hello',
      }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: 'manual_approval_unavailable' },
    })
    expect(fetchMock).toHaveBeenCalledTimes(0)
  })
})
