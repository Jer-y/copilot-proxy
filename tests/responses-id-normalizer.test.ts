import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'bun:test'

import {
  createCopilotResponsesItemIdNormalizer,
  normalizeCopilotResponsesEventStream,
  resetCopilotResponseIdAliasesForTests,
  resolveCopilotResponseIdAlias,
} from '~/services/copilot/responses-id-normalizer'

describe('Copilot Responses lifecycle ID normalization', () => {
  test('emits one stable Response ID and maps it back to the terminal upstream ID', async () => {
    resetCopilotResponseIdAliasesForTests()
    const normalized = await collect(normalizeCopilotResponsesEventStream(source([
      event('response.created', 0, 'upstream-created'),
      event('response.in_progress', 1, 'upstream-progress'),
      event('response.completed', 2, 'upstream-terminal', 'upstream-previous'),
    ]), {
      clientPreviousResponseId: 'public-previous',
    }))

    expect(normalized.map(message => JSON.parse(message.data!).response.id)).toEqual([
      'upstream-created',
      'upstream-created',
      'upstream-created',
    ])
    expect(resolveCopilotResponseIdAlias('upstream-created')).toBe('upstream-terminal')
    expect(resolveCopilotResponseIdAlias('persisted-or-unknown')).toBe('persisted-or-unknown')
    expect(JSON.parse(normalized.at(-1)!.data!).response.previous_response_id).toBe('public-previous')
  })

  test('leaves non-lifecycle, malformed, and DONE events untouched', async () => {
    resetCopilotResponseIdAliasesForTests()
    const messages = [
      { event: 'response.output_text.delta', data: '{"type":"response.output_text.delta","delta":"ok"}' },
      { event: 'message', data: 'not-json' },
      { event: 'done', data: '[DONE]' },
    ]

    expect(await collect(normalizeCopilotResponsesEventStream(source(messages)))).toEqual(messages)
  })

  test('normalizes item IDs and lifecycle IDs in the same SSE stream', async () => {
    resetCopilotResponseIdAliasesForTests()
    const normalized = await collect(normalizeCopilotResponsesEventStream(source([
      responseEvent('response.created', {
        id: 'resp_created',
        output: [],
      }),
      itemEvent('response.output_item.added', 0, {
        type: 'message',
        id: 'msg_added',
        role: 'assistant',
        content: [],
      }),
      {
        event: 'response.output_text.delta',
        data: JSON.stringify({
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'msg_delta',
          delta: 'ok',
          sequence_number: 2,
        }),
      },
      responseEvent('response.completed', {
        id: 'resp_terminal',
        status: 'completed',
        output: [{
          type: 'message',
          id: 'msg_terminal',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        }],
      }),
    ])))
    const events = normalized.map(message => JSON.parse(message.data!))

    expect(events[0].response.id).toBe('resp_created')
    expect(events[1].item.id).toBe('msg_added')
    expect(events[2].item_id).toBe('msg_added')
    expect(events[3].response.id).toBe('resp_created')
    expect(events[3].response.output[0].id).toBe('msg_added')
    expect(resolveCopilotResponseIdAlias('resp_created')).toBe('resp_terminal')
  })

  test('preserves the original SSE message and data when upstream IDs are already stable', async () => {
    resetCopilotResponseIdAliasesForTests()
    const rawData = [
      '{ "type": "response.created", "sequence_number": 0, "response": { "id": "resp_stable", "output": [] } } ',
      '{\n  "type": "response.output_item.added", "output_index": 0, "sequence_number": 1,\n  "item": { "type": "message", "id": "item_stable", "role": "\\u0061ssistant", "content": [] }\n}',
      '{ "type": "response.output_text.delta", "output_index": 0, "content_index": 0, "item_id": "item_stable", "delta": "ok", "sequence_number": 2 }\n',
      '{\n "type": "response.completed", "sequence_number": 3,\n "response": { "id": "resp_stable", "status": "completed", "output": [{ "type": "message", "id": "item_stable", "role": "assistant", "content": [] }] }\n}  ',
    ]
    const eventNames = [
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.completed',
    ]
    const messages = rawData.map((data, index) => ({
      data,
      event: eventNames[index],
    }))

    const normalized = await collect(normalizeCopilotResponsesEventStream(source(messages)))

    expect(normalized).toHaveLength(messages.length)
    for (const [index, message] of normalized.entries()) {
      expect(message).toBe(messages[index])
      expect(message.data).toBe(rawData[index])
      expect(Buffer.compare(Buffer.from(message.data!), Buffer.from(rawData[index]!))).toBe(0)
    }
  })
})

describe('Copilot Responses item ID normalization', () => {
  test('pins reasoning, summary, message, and function-call events to the first ID per output index', () => {
    const normalizer = createCopilotResponsesItemIdNormalizer()
    const events = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 0,
        item: {
          type: 'reasoning',
          id: 'reasoning_added',
          encrypted_content: 'encrypted-reasoning',
          summary: [],
        },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        item_id: 'reasoning_delta',
        delta: 'summary',
        sequence_number: 1,
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 2,
        item: {
          type: 'reasoning',
          id: 'reasoning_done',
          encrypted_content: 'encrypted-reasoning',
          summary: [{ type: 'summary_text', text: 'summary' }],
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        sequence_number: 3,
        item: {
          type: 'function_call',
          id: 'function_added',
          call_id: 'call_stable',
          name: 'lookup',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 1,
        item_id: 'function_event',
        sequence_number: 4,
        item: {
          type: 'function_call',
          id: 'function_nested',
          call_id: 'call_stable',
          name: 'lookup',
          arguments: '{"value":1}',
        },
      },
      {
        type: 'response.completed',
        sequence_number: 5,
        response: {
          id: 'resp_terminal',
          output: [
            {
              type: 'reasoning',
              id: 'reasoning_terminal',
              encrypted_content: 'encrypted-reasoning',
              summary: [{ type: 'summary_text', text: 'summary' }],
            },
            {
              type: 'function_call',
              id: 'function_terminal',
              call_id: 'call_stable',
              name: 'lookup',
              arguments: '{"value":1}',
            },
          ],
        },
      },
    ].map(event => normalizer.normalize(event))

    expect((events[0].item as { id: string }).id).toBe('reasoning_added')
    expect(events[1].item_id).toBe('reasoning_added')
    expect((events[2].item as { encrypted_content: string, id: string }).id).toBe('reasoning_added')
    expect((events[2].item as { encrypted_content: string }).encrypted_content).toBe('encrypted-reasoning')
    expect((events[3].item as { id: string }).id).toBe('function_added')
    expect(events[4].item_id).toBe('function_added')
    expect((events[4].item as { call_id: string, id: string }).id).toBe('function_added')
    expect((events[4].item as { call_id: string }).call_id).toBe('call_stable')
    expect(events[4].sequence_number).toBe(4)

    const terminalOutput = ((events[5].response as { output: Array<Record<string, unknown>> }).output)
    expect(terminalOutput.map(item => item.id)).toEqual(['reasoning_added', 'function_added'])
    expect(terminalOutput[0]?.encrypted_content).toBe('encrypted-reasoning')
    expect(terminalOutput[1]?.call_id).toBe('call_stable')
  })

  test('keeps response-local maps independent and ignores invalid output indices', () => {
    const first = createCopilotResponsesItemIdNormalizer()
    const second = createCopilotResponsesItemIdNormalizer()
    const invalid = {
      type: 'response.output_text.delta',
      output_index: -1,
      item_id: 'invalid-index-id',
      delta: 'ignored',
    }

    expect(first.normalize(itemRecord('first-added')).item).toEqual({ id: 'first-added' })
    expect(second.normalize(itemRecord('second-added')).item).toEqual({ id: 'second-added' })
    expect(first.normalize({ ...invalid })).toEqual(invalid)
  })
})

function event(type: string, sequenceNumber: number, id: string, previousResponseId?: string) {
  return {
    event: type,
    data: JSON.stringify({
      type,
      sequence_number: sequenceNumber,
      response: {
        id,
        object: 'response',
        ...(previousResponseId && { previous_response_id: previousResponseId }),
        status: type === 'response.completed' ? 'completed' : 'in_progress',
      },
    }),
  }
}

function itemEvent(type: string, outputIndex: number, item: Record<string, unknown>) {
  return {
    event: type,
    data: JSON.stringify({
      type,
      output_index: outputIndex,
      item,
    }),
  }
}

function itemRecord(id: string): Record<string, unknown> {
  return {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id },
  }
}

function responseEvent(type: string, response: Record<string, unknown>) {
  return {
    event: type,
    data: JSON.stringify({ type, response }),
  }
}

async function* source<T>(values: T[]): AsyncIterable<T> {
  yield* values
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values)
    result.push(value)
  return result
}
