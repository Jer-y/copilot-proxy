import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'
import { server } from '../src/server'

const originalFetch = globalThis.fetch
const originalNormalize = state.normalizeOpenAIResponsesItemIds

function event(type: string, payload: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

// A single message item (output_index 0) where the upstream emits a DIFFERENT
// opaque id on every SSE event — the per-event id churn this feature targets.
const CHURNED_SSE = [
  event('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', id: 'm_added', role: 'assistant', content: [] },
  }),
  event('response.content_part.added', {
    type: 'response.content_part.added',
    output_index: 0,
    content_index: 0,
    item_id: 'm_cp_added',
    part: { type: 'output_text', text: '' },
  }),
  event('response.output_text.delta', {
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    item_id: 'm_delta',
    delta: 'pong',
  }),
  event('response.output_text.done', {
    type: 'response.output_text.done',
    output_index: 0,
    content_index: 0,
    item_id: 'm_txt_done',
    text: 'pong',
  }),
  event('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'message', id: 'm_done', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
  }),
  event('response.completed', {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      object: 'response',
      model: 'gpt-5.4',
      status: 'completed',
      output: [{ type: 'message', id: 'm_final', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }],
    },
  }),
].join('')

const fetchMock = mock(async (url: string): Promise<Response> => {
  if (!url.endsWith('/responses')) {
    throw new Error(`Unexpected upstream URL: ${url}`)
  }
  return new Response(CHURNED_SSE, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
})

beforeEach(() => {
  fetchMock.mockClear()
  state.lastRequestTimestamp = undefined
  state.models = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  // @ts-expect-error test mock only needs a callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.normalizeOpenAIResponsesItemIds = originalNormalize
})

interface ParsedEvent {
  type?: string
  item_id?: string
  item?: { id?: string }
  response?: { output?: Array<{ id?: string }> }
}

function parseEvents(body: string): Array<ParsedEvent> {
  return body
    .split('\n\n')
    .map(block => block.split('\n').find(line => line.startsWith('data:')))
    .filter((line): line is string => line !== undefined)
    .map(line => JSON.parse(line.slice('data:'.length).trim()) as ParsedEvent)
}

async function streamResponses(): Promise<Array<ParsedEvent>> {
  const response = await server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.4', input: 'ping', stream: true }),
  })
  expect(response.status).toBe(200)
  return parseEvents(await response.text())
}

describe('OpenAI /responses per-item id gate', () => {
  test('forwards upstream ids verbatim when the flag is off (the shipped default)', async () => {
    state.normalizeOpenAIResponsesItemIds = false
    const events = await streamResponses()

    expect(events.find(e => e.type === 'response.output_item.added')?.item?.id).toBe('m_added')
    expect(events.find(e => e.type === 'response.content_part.added')?.item_id).toBe('m_cp_added')
    expect(events.find(e => e.type === 'response.output_text.delta')?.item_id).toBe('m_delta')
    expect(events.find(e => e.type === 'response.output_text.done')?.item_id).toBe('m_txt_done')
    expect(events.find(e => e.type === 'response.output_item.done')?.item?.id).toBe('m_done')
    expect(events.find(e => e.type === 'response.completed')?.response?.output?.[0]?.id).toBe('m_final')
  })

  test('stabilizes ids to the first-seen id per output_index when the flag is on', async () => {
    state.normalizeOpenAIResponsesItemIds = true
    const events = await streamResponses()

    expect(events.find(e => e.type === 'response.output_item.added')?.item?.id).toBe('m_added')
    expect(events.find(e => e.type === 'response.content_part.added')?.item_id).toBe('m_added')
    expect(events.find(e => e.type === 'response.output_text.delta')?.item_id).toBe('m_added')
    expect(events.find(e => e.type === 'response.output_text.done')?.item_id).toBe('m_added')
    expect(events.find(e => e.type === 'response.output_item.done')?.item?.id).toBe('m_added')
    expect(events.find(e => e.type === 'response.completed')?.response?.output?.[0]?.id).toBe('m_added')
  })
})
