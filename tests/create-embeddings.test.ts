import type { EmbeddingRequest } from '../src/services/copilot/create-embeddings'

import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'
import { server } from '../src/server'
import { createEmbeddings } from '../src/services/copilot/create-embeddings'

const originalFetch = globalThis.fetch

state.copilotToken = 'test-token'
state.vsCodeVersion = '1.0.0'
state.accountType = 'individual'

async function defaultFetchMock(_url: string, init?: RequestInit): Promise<Response> {
  const request = JSON.parse(String(init?.body)) as { input: Array<string> }
  return new Response(JSON.stringify({
    object: 'list',
    data: request.input.map((_, index) => ({
      object: 'embedding',
      index,
      embedding: [0.1, 0.2, 0.3],
    })),
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 2, total_tokens: 2 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fetchMock = mock(defaultFetchMock)

beforeEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(defaultFetchMock)
  state.lastRequestTimestamp = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  // @ts-expect-error test mock only needs callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('normalizes string embedding input to an array before forwarding', async () => {
  const payload: EmbeddingRequest = {
    model: 'text-embedding-3-small',
    input: 'hello world',
  }

  await createEmbeddings(payload)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const forwarded = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
    input: Array<string>
  }
  expect(forwarded.input).toEqual(['hello world'])
})

test('preserves array embedding input when already batched', async () => {
  const payload: EmbeddingRequest = {
    model: 'text-embedding-3-small',
    input: ['hello', 'world'],
  }

  await createEmbeddings(payload)

  expect(fetchMock).toHaveBeenCalledTimes(1)
  const forwarded = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as {
    input: Array<string>
  }
  expect(forwarded.input).toEqual(['hello', 'world'])
})

test('returns explicit base64 embeddings as little-endian Float32 bytes and preserves request options', async () => {
  const response = await server.request('/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: 'hello world',
      encoding_format: 'base64',
      dimensions: 3,
      user: 'user-123',
    }),
  })

  expect(response.status).toBe(200)
  const body = await response.json() as {
    data: Array<{ embedding: string }>
  }
  expect(typeof body.data[0]?.embedding).toBe('string')
  expect(body.data[0]?.embedding).toBe('zczMPc3MTD6amZk+')

  const bytes = Buffer.from(body.data[0]!.embedding, 'base64')
  expect(bytes.byteLength).toBe(3 * Float32Array.BYTES_PER_ELEMENT)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getFloat32(0, true)).toBeCloseTo(0.1)
  expect(view.getFloat32(4, true)).toBeCloseTo(0.2)
  expect(view.getFloat32(8, true)).toBeCloseTo(0.3)

  const forwarded = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>
  expect(forwarded).toMatchObject({
    input: ['hello world'],
    model: 'text-embedding-3-small',
    encoding_format: 'base64',
    dimensions: 3,
    user: 'user-123',
  })
})

test('preserves a valid Float32 base64 embedding returned by upstream', async () => {
  const bytes = Buffer.alloc(2 * Float32Array.BYTES_PER_ELEMENT)
  bytes.writeFloatLE(0.25, 0)
  bytes.writeFloatLE(-0.5, Float32Array.BYTES_PER_ELEMENT)
  const upstreamEmbedding = bytes.toString('base64')
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({
    object: 'list',
    data: [{
      object: 'embedding',
      index: 0,
      embedding: upstreamEmbedding,
    }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 2, total_tokens: 2 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))

  const result = await createEmbeddings({
    model: 'text-embedding-3-small',
    input: 'hello world',
    encoding_format: 'base64',
  })

  expect(result.body.data[0]?.embedding).toBe(upstreamEmbedding)
})

test('does not turn an upstream AbortError into an empty embeddings response', async () => {
  fetchMock.mockImplementation(async () => {
    const error = new Error('embeddings upstream connection aborted')
    error.name = 'AbortError'
    throw error
  })

  const response = await server.request('/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: 'hello world',
    }),
  })

  expect(response.status).toBe(502)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(await response.json()).toEqual({
    error: {
      message: 'embeddings upstream connection aborted',
      type: 'api_error',
      code: 'upstream_connection_aborted',
    },
  })
})
