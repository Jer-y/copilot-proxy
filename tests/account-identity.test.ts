import { describe, expect, mock, test } from 'bun:test'

import { createAccountContext } from '~/lib/account/context'
import { assertValidAccountId, assessAccountIdentity } from '~/lib/account/identity'

describe('account identity validation', () => {
  test('accepts bounded lowercase account ids', () => {
    for (const id of ['a', 'personal', 'work_1', 'enterprise-prod'])
      expect(() => assertValidAccountId(id)).not.toThrow()
  })

  test('rejects traversal, uppercase, overlong, and Windows reserved ids', () => {
    for (const id of ['.', '..', 'Work', '-bad', 'a'.repeat(33), 'con', 'COM1', 'lpt9'])
      expect(() => assertValidAccountId(id)).toThrow()
  })

  test('classifies GitHub identity transport and server failures as unverified', async () => {
    const originalFetch = globalThis.fetch
    const ctx = createAccountContext({ id: 'work', accountType: 'enterprise' })
    ctx.githubToken = 'token_work'

    try {
      for (const failure of [
        async () => new Response('temporarily unavailable', { status: 503 }),
        async () => { throw new Error('network unavailable') },
      ]) {
        globalThis.fetch = mock(failure) as unknown as typeof fetch
        const assessment = await assessAccountIdentity(ctx, 2)
        expect(assessment.state).toBe('unverified')
        expect(assessment.error).toBeInstanceOf(Error)
      }
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})
