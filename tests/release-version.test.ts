import { describe, expect, test } from 'bun:test'

import { isStrictlyNewerStableVersion, parseStableVersion, verifyReleaseVersion } from '../scripts/verify-release-version'

describe('release version monotonicity', () => {
  test('accepts only strictly newer stable versions', () => {
    expect(isStrictlyNewerStableVersion('0.8.1', '0.8.0')).toBe(true)
    expect(isStrictlyNewerStableVersion('0.9.0', '0.8.99')).toBe(true)
    expect(isStrictlyNewerStableVersion('1.0.0', '0.99.99')).toBe(true)
    expect(isStrictlyNewerStableVersion('0.8.0', '0.8.0')).toBe(false)
    expect(isStrictlyNewerStableVersion('0.7.99', '0.8.0')).toBe(false)
  })

  test('rejects prereleases, build metadata, prefixes, and leading zeroes', () => {
    for (const version of ['v1.2.3', '1.2.3-beta.1', '1.2.3+build', '01.2.3']) {
      expect(() => parseStableVersion(version)).toThrow('stable X.Y.Z')
    }
  })

  test('returns an actionable error for an out-of-order release', () => {
    expect(() => verifyReleaseVersion('0.8.0', '0.8.1'))
      .toThrow('must be strictly newer than npm latest')
  })
})
