import type { ResponsesPayload } from '../src/services/copilot/create-responses'

import { expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'
import { createResponses } from '../src/services/copilot/create-responses'

// Mock state
state.copilotToken = 'test-token'
state.vsCodeVersion = '1.0.0'
state.accountType = 'individual'

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      json: () => ({
        id: '123',
        object: 'response',
        model: 'gpt-5.4',
        output: [],
        status: 'completed',
      }),
      headers: opts.headers,
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test('sets X-Initiator to agent if assistant present', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-5.4',
    input: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers['X-Initiator']).toBe('agent')
})

test('sets X-Initiator to user if only user present', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-5.4',
    input: [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'hello again' },
    ],
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers['X-Initiator']).toBe('user')
})

test('detects vision input with image_url type', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-5.4',
    input: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
        ],
      },
    ],
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  // Should successfully call with vision input
  expect(fetchMock.mock.calls[2][0]).toContain('/responses')
})

test('handles string input (non-array)', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-5.4',
    input: 'simple string input',
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  // Should not crash with string input
})

test('detects vision input with input_image type', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-5.4',
    input: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this' },
          { type: 'input_image', source: { type: 'base64', data: 'abc123' } },
        ],
      },
    ],
  }
  await createResponses(payload)
  expect(fetchMock).toHaveBeenCalled()
  // Should successfully call with vision input
  expect(fetchMock.mock.calls[4][0]).toContain('/responses')
})

test('throws error when copilot token is missing', async () => {
  state.copilotToken = undefined
  const payload: ResponsesPayload = {
    model: 'gpt-5.4',
    input: [{ role: 'user', content: 'test' }],
  }
  try {
    await createResponses(payload)
    expect(true).toBe(false) // Should not reach here
  }
  catch (error) {
    expect((error as Error).message).toBe('Copilot token not found')
  }
  // Restore token
  state.copilotToken = 'test-token'
})
