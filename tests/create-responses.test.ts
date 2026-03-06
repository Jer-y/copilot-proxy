import type { ResponsesPayload } from '../src/services/copilot/create-responses'

import { afterEach, expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'
import { createResponses } from '../src/services/copilot/create-responses'

state.copilotToken = 'test-token'
state.vsCodeVersion = '1.0.0'
state.accountType = 'individual'

const fetchMock = mock(
  (_url: string, _opts: { headers: Record<string, string> }) => {
    return new Response(JSON.stringify({
      id: 'resp_123',
      object: 'response',
      model: 'gpt-test',
      output: [],
      status: 'completed',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  },
)

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

afterEach(() => {
  fetchMock.mockClear()
})

test('sets X-Initiator to agent if function_call history is present', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-test',
    input: [
      { role: 'user', content: 'hi' },
      {
        type: 'function_call',
        id: 'fc_call_1',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{}',
      },
    ],
  }

  await createResponses(payload)
  const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
  expect(headers['X-Initiator']).toBe('agent')
})

test('sets X-Initiator to user if only user messages are present', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-test',
    input: [
      { role: 'user', content: 'hi' },
      { role: 'user', content: [{ type: 'input_text', text: 'hello again' }] },
    ],
  }

  await createResponses(payload)
  const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
  expect(headers['X-Initiator']).toBe('user')
})

test('treats typed message items as messages for vision detection', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-test',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'high' },
        ],
      },
    ],
  }

  await createResponses(payload)
  const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
  expect(headers['X-Initiator']).toBe('user')
  expect(headers['copilot-vision-request']).toBe('true')
})
