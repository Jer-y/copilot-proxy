import { describe, expect, test } from 'bun:test'

import { shellQuote } from '~/daemon/platform/linux'

describe('systemd shellQuote', () => {
  test('escapes systemd specifiers and dollar expansion', () => {
    expect(shellQuote('/tmp/app%dir/$bin/copilot proxy')).toBe('"/tmp/app%%dir/$$bin/copilot proxy"')
  })
})
