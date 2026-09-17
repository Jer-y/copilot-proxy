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

async function defaultFetchMock(input: FetchInput, init?: RequestInit): Promise<Response> {
  const url = String(input)
  const body = typeof init?.body === 'string'
    ? JSON.parse(init.body) as Record<string, unknown>
    : undefined
  upstreamCalls.push({ url, body })

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
  test('Responses-backed models forward complete stateless replay output unchanged', async () => {
    const firstUserMessage = { role: 'user', content: 'Call remember_code.' }
    const reasoningItem = {
      type: 'reasoning',
      id: 'first_seen_reasoning_id',
      summary: [],
      encrypted_content: 'opaque-upstream-state',
    }
    const functionCallItem = {
      type: 'function_call',
      id: 'first_seen_function_id',
      call_id: 'call_replay_exact',
      name: 'remember_code',
      arguments: '{"code":"RUNTIME_ONLY"}',
    }
    const functionCallOutput = {
      type: 'function_call_output',
      call_id: 'call_replay_exact',
      output: 'Code stored successfully.',
    }
    const secondUserMessage = { role: 'user', content: 'Which code was stored?' }
    const replayInput = [
      firstUserMessage,
      reasoningItem,
      functionCallItem,
      functionCallOutput,
      secondUserMessage,
    ]

    const response = await post('/v1/responses', {
      model: 'gpt-5.4',
      store: false,
      include: ['reasoning.encrypted_content'],
      input: replayInput,
    })

    expect(response.status).toBe(200)
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]?.url.endsWith('/responses')).toBe(true)
    expect(upstreamCalls[0]?.body?.input).toEqual(replayInput)
    expect(upstreamCalls[0]?.body?.include).toEqual(['reasoning.encrypted_content'])
    expect(upstreamCalls[0]?.body?.store).toBe(false)
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
