import type { ResponsesPayload } from '../src/services/copilot/create-responses'

import { afterEach, expect, mock, test } from 'bun:test'

import { JSONResponseError } from '../src/lib/error'
import { state } from '../src/lib/state'
import { createResponses, summarizeResponsesPayload } from '../src/services/copilot/create-responses'

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

test('summarizes inline image payloads without expanding them', () => {
  const firstDataUrl = 'data:image/png;base64,aaaa'
  const secondDataUrl = 'data:image/png;base64,bbbbbb'

  const summary = summarizeResponsesPayload({
    model: 'gpt-test',
    stream: true,
    tools: [{ type: 'function', name: 'lookup', parameters: {} }],
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'inspect' },
          { type: 'input_image', image_url: firstDataUrl },
          { type: 'input_image', image_url: { url: secondDataUrl, detail: 'high' } },
          { type: 'input_image', image_url: 'https://example.com/cat.png' },
        ],
      },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '{"ok":true}',
      },
    ],
  })

  expect(summary).toEqual({
    model: 'gpt-test',
    stream: true,
    tools: 1,
    inputType: 'array',
    inputItems: 3,
    messageItems: 1,
    functionCalls: 1,
    functionCallOutputs: 1,
    imageParts: 2,
    inlineDataUrlImages: 2,
    inlineImageChars: firstDataUrl.length + secondDataUrl.length,
    maxInlineImageChars: secondDataUrl.length,
  })
})

test('turns upstream 413 into a clearer payload-too-large error', async () => {
  fetchMock.mockImplementationOnce(
    () => new Response(JSON.stringify({
      error: {
        message: 'failed to parse request',
        type: 'invalid_request_error',
        code: '',
      },
    }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

  const payload: ResponsesPayload = {
    model: 'gpt-test',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'data:image/png;base64,abcdef' },
        ],
      },
    ],
  }

  try {
    await createResponses(payload)
    throw new Error('Expected createResponses to throw')
  }
  catch (error) {
    expect(error).toBeInstanceOf(JSONResponseError)

    const jsonError = error as JSONResponseError
    expect(jsonError.status).toBe(413)
    expect(jsonError.payload).toEqual({
      error: {
        message: expect.stringContaining('Upstream /responses rejected the request with 413 Payload Too Large.'),
        type: 'invalid_request_error',
        code: 'payload_too_large',
      },
    })

    const errorPayload = jsonError.payload as {
      error: {
        message: string
      }
    }
    expect(errorPayload.error.message).toContain('data_url_images=1')
    expect(errorPayload.error.message).toContain('inline_image_chars=28')
    expect(errorPayload.error.message).toContain('upstream_message=failed to parse request')
  }
})
