import { describe, expect, test } from 'bun:test'

import { createResponsesItemIdNormalizer } from '../src/lib/translation/normalize-responses-item-ids'

interface ParsedEvent {
  type?: string
  output_index?: number
  item_id?: string
  summary_index?: number
  delta?: string
  text?: string
  part?: unknown
  item?: {
    id?: string
    call_id?: string
    encrypted_content?: string
    summary?: unknown
    content?: unknown
  }
  response?: {
    output?: Array<{ id?: string, encrypted_content?: string, call_id?: string }>
  }
}

function chunk(event: string, payload: unknown): { event: string, data: string } {
  return { event, data: JSON.stringify(payload) }
}

function parse(c: { data?: string | null }): ParsedEvent {
  return JSON.parse(c.data ?? '') as ParsedEvent
}

describe('Responses per-item id normalization', () => {
  test('stabilizes reasoning and message ids to the first-seen id per output_index', () => {
    const n = createResponsesItemIdNormalizer()
    const events = [
      chunk('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'r_added', encrypted_content: 'ENC_R', summary: [] },
      }),
      chunk('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'r_done', encrypted_content: 'ENC_R', summary: [] },
      }),
      chunk('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'm_added', role: 'assistant', content: [] },
      }),
      chunk('response.content_part.added', {
        type: 'response.content_part.added',
        output_index: 1,
        content_index: 0,
        item_id: 'm_cp_added',
        part: { type: 'output_text', text: '' },
      }),
      chunk('response.output_text.delta', {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        item_id: 'm_txt_delta',
        delta: 'pong',
      }),
      chunk('response.output_text.done', {
        type: 'response.output_text.done',
        output_index: 1,
        content_index: 0,
        item_id: 'm_txt_done',
        text: 'pong',
      }),
      chunk('response.content_part.done', {
        type: 'response.content_part.done',
        output_index: 1,
        content_index: 0,
        item_id: 'm_cp_done',
        part: { type: 'output_text', text: 'pong' },
      }),
      chunk('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'message', id: 'm_done', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
      }),
      chunk('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          object: 'response',
          model: 'gpt-5.4',
          status: 'completed',
          output: [
            { type: 'reasoning', id: 'r_final', encrypted_content: 'ENC_R', summary: [] },
            { type: 'message', id: 'm_final', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
          ],
        },
      }),
    ].map(c => parse(n.rewrite(c)))

    // Reasoning (output_index 0) pinned to first-seen 'r_added'
    expect(events[0].item?.id).toBe('r_added')
    expect(events[1].item?.id).toBe('r_added')
    expect(events[8].response?.output?.[0].id).toBe('r_added')

    // Message (output_index 1) pinned to first-seen 'm_added' across item + item_id fields
    expect(events[2].item?.id).toBe('m_added')
    expect(events[3].item_id).toBe('m_added')
    expect(events[4].item_id).toBe('m_added')
    expect(events[5].item_id).toBe('m_added')
    expect(events[6].item_id).toBe('m_added')
    expect(events[7].item?.id).toBe('m_added')
    expect(events[8].response?.output?.[1].id).toBe('m_added')

    // Preserved fields
    expect(events[0].item?.encrypted_content).toBe('ENC_R')
    expect(events[1].item?.encrypted_content).toBe('ENC_R')
    expect(events[8].response?.output?.[0].encrypted_content).toBe('ENC_R')
    expect(events[0].item?.summary).toEqual([])
    expect(events[7].item?.content).toEqual([{ type: 'output_text', text: 'pong' }])
  })

  test('stabilizes function_call ids while leaving call_id untouched', () => {
    const n = createResponsesItemIdNormalizer()
    const events = [
      chunk('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'f_added', call_id: 'call_abc', name: 'lookup', arguments: '' },
      }),
      chunk('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'f_delta',
        delta: '{"q":1}',
      }),
      chunk('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'f_argsdone',
        arguments: '{"q":1}',
        item: { type: 'function_call', id: 'f_itemdone', call_id: 'call_abc', name: 'lookup', arguments: '{"q":1}' },
      }),
      chunk('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'f_outdone', call_id: 'call_abc', name: 'lookup', arguments: '{"q":1}' },
      }),
    ].map(c => parse(n.rewrite(c)))

    expect(events[0].item?.id).toBe('f_added')
    expect(events[1].item_id).toBe('f_added')
    expect(events[2].item_id).toBe('f_added')
    expect(events[2].item?.id).toBe('f_added')
    expect(events[3].item?.id).toBe('f_added')

    // call_id must never be rewritten
    expect(events[0].item?.call_id).toBe('call_abc')
    expect(events[2].item?.call_id).toBe('call_abc')
    expect(events[3].item?.call_id).toBe('call_abc')
  })

  test('passes through non-item events and malformed/empty chunks unchanged', () => {
    const n = createResponsesItemIdNormalizer()

    const created = chunk('response.created', {
      type: 'response.created',
      response: { id: 'resp_1', object: 'response', model: 'gpt-5.4', status: 'in_progress', output: [] },
    })
    const createdData = created.data
    expect(n.rewrite(created).data).toBe(createdData)

    const errorEvent = chunk('error', { type: 'error', error: { message: 'boom', type: 'server_error' } })
    const errorData = errorEvent.data
    expect(n.rewrite(errorEvent).data).toBe(errorData)

    const malformed = { event: 'response.output_item.added', data: 'not-json{' }
    expect(n.rewrite(malformed).data).toBe('not-json{')

    const empty = { event: 'ping', data: '' }
    expect(n.rewrite(empty).data).toBe('')

    const nullData: { event: string, data: string | null } = { event: 'ping', data: null }
    expect(n.rewrite(nullData).data).toBeNull()
  })

  test('keeps ids independent across output_index values', () => {
    const n = createResponsesItemIdNormalizer()
    const a = parse(n.rewrite(chunk('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'idx0', summary: [] },
    })))
    const b = parse(n.rewrite(chunk('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'message', id: 'idx1', role: 'assistant', content: [] },
    })))
    expect(a.item?.id).toBe('idx0')
    expect(b.item?.id).toBe('idx1')
  })

  test('stabilizes reasoning-summary event ids that churn per event', () => {
    const n = createResponsesItemIdNormalizer()
    const events = [
      chunk('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_real', encrypted_content: 'ENC_R', summary: [] },
      }),
      chunk('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        output_index: 0,
        summary_index: 0,
        item_id: 'churn_1',
        part: { type: 'summary_text', text: '' },
      }),
      chunk('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        item_id: 'churn_2',
        delta: '**Answer',
      }),
      chunk('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        output_index: 0,
        summary_index: 0,
        item_id: 'churn_3',
        text: '**Answering**',
      }),
      chunk('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        output_index: 0,
        summary_index: 0,
        item_id: 'churn_4',
        part: { type: 'summary_text', text: '**Answering**' },
      }),
      chunk('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_real_done',
          encrypted_content: 'ENC_R',
          summary: [{ type: 'summary_text', text: '**Answering**' }],
        },
      }),
    ].map(c => parse(n.rewrite(c)))

    // Every reasoning-summary event collapses to the first-seen reasoning id.
    expect(events[0].item?.id).toBe('rs_real')
    expect(events[1].item_id).toBe('rs_real')
    expect(events[2].item_id).toBe('rs_real')
    expect(events[3].item_id).toBe('rs_real')
    expect(events[4].item_id).toBe('rs_real')
    expect(events[5].item?.id).toBe('rs_real')

    // Non-id fields on summary events are preserved.
    expect(events[1].summary_index).toBe(0)
    expect(events[2].summary_index).toBe(0)
    expect(events[2].delta).toBe('**Answer')
    expect(events[3].text).toBe('**Answering**')
    expect(events[1].part).toEqual({ type: 'summary_text', text: '' })
    expect(events[0].item?.encrypted_content).toBe('ENC_R')
    expect(events[5].item?.encrypted_content).toBe('ENC_R')
  })
})
