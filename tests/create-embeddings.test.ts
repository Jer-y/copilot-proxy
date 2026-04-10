import type { EmbeddingRequest } from '../src/services/copilot/create-embeddings'

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'
import { createEmbeddings } from '../src/services/copilot/create-embeddings'

const originalFetch = globalThis.fetch

state.copilotToken = 'test-token'
state.vsCodeVersion = '1.0.0'
state.accountType = 'individual'

const fetchMock = mock(async (_url: string, _init?: RequestInit): Promise<Response> => {
  return new Response(JSON.stringify({
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 2, total_tokens: 2 },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})

beforeEach(() => {
  fetchMock.mockClear()
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
