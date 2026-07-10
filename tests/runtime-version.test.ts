import { describe, expect, test } from 'bun:test'

import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from '~/lib/runtime-version'

describe('Node runtime compatibility guard', () => {
  test('accepts the declared minimum and newer versions', () => {
    expect(isSupportedNodeVersion(MINIMUM_NODE_VERSION)).toBe(true)
    expect(isSupportedNodeVersion('v22.19.1')).toBe(true)
    expect(isSupportedNodeVersion('24.0.0')).toBe(true)
  })

  test('rejects older or malformed versions before application imports load', () => {
    expect(isSupportedNodeVersion('22.18.0')).toBe(false)
    expect(isSupportedNodeVersion('20.20.2')).toBe(false)
    expect(isSupportedNodeVersion('not-a-version')).toBe(false)
  })
})
