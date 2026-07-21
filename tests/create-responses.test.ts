import type { ResponsesPayload } from '../src/services/copilot/create-responses'

import { afterEach, expect, mock, test } from 'bun:test'

import { JSONResponseError } from '../src/lib/error'
import { state } from '../src/lib/state'
import {
  analyzeResponsesPayloadForCopilot,
  createResponses,
  summarizeResponsesPayload,
} from '../src/services/copilot/create-responses'
import {
  normalizeCopilotResponsesEventStream,
  resetCopilotResponseIdAliasesForTests,
} from '../src/services/copilot/responses-id-normalizer'

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

const richCustomOutputDataUrl = 'data:image/png;base64,Y3VzdG9tLXRvb2w='

function richCustomToolOutputPayload(): ResponsesPayload {
  return {
    model: 'gpt-test',
    input: [{
      type: 'custom_tool_call_output',
      call_id: 'call_custom_image',
      output: [
        { type: 'input_text', text: 'Screenshot attached' },
        { type: 'input_image', image_url: richCustomOutputDataUrl },
        { type: 'input_image', file_id: 'file_custom_image' },
      ],
    }],
  }
}

afterEach(() => {
  fetchMock.mockClear()
  resetCopilotResponseIdAliasesForTests()
})

test('maps a stable streamed response ID back to the Copilot terminal ID', async () => {
  for await (const normalizedEvent of normalizeCopilotResponsesEventStream((async function* () {
    yield {
      event: 'response.created',
      data: '{"type":"response.created","sequence_number":0,"response":{"id":"public-created"}}',
    }
    yield {
      event: 'response.completed',
      data: '{"type":"response.completed","sequence_number":1,"response":{"id":"upstream-terminal"}}',
    }
  })())) {
    // Exhaust the normalizer so it commits the public-to-terminal alias.
    void normalizedEvent
  }

  fetchMock.mockImplementationOnce(
    (_url: string, _opts: { headers: Record<string, string> }) => new Response(JSON.stringify({
      id: 'resp_next',
      object: 'response',
      model: 'gpt-test',
      output: [],
      previous_response_id: 'upstream-terminal',
      status: 'completed',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  const result = await createResponses({
    input: 'continue',
    model: 'gpt-test',
    previous_response_id: 'public-created',
  })

  const body = JSON.parse(
    (fetchMock.mock.calls[0][1] as unknown as { body: string }).body,
  ) as Record<string, unknown>
  expect(body.previous_response_id).toBe('upstream-terminal')
  expect((result.body as { previous_response_id?: string }).previous_response_id).toBe('public-created')
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

test('sets X-Initiator from valid custom tool continuation history', async () => {
  const customToolCall = {
    type: 'custom_tool_call' as const,
    id: 'ctc_call_1',
    call_id: 'call_1',
    name: 'exec_command',
    input: '{"cmd":"pwd"}',
    status: 'completed' as const,
  }
  const customToolCallOutput = {
    type: 'custom_tool_call_output' as const,
    call_id: 'call_1',
    output: 'Chunk ID: abc123\nProcess exited with code 0',
  }

  await createResponses({
    model: 'gpt-test',
    input: [customToolCall, customToolCallOutput, { role: 'user', content: 'continue' }],
  })
  let headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
  expect(headers['X-Initiator']).toBe('agent')

  fetchMock.mockClear()
  await createResponses({
    model: 'gpt-test',
    input: [customToolCallOutput, { role: 'user', content: 'continue' }],
  })
  headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
  expect(headers['X-Initiator']).toBe('user')
})

test('analyzes mixed function and custom tool boundaries by valid model-authored items', () => {
  const customToolCall = {
    type: 'custom_tool_call' as const,
    call_id: 'call_custom',
    name: 'exec_command',
    input: '{"cmd":"pwd"}',
  }
  const customToolCallOutput = {
    type: 'custom_tool_call_output' as const,
    call_id: 'call_custom',
    output: 'ok',
  }
  const functionCall = {
    type: 'function_call' as const,
    call_id: 'call_function',
    name: 'lookup',
    arguments: '{}',
  }
  const functionCallOutput = {
    type: 'function_call_output' as const,
    call_id: 'call_function',
    output: 'ok',
  }

  expect(analyzeResponsesPayloadForCopilot({
    input: [customToolCallOutput, functionCallOutput, { role: 'user', content: 'continue' }],
  })).toEqual({ hasVision: false, initiator: 'user' })
  expect(analyzeResponsesPayloadForCopilot({
    input: [customToolCallOutput, functionCall],
  })).toEqual({ hasVision: false, initiator: 'agent' })
  expect(analyzeResponsesPayloadForCopilot({
    input: [functionCallOutput, customToolCall],
  })).toEqual({ hasVision: false, initiator: 'agent' })
  expect(analyzeResponsesPayloadForCopilot({
    input: [{ role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }, customToolCallOutput],
  })).toEqual({ hasVision: false, initiator: 'agent' })
})

test('does not infer an agent initiator from malformed or nested call type strings', () => {
  const payload = {
    input: [
      null,
      'custom_tool_call',
      { type: 'custom_tool_call' },
      { type: 'custom_tool_call', call_id: 'call_1', name: 'exec_command', input: null },
      { type: 'function_call', call_id: 'call_2', name: 'lookup' },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
      { role: 'assistant', content: null },
      { role: 'user', content: [{ type: 'input_text', text: 'custom_tool_call' }] },
    ],
  } as unknown as Pick<ResponsesPayload, 'input'>

  expect(analyzeResponsesPayloadForCopilot(payload)).toEqual({
    hasVision: false,
    initiator: 'user',
  })
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

test('strips unsupported service_tier before forwarding upstream', async () => {
  for (const serviceTier of ['auto', 'flex', 'fast'] as const) {
    fetchMock.mockClear()
    const payload: ResponsesPayload = {
      model: 'gpt-test',
      input: 'Reply with the single word OK.',
      service_tier: serviceTier,
    }

    await createResponses(payload)

    const body = JSON.parse((fetchMock.mock.calls[0][1] as unknown as { body: string }).body) as Record<string, unknown>
    expect(body).toEqual({
      model: 'gpt-test',
      input: 'Reply with the single word OK.',
    })
    expect(payload.service_tier).toBe(serviceTier)
  }
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
    customToolCalls: 0,
    customToolCallOutputs: 0,
    imageParts: 2,
    inlineDataUrlImages: 2,
    inlineImageChars: firstDataUrl.length + secondDataUrl.length,
    maxInlineImageChars: secondDataUrl.length,
  })
})

test('summarizes custom tool call inputs and outputs separately from function tools', () => {
  const summary = summarizeResponsesPayload({
    model: 'gpt-test',
    input: [
      {
        type: 'custom_tool_call',
        call_id: 'call_1',
        name: 'exec_command',
        input: '{"cmd":"pwd"}',
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'call_1',
        output: 'Chunk ID: abc123\nProcess exited with code 0',
      },
    ],
  })

  expect(summary).toMatchObject({
    functionCalls: 0,
    functionCallOutputs: 0,
    customToolCalls: 1,
    customToolCallOutputs: 1,
  })
})

test('analyzes and summarizes a rich output-only custom tool result', () => {
  const payload = richCustomToolOutputPayload()

  expect(analyzeResponsesPayloadForCopilot(payload)).toEqual({
    hasVision: true,
    initiator: 'user',
  })
  expect(summarizeResponsesPayload(payload)).toEqual({
    model: 'gpt-test',
    stream: false,
    tools: 0,
    inputType: 'array',
    inputItems: 1,
    messageItems: 0,
    functionCalls: 0,
    functionCallOutputs: 0,
    customToolCalls: 0,
    customToolCallOutputs: 1,
    imageParts: 1,
    inlineDataUrlImages: 1,
    inlineImageChars: richCustomOutputDataUrl.length,
    maxInlineImageChars: richCustomOutputDataUrl.length,
  })
})

test('sets the Copilot vision header for rich custom tool output', async () => {
  const payload = richCustomToolOutputPayload()

  await createResponses(payload)

  const request = fetchMock.mock.calls[0][1] as unknown as {
    body: string
    headers: Record<string, string>
  }
  expect(request.headers['copilot-vision-request']).toBe('true')
  expect(request.headers['X-Initiator']).toBe('user')
  expect(JSON.parse(request.body)).toEqual(payload)
})

test('keeps payload analysis and summaries safe for malformed runtime values', () => {
  const malformedPayload = {
    model: 'gpt-test',
    input: [
      null,
      { role: 'user', content: [null] },
      { type: 'function_call_output', call_id: 'call_1', output: [null] },
      { type: 'custom_tool_call_output', call_id: 'call_2', output: 'plain text' },
      { type: 'custom_tool_call_output', call_id: 'call_3', output: [null] },
      { type: 'custom_tool_call_output', call_id: 'call_4', output: null },
    ],
  } as unknown as ResponsesPayload

  expect(analyzeResponsesPayloadForCopilot(malformedPayload)).toEqual({
    hasVision: false,
    initiator: 'user',
  })
  expect(summarizeResponsesPayload(malformedPayload)).toMatchObject({
    customToolCallOutputs: 3,
    functionCallOutputs: 1,
    imageParts: 0,
    inlineDataUrlImages: 0,
    messageItems: 1,
  })
})

test('detects and summarizes rich function_call_output images', async () => {
  const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
  const payload: ResponsesPayload = {
    model: 'gpt-test',
    input: [{
      type: 'function_call_output',
      call_id: 'call_image',
      output: [
        { type: 'input_text', text: 'Screenshot attached' },
        { type: 'input_image', image_url: imageUrl },
      ],
    }],
  }

  await createResponses(payload)
  const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers
  expect(headers['copilot-vision-request']).toBe('true')
  expect(summarizeResponsesPayload(payload)).toEqual({
    model: 'gpt-test',
    stream: false,
    tools: 0,
    inputType: 'array',
    inputItems: 1,
    messageItems: 0,
    functionCalls: 0,
    functionCallOutputs: 1,
    customToolCalls: 0,
    customToolCallOutputs: 0,
    imageParts: 1,
    inlineDataUrlImages: 1,
    inlineImageChars: imageUrl.length,
    maxInlineImageChars: imageUrl.length,
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
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '9',
        'X-Request-Id': 'req_payload_too_large',
      },
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
    expect(jsonError.headers?.get('retry-after')).toBe('9')
    expect(jsonError.headers?.get('x-request-id')).toBe('req_payload_too_large')
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

test('includes rich custom tool output images in a 413 diagnostic', async () => {
  fetchMock.mockImplementationOnce(
    () => new Response(JSON.stringify({
      error: {
        message: 'custom output was too large',
        type: 'invalid_request_error',
        code: 'request_too_large',
      },
    }), {
      status: 413,
      headers: { 'Content-Type': 'application/json' },
    }),
  )

  const error = await createResponses(richCustomToolOutputPayload()).catch((reason: unknown) => reason)

  expect(error).toBeInstanceOf(JSONResponseError)
  const jsonError = error as JSONResponseError
  const errorPayload = jsonError.payload as { error: { message: string } }
  expect(errorPayload.error.message).toContain('image_parts=1')
  expect(errorPayload.error.message).toContain('data_url_images=1')
  expect(errorPayload.error.message).toContain(`inline_image_chars=${richCustomOutputDataUrl.length}`)
  expect(errorPayload.error.message).toContain(`max_inline_image_chars=${richCustomOutputDataUrl.length}`)
  expect(errorPayload.error.message).toContain('upstream_message=custom output was too large')
})
