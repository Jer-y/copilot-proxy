import { describe, expect, test } from 'bun:test'

import { HTTPError } from '~/lib/error'

describe('HTTPError', () => {
  test('caches response text for repeated consumers', async () => {
    const error = new HTTPError('failed', new Response('{"error":"bad"}', { status: 400 }))

    expect(await error.text()).toBe('{"error":"bad"}')
    expect(await error.text()).toBe('{"error":"bad"}')
    expect(await error.json()).toEqual({ error: 'bad' })
  })
})
