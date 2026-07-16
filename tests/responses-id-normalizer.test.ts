import { describe, expect, test } from 'bun:test'

import {
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

async function* source<T>(values: T[]): AsyncIterable<T> {
  yield* values
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const value of values)
    result.push(value)
  return result
}
