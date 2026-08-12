import { describe, expect, test } from 'bun:test'

import { hashFraction, jitterModelRefreshInterval, jitterTokenRefreshDelay } from '~/lib/account/jitter'

describe('multi-account refresh jitter', () => {
  test('is disabled for single-account operation', () => {
    expect(jitterTokenRefreshDelay(100_000, 'personal', false)).toBe(100_000)
    expect(jitterModelRefreshInterval(100_000, 'personal', false)).toBe(100_000)
  })

  test('is deterministic and account-specific', () => {
    expect(hashFraction('personal')).toBe(hashFraction('personal'))
    expect(hashFraction('personal')).not.toBe(hashFraction('work'))
    expect(jitterTokenRefreshDelay(100_000, 'personal', true))
      .not
      .toBe(jitterTokenRefreshDelay(100_000, 'work', true))
  })

  test('never delays token refresh beyond the original schedule', () => {
    for (const id of ['a', 'personal', 'work', 'enterprise'])
      expect(jitterTokenRefreshDelay(600_000, id, true)).toBeLessThanOrEqual(600_000)
  })
})
