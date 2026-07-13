import { beforeEach, expect, mock, test } from 'bun:test'
import consola from 'consola'

import { ResponsesPayloadSchema } from '../src/lib/schemas'
import { state } from '../src/lib/state'
import { server } from '../src/server'

state.copilotToken = 'test-token'
state.vsCodeVersion = '1.0.0'
state.accountType = 'individual'

async function defaultFetchImplementation(_url: string, _opts?: RequestInit) {
  return new Response(JSON.stringify({
    error: {
      message: 'failed to parse request',
      type: 'invalid_request_error',
      code: '',
    },
  }), {
    status: 413,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fetchMock = mock(defaultFetchImplementation)
const encoder = new TextEncoder()

// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(defaultFetchImplementation)
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  state.models = undefined
})

function createErroringSSE(
  chunks: string[],
  message: string,
  errorName = 'Error',
  errorDelayMs = 0,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
        return
      }

      if (errorDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, errorDelayMs))
      }
      const error = new Error(message)
      error.name = errorName
      controller.error(error)
    },
  })
}

function getSSEEventData(body: string, eventName: string): Record<string, unknown> {
  const frame = body.split('\n\n').find(part => part.split('\n').includes(`event: ${eventName}`))
  const data = frame?.split('\n').find(line => line.startsWith('data: '))?.slice(6)
  if (!data) {
    throw new Error(`Missing SSE event ${eventName}`)
  }
  return JSON.parse(data) as Record<string, unknown>
}

test('official nullable fields and rich function outputs pass Responses request validation', () => {
  const parsed = ResponsesPayloadSchema.safeParse({
    model: 'gpt-5.4',
    instructions: null,
    stream: null,
    input: [{
      type: 'function_call',
      call_id: 'call_1',
      name: 'noop',
      arguments: '{}',
      status: 'incomplete',
    }, {
      type: 'function_call_output',
      call_id: 'call_1',
      status: null,
      output: [
        { type: 'input_text', text: 'tool text' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        { type: 'input_image', image_url: null, file_id: 'file_1' },
        { type: 'input_file', file_id: 'file_1' },
      ],
    }],
  })

  expect(parsed.success).toBe(true)
})

test('official nullable fields and rich function outputs are forwarded on a direct Responses route', async () => {
  let upstreamBody: Record<string, unknown> | undefined
  fetchMock.mockImplementation(async (_url, init) => {
    upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      id: 'resp_nullable',
      object: 'response',
      model: 'gpt-5.4',
      output: [],
      status: 'completed',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'noop',
        arguments: '{}',
      }, {
        type: 'function_call_output',
        call_id: 'call_1',
        output: [
          { type: 'input_text', text: 'tool text' },
          { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
        ],
      }],
      instructions: null,
      stream: null,
    }),
  })

  expect(response.status).toBe(200)
  expect(upstreamBody).toMatchObject({
    instructions: null,
    stream: null,
    input: [{
      type: 'function_call',
      call_id: 'call_1',
      name: 'noop',
      arguments: '{}',
    }, {
      type: 'function_call_output',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: 'tool text' },
        { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' },
      ],
    }],
  })
})

test('/v1/responses official subroutes are forwarded to the Copilot backend', async () => {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    return new Response(JSON.stringify({
      ok: true,
      url,
      method: opts?.method,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'anthropic-ratelimit-requests-limit': '100',
        'cache-creation-input-tokens': '12',
        'x-request-id': 'req_forwarded',
      },
    })
  })

  const cases = [
    {
      localPath: '/v1/responses/input_tokens',
      upstreamUrl: 'https://api.githubcopilot.com/responses/input_tokens',
      method: 'POST',
      body: { model: 'gpt-5.5', input: 'hello' },
    },
    {
      localPath: '/v1/responses/compact',
      upstreamUrl: 'https://api.githubcopilot.com/responses/compact',
      method: 'POST',
      body: { model: 'gpt-5.5', input: 'hello' },
    },
    {
      localPath: '/v1/responses/resp_123?include[]=reasoning.encrypted_content',
      upstreamUrl: 'https://api.githubcopilot.com/responses/resp_123?include[]=reasoning.encrypted_content',
      method: 'GET',
    },
    {
      localPath: '/v1/responses/resp_123/input_items?limit=1',
      upstreamUrl: 'https://api.githubcopilot.com/responses/resp_123/input_items?limit=1',
      method: 'GET',
    },
    {
      localPath: '/v1/responses/resp_123/cancel',
      upstreamUrl: 'https://api.githubcopilot.com/responses/resp_123/cancel',
      method: 'POST',
    },
    {
      localPath: '/v1/responses/resp_123',
      upstreamUrl: 'https://api.githubcopilot.com/responses/resp_123',
      method: 'DELETE',
    },
  ] as const

  for (const item of cases) {
    const hasBody = 'body' in item
    const response = await server.request(item.localPath, {
      method: item.method,
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(item.body) : undefined,
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('x-request-id')).toBe('req_forwarded')
    expect(response.headers.get('anthropic-ratelimit-requests-limit')).toBe('100')
    expect(response.headers.get('cache-creation-input-tokens')).toBe('12')
  }

  expect(fetchMock.mock.calls.map(call => ({
    url: call[0],
    method: (call[1] as RequestInit | undefined)?.method,
  }))).toEqual(cases.map(item => ({
    url: item.upstreamUrl,
    method: item.method,
  })))
})

test('/v1/responses surfaces upstream 413 with request-size diagnostics', async () => {
  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'inspect this' },
            { type: 'input_image', image_url: 'data:image/png;base64,abcdef' },
          ],
        },
      ],
    }),
  })

  expect(response.status).toBe(413)

  const json = await response.json() as {
    error: {
      message: string
      type: string
      code: string
    }
  }

  expect(json.error.type).toBe('invalid_request_error')
  expect(json.error.code).toBe('payload_too_large')
  expect(json.error.message).toContain('Upstream /responses rejected the request with 413 Payload Too Large.')
  expect(json.error.message).toContain('data_url_images=1')
  expect(json.error.message).toContain('inline_image_chars=28')
})

test('/v1/responses streaming surfaces upstream stream errors as SSE error events', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (!url.endsWith('/responses')) {
      throw new Error(`Unexpected upstream URL: ${url}`)
    }

    return new Response(createErroringSSE([
      [
        'event: response.created',
        'data: {"type":"response.created","sequence_number":7,"response":{"id":"resp_stream_error","object":"response","model":"gpt-5.4","output":[],"status":"in_progress","error":null}}',
        '',
        '',
      ].join('\n'),
    ], 'stream failed'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: 'Say hello.',
      stream: true,
    }),
  })

  expect(response.status).toBe(200)

  const body = await response.text()
  expect(body).toContain('event: response.created')
  expect(body).toContain('event: error')
  expect(body).toContain('"type":"error"')
  expect(body).toContain('"message":"stream failed"')
  expect(body).toContain('"code":"stream_error"')
  expect(body).not.toContain('data: [DONE]')
  expect(getSSEEventData(body, 'error')).toEqual({
    type: 'error',
    code: 'stream_error',
    message: 'stream failed',
    param: null,
    sequence_number: 8,
  })
})

test('/v1/responses does not turn an upstream AbortError into an empty 200 response', async () => {
  fetchMock.mockImplementation(async () => {
    const error = new Error('upstream connection aborted')
    error.name = 'AbortError'
    throw error
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: 'Say hello.',
    }),
  })

  expect(response.status).toBe(502)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(await response.json()).toEqual({
    error: {
      message: 'upstream connection aborted',
      type: 'api_error',
      code: 'upstream_connection_aborted',
    },
  })
})

test('/v1/responses streaming reports AbortError when the client stream is still open', async () => {
  fetchMock.mockImplementation(async () => {
    return new Response(createErroringSSE([
      [
        'event: response.created',
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_abort_error","object":"response","model":"gpt-5.4","output":[],"status":"in_progress","error":null}}',
        '',
        '',
      ].join('\n'),
    ], 'upstream stream aborted', 'AbortError'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: 'Say hello.',
      stream: true,
    }),
  })

  const body = await response.text()
  expect(response.status).toBe(200)
  expect(body).toContain('event: response.created')
  expect(getSSEEventData(body, 'error')).toEqual({
    type: 'error',
    code: 'stream_error',
    message: 'upstream stream aborted',
    param: null,
    sequence_number: 1,
  })
  expect(body).not.toContain('data: [DONE]')
})

test('/v1/responses streaming ignores a transport AbortError after response.completed', async () => {
  fetchMock.mockImplementation(async () => {
    return new Response(createErroringSSE([
      [
        'event: response.created',
        'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_terminal_abort","object":"response","model":"gpt-5.4","output":[],"status":"in_progress","error":null}}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","sequence_number":1,"response":{"id":"resp_terminal_abort","object":"response","model":"gpt-5.4","output":[],"status":"completed","error":null}}',
        '',
        '',
      ].join('\n'),
    ], 'upstream socket closed after terminal event', 'AbortError', 25), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: 'Say hello.',
      stream: true,
    }),
  })

  const body = await response.text()
  expect(response.status).toBe(200)
  expect(body).toContain('event: response.completed')
  expect(body).not.toContain('event: error')
  expect(body).not.toContain('upstream socket closed after terminal event')
})

test('/v1/responses streaming emits an error when upstream closes before a terminal event', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (!url.endsWith('/responses')) {
      throw new Error(`Unexpected upstream URL: ${url}`)
    }

    return new Response([
      'event: response.created',
      'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_truncated","object":"response","model":"gpt-5.4","output":[],"status":"in_progress","error":null}}',
      '',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: 'Say hello.',
      stream: true,
    }),
  })

  const body = await response.text()
  expect(response.status).toBe(200)
  expect(body).toContain('event: response.created')
  expect(body).toContain('event: error')
  expect(body).toContain('terminated before a terminal response event')
  expect(body).not.toContain('data: [DONE]')
  expect(getSSEEventData(body, 'error')).toMatchObject({
    type: 'error',
    code: 'stream_error',
    param: null,
    sequence_number: 1,
  })
})

test('/v1/responses turns HTTP 200 error-shaped payloads into a 502', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (!url.endsWith('/responses')) {
      throw new Error(`Unexpected upstream URL: ${url}`)
    }

    return new Response(JSON.stringify({
      error: {
        message: 'upstream returned an error-shaped JSON body',
        type: 'invalid_request_error',
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: 'Say hello.',
    }),
  })

  expect(response.status).toBe(502)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(await response.json()).toEqual({
    error: {
      message: 'Invalid Copilot /responses response: upstream returned an invalid success payload',
      type: 'api_error',
      code: 'invalid_upstream_response',
    },
  })
})

test('/v1/responses translated Anthropic streaming surfaces upstream stream errors as Responses SSE error events', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (!url.endsWith('/v1/messages')) {
      throw new Error(`Unexpected upstream URL: ${url}`)
    }

    return new Response(createErroringSSE([], 'anthropic stream failed'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4.6',
      store: false,
      input: 'Say hello.',
      stream: true,
    }),
  })

  expect(response.status).toBe(200)

  const body = await response.text()
  expect(body).toContain('event: error')
  expect(body).toContain('"type":"error"')
  expect(body).toContain('"message":"anthropic stream failed"')
  expect(body).toContain('"code":"stream_error"')
  expect(body).not.toContain('data: [DONE]')
  expect(getSSEEventData(body, 'error')).toEqual({
    type: 'error',
    code: 'stream_error',
    message: 'anthropic stream failed',
    param: null,
    sequence_number: 0,
  })
})

test('/v1/responses translated Anthropic stream ignores AbortError after message_stop', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (!url.endsWith('/v1/messages')) {
      throw new Error(`Unexpected upstream URL: ${url}`)
    }

    return new Response(createErroringSSE([
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_terminal_abort","type":"message","role":"assistant","content":[],"model":"claude-opus-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
        '',
        'event: message_delta',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
        '',
        'event: message_stop',
        'data: {"type":"message_stop"}',
        '',
        '',
      ].join('\n'),
    ], 'Anthropic socket closed after message_stop', 'AbortError', 25), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4.6',
      store: false,
      input: 'Say hello.',
      stream: true,
    }),
  })

  const body = await response.text()
  expect(response.status).toBe(200)
  expect(body).toContain('event: response.completed')
  expect(body).not.toContain('event: response.failed')
  expect(body).not.toContain('event: error')
  expect(body).not.toContain('Anthropic socket closed after message_stop')
})

test('/v1/responses translated non-streaming responses echo verified request fields', async () => {
  const schema = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  }
  const tools = [{
    type: 'function',
    name: 'lookup',
    description: 'Look up a value.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    strict: true,
  }]

  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/v1/messages')) {
      throw new Error(`Unexpected upstream URL: ${url}`)
    }

    const upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(upstreamBody).toMatchObject({
      temperature: 0.25,
      top_p: 0.75,
      output_config: {
        effort: 'xhigh',
        format: { type: 'json_schema', schema },
      },
      tool_choice: {
        type: 'tool',
        name: 'lookup',
        disable_parallel_tool_use: true,
      },
    })

    return Response.json({
      id: 'msg_echo_fields',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.6',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 1 },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4.6',
      store: false,
      instructions: 'Reply with exactly ECHO_OK.',
      max_output_tokens: 64,
      metadata: { trace_id: 'trace_non_stream' },
      temperature: 0.25,
      top_p: 0.75,
      parallel_tool_calls: false,
      reasoning: { effort: 'xhigh', summary: 'none' },
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema,
          strict: true,
        },
      },
      tool_choice: { type: 'function', name: 'lookup' },
      tools,
      input: 'Say hello.',
    }),
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    instructions: 'Reply with exactly ECHO_OK.',
    max_output_tokens: 64,
    metadata: { trace_id: 'trace_non_stream' },
    temperature: 0.25,
    top_p: 0.75,
    parallel_tool_calls: false,
    reasoning: { effort: 'xhigh', summary: null },
    text: {
      format: {
        type: 'json_schema',
        name: 'answer',
        schema,
        strict: true,
      },
    },
    tool_choice: { type: 'function', name: 'lookup' },
    tools,
    previous_response_id: null,
    store: false,
  })
})

test('/v1/responses translated streams echo verified request fields in created and terminal events', async () => {
  const schema = {
    type: 'object',
    properties: { value: { type: 'integer' } },
    required: ['value'],
    additionalProperties: false,
  }
  const tools = [{
    type: 'function',
    name: 'stream_lookup',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  }]

  fetchMock.mockImplementation(async (url: string) => {
    if (!url.endsWith('/v1/messages')) {
      throw new Error(`Unexpected upstream URL: ${url}`)
    }
    return new Response([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_echo_stream","type":"message","role":"assistant","content":[],"model":"claude-opus-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4.6',
      store: false,
      stream: true,
      instructions: 'Reply with exactly STREAM_ECHO_OK.',
      max_output_tokens: 80,
      metadata: null,
      temperature: null,
      top_p: 0.6,
      parallel_tool_calls: false,
      reasoning: { effort: 'none', summary: 'none' },
      text: {
        format: {
          type: 'json_schema',
          name: 'stream_answer',
          schema,
          strict: true,
        },
      },
      tool_choice: 'required',
      tools,
      input: 'Say hello.',
    }),
  })

  const body = await response.text()
  expect(response.status).toBe(200)
  for (const eventName of ['response.created', 'response.in_progress', 'response.completed']) {
    expect(getSSEEventData(body, eventName)).toMatchObject({
      response: {
        instructions: 'Reply with exactly STREAM_ECHO_OK.',
        max_output_tokens: 80,
        metadata: null,
        temperature: null,
        top_p: 0.6,
        parallel_tool_calls: false,
        reasoning: { effort: 'none', summary: null },
        text: {
          format: {
            type: 'json_schema',
            name: 'stream_answer',
            schema,
            strict: true,
          },
        },
        tool_choice: 'required',
        tools,
        previous_response_id: null,
        store: false,
      },
    })
  }
})

test('/v1/responses translated Anthropic clean EOF emits response.failed without message_stop', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (!url.endsWith('/v1/messages')) {
      throw new Error(`Unexpected upstream URL: ${url}`)
    }

    return new Response([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_truncated","type":"message","role":"assistant","content":[],"model":"claude-opus-4.8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
      '',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4.8',
      store: false,
      input: 'Say hello.',
      stream: true,
    }),
  })

  const body = await response.text()
  expect(response.status).toBe(200)
  expect(body).toContain('event: response.output_text.delta')
  expect(body).toContain('event: response.failed')
  expect(body).toContain('upstream_stream_terminated')
  expect(body).not.toContain('event: response.completed')
})

test('/v1/responses rejects external image URLs locally before forwarding upstream', async () => {
  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Inspect this image.' },
            { type: 'input_image', image_url: 'https://example.com/image.png' },
          ],
        },
      ],
    }),
  })

  expect(response.status).toBe(400)
  expect(fetchMock).toHaveBeenCalledTimes(0)

  const json = await response.json() as {
    error: {
      message: string
      type: string
    }
  }

  expect(json.error.type).toBe('invalid_request_error')
  expect(json.error.message).toContain('external image URLs')
})
test('/v1/responses rejects top-level typed external image URLs locally before forwarding upstream', async () => {
  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: [
        {
          type: 'input_image',
          image_url: 'https://example.com/image.png',
        },
      ],
    }),
  })

  expect(response.status).toBe(400)
  expect(fetchMock).toHaveBeenCalledTimes(0)

  const json = await response.json() as {
    error: {
      message: string
      type: string
    }
  }

  expect(json.error.type).toBe('invalid_request_error')
  expect(json.error.message).toContain('external image URLs')
})

test('/v1/responses fills a missing OpenAI error type from the HTTP status', async () => {
  fetchMock.mockImplementation(async () => {
    return Response.json({
      error: {
        message: 'external files are not supported',
        code: 'invalid_request_body',
      },
    }, { status: 400 })
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'hi' }),
  })

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({
    error: {
      message: 'external files are not supported',
      code: 'invalid_request_body',
      type: 'invalid_request_error',
    },
  })
})

test('/v1/responses wraps non-JSON upstream errors and preserves safe headers', async () => {
  fetchMock.mockImplementation(async () => {
    return new Response('404 page not found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
        'Retry-After': '7',
        'X-Request-Id': 'req_non_json',
        'X-RateLimit-Remaining': '12',
        'Set-Cookie': 'secret=not-forwarded',
      },
    })
  })

  const response = await server.request('/v1/responses/resp_missing')

  expect(response.status).toBe(404)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(response.headers.get('retry-after')).toBe('7')
  expect(response.headers.get('x-request-id')).toBe('req_non_json')
  expect(response.headers.get('x-ratelimit-remaining')).toBe('12')
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(await response.json()).toEqual({
    error: {
      message: '404 page not found',
      type: 'invalid_request_error',
    },
  })
})

test('/v1/responses strips service_tier before forwarding upstream', async () => {
  fetchMock.mockImplementation(async () => {
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
  })

  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-5.4',
      input: 'Reply with the single word OK.',
      service_tier: 'auto',
    }),
  })

  expect(response.status).toBe(200)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  const upstreamBody = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>
  expect(upstreamBody).toEqual({
    model: 'gpt-5.4',
    input: 'Reply with the single word OK.',
  })
})

test('/v1/responses rejects stateful fields before Anthropic translation reaches upstream', async () => {
  const cases = [
    { previous_response_id: 'resp_prior' },
    { background: true },
    { conversation: { id: 'conv_1' } },
    { prompt: { id: 'pmpt_1' } },
    { max_tool_calls: 1 },
    { context_management: [{ type: 'compaction' }] },
    { truncation: 'auto' },
    { tool_choice: { type: 'allowed_tools', mode: 'required', tools: [] } },
  ]

  for (const extra of cases) {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        input: 'hi',
        ...extra,
      }),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { type: string } }
    expect(body.error.type).toBe('invalid_request_error')
  }

  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test('/v1/responses rejects unknown message content parts before Anthropic translation reaches upstream', async () => {
  for (const role of ['user', 'assistant'] as const) {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        store: false,
        input: [{
          role,
          content: [{ type: 'input_audio', audio: 'opaque' }],
        }],
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        message: `Unsupported Responses ${role} content part type "input_audio" for anthropic-messages translation.`,
      },
    })
  }

  expect(fetchMock).toHaveBeenCalledTimes(0)
})

test('/v1/responses translated json_schema omits the Responses-only name on the Anthropic wire', async () => {
  const sentinel = 'HANDLER_PROMPT_SECRET_SENTINEL'
  const schema = {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  }
  const debugLogs: string[] = []
  const originalDebug = consola.debug
  const originalLevel = consola.level
  consola.level = 4
  consola.debug = mock((...args: unknown[]) => {
    debugLogs.push(args.map(value => String(value)).join(' '))
  }) as unknown as typeof consola.debug

  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    expect(url.endsWith('/v1/messages')).toBe(true)
    const upstreamBody = JSON.parse(String(opts?.body)) as {
      output_config: { format: Record<string, unknown> }
    }
    expect(upstreamBody.output_config.format).toEqual({
      type: 'json_schema',
      schema,
    })

    return new Response(JSON.stringify({
      id: 'msg_json_schema',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-4.6',
      content: [{ type: 'text', text: '{"value":"ok"}' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 4 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  try {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        store: false,
        input: sentinel,
        text: {
          format: {
            type: 'json_schema',
            name: 'answer',
            schema,
            strict: true,
          },
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema,
          strict: true,
        },
      },
    })
  }
  finally {
    consola.debug = originalDebug
    consola.level = originalLevel
  }

  expect(debugLogs.join('\n')).not.toContain(sentinel)
})

test('/v1/responses malformed translated Anthropic SSE fails once without logging raw data', async () => {
  const sentinel = 'MALFORMED_SSE_SECRET_SENTINEL'
  const errorLogs: string[] = []
  const originalError = consola.error
  consola.error = mock((...args: unknown[]) => {
    errorLogs.push(args.map(value => String(value)).join(' '))
  }) as unknown as typeof consola.error

  fetchMock.mockImplementation(async (url: string) => {
    expect(url.endsWith('/v1/messages')).toBe(true)
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_bad_sse","type":"message","role":"assistant","content":[],"model":"claude-opus-4.6","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      `event: content_block_delta\ndata: {"type":"content_block_delta","secret":"${sentinel}"\n\n`,
    ].join('')
    return new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  })

  let body = ''
  try {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        store: false,
        input: 'hi',
        stream: true,
      }),
    })
    expect(response.status).toBe(200)
    body = await response.text()
  }
  finally {
    consola.error = originalError
  }

  expect(body.match(/"type":"response.failed"/g)).toHaveLength(1)
  expect(body).not.toContain('"type":"response.completed"')
  expect(errorLogs.join('\n')).not.toContain(sentinel)
})

test('/v1/responses normalizes Anthropic upstream errors without leaking their body to logs', async () => {
  const sentinel = 'UPSTREAM_ERROR_SECRET_SENTINEL'
  const errorLogs: string[] = []
  const originalError = consola.error
  consola.error = mock((...args: unknown[]) => {
    errorLogs.push(args.map(value => String(value)).join(' '))
  }) as unknown as typeof consola.error

  fetchMock.mockImplementation(async () => {
    return new Response(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: sentinel,
      },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  })

  try {
    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4.6',
        store: false,
        input: 'hi',
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        type: 'invalid_request_error',
        message: sentinel,
      },
    })
  }
  finally {
    consola.error = originalError
  }

  expect(errorLogs.join('\n')).not.toContain(sentinel)
})

// EOF
