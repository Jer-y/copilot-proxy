import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

const originalFetch = globalThis.fetch
const upstreamCalls: Array<{ url: string, body: Record<string, unknown> | undefined }> = []
const encoder = new TextEncoder()
type FetchInput = Parameters<typeof fetch>[0]

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'mock-request-id',
      ...(init?.headers ?? {}),
    },
  })
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events
    .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'x-request-id': 'mock-stream-request-id',
    },
  })
}

async function defaultFetchMock(input: FetchInput, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const body = typeof init?.body === 'string'
    ? JSON.parse(init.body) as Record<string, unknown>
    : undefined
  upstreamCalls.push({ url, body })

  if (url.endsWith('/v1/messages')) {
    if (body?.stream) {
      return sseResponse([
        {
          type: 'message_start',
          message: {
            id: 'msg_stream_mock',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        },
      ])
    }

    return jsonResponse({
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: body?.model ?? 'unknown',
      content: [{ type: 'text', text: 'ok from anthropic mock' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  if (url.endsWith('/responses')) {
    return jsonResponse({
      id: 'resp_mock',
      object: 'response',
      model: body?.model ?? 'unknown',
      output: [
        {
          type: 'message',
          id: 'msg_resp_mock',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'ok from responses mock' }],
        },
      ],
      status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    })
  }

  return jsonResponse({ error: { message: `unexpected upstream ${url}` } }, { status: 500 })
}

beforeEach(() => {
  upstreamCalls.length = 0
  state.lastRequestTimestamp = undefined
  state.models = undefined
  state.copilotToken = 'test-copilot-token'
  state.vsCodeVersion = '1.99.0'
  state.accountType = 'individual'
  state.manualApprove = false
  state.rateLimitWait = false
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = defaultFetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

async function post(path: string, payload: unknown): Promise<Response> {
  return await server.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

describe('review-confirmed real route regressions', () => {
  test('Responses to Anthropic translation rejects replayed reasoning input items', async () => {
    const response = await post('/v1/responses', {
      model: 'claude-opus-4.6',
      store: false,
      input: [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'prior reasoning' }],
        },
        { role: 'user', content: 'continue' },
      ],
    })

    expect(response.status).toBe(400)
    expect(upstreamCalls).toHaveLength(0)
    expect(await response.json()).toMatchObject({
      error: {
        type: 'invalid_request_error',
        message: expect.stringContaining('reasoning input items cannot be represented'),
      },
    })
  })

  test('Responses-backed models forward replayed reasoning input items unchanged', async () => {
    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_direct',
      summary: [],
      encrypted_content: 'opaque-upstream-state',
    }
    const userMessage = { role: 'user', content: 'continue' }

    const response = await post('/v1/responses', {
      model: 'gpt-5.4',
      store: false,
      input: [reasoningItem, userMessage],
    })

    expect(response.status).toBe(200)
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]?.url.endsWith('/responses')).toBe(true)
    expect(upstreamCalls[0]?.body?.input).toEqual([reasoningItem, userMessage])
  })

  test('Anthropic custom tools with type=custom translate to Responses function tools', async () => {
    const response = await post('/v1/messages', {
      model: 'gpt-5.4',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Call noop.' }],
      tools: [
        { type: 'custom', name: 'noop', input_schema: { type: 'object', properties: {} } },
      ],
    })

    expect(response.status).toBe(200)
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]?.url.endsWith('/responses')).toBe(true)
    expect(upstreamCalls[0]?.body?.tools).toEqual([
      {
        type: 'function',
        name: 'noop',
        parameters: { type: 'object', properties: {} },
      },
    ])
  })

  test('Responses to Anthropic translation normalizes dated Claude aliases upstream', async () => {
    const response = await post('/v1/responses', {
      model: 'claude-sonnet-4-5-20250929',
      store: false,
      input: 'hello',
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { model: string }
    expect(body.model).toBe('claude-sonnet-4-5-20250929')
    expect(upstreamCalls[0]?.body?.model).toBe('claude-sonnet-4.5')
  })

  test('Anthropic to Responses streaming reports upstream EOF after visible text as failed', async () => {
    const response = await post('/v1/responses', {
      model: 'claude-opus-4.6',
      store: false,
      input: 'stream please',
      stream: true,
    })

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('event: response.output_text.delta')
    expect(text).toContain('event: response.failed')
    expect(text).not.toContain('event: response.completed')
  })

  test('direct Responses streaming aborts upstream when the client disconnects', async () => {
    let upstreamAbortCalled = false
    let resolveAbort: () => void = () => {}
    const upstreamAbortPromise = new Promise<void>((resolve) => {
      resolveAbort = resolve
    })
    let timer: Timer | undefined
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined

    globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
      const url = String(input)
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { stream?: boolean }
        : {}
      if (!url.endsWith('/responses') || !body.stream) {
        return jsonResponse({ error: { message: `unexpected upstream ${url}` } }, { status: 500 })
      }

      init?.signal?.addEventListener('abort', () => {
        upstreamAbortCalled = true
        resolveAbort()
        if (timer)
          clearInterval(timer)
        try {
          controllerRef?.close()
        }
        catch {}
      })

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller
          let index = 0
          timer = setInterval(() => {
            const event = index === 0
              ? {
                  type: 'response.created',
                  response: {
                    id: 'resp_cancel',
                    object: 'response',
                    model: 'gpt-5.4',
                    output: [],
                    status: 'in_progress',
                  },
                }
              : {
                  type: 'response.output_text.delta',
                  output_index: 0,
                  content_index: 0,
                  delta: `chunk-${index}`,
                }
            controller.enqueue(encoder.encode(`event: ${event.type}\n`))
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            index++
          }, 20)
        },
        cancel() {
          upstreamAbortCalled = true
          if (timer)
            clearInterval(timer)
        },
      })

      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as typeof fetch

    const response = await server.request('/v1/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body: JSON.stringify({
        model: 'gpt-5.4',
        input: 'stream and wait',
        stream: true,
      }),
    })

    const reader = response.body!.getReader()
    const firstRead = await reader.read()
    expect(firstRead.done).toBe(false)
    await reader.cancel('client stopped after first chunk')
    await Promise.race([
      upstreamAbortPromise,
      new Promise(resolve => setTimeout(resolve, 500)),
    ])
    expect(upstreamAbortCalled).toBe(true)
  })
})
