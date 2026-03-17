import { describe, expect, test } from 'bun:test'

import {
  DEFAULT_COPILOT_BODY_TIMEOUT_MS,
  DEFAULT_COPILOT_CONNECT_TIMEOUT_MS,
  DEFAULT_COPILOT_HEADERS_TIMEOUT_MS,
  resolveUndiciAgentOptions,
} from '../src/lib/proxy'

describe('resolveUndiciAgentOptions', () => {
  test('applies built-in longer defaults for Copilot upstreams', () => {
    expect(resolveUndiciAgentOptions({
      proxyEnv: false,
    })).toEqual({
      headersTimeout: DEFAULT_COPILOT_HEADERS_TIMEOUT_MS,
      bodyTimeout: DEFAULT_COPILOT_BODY_TIMEOUT_MS,
      connectTimeout: DEFAULT_COPILOT_CONNECT_TIMEOUT_MS,
    })
  })

  test('keeps Node defaults for non-Copilot upstreams when no overrides are configured', () => {
    expect(resolveUndiciAgentOptions({
      proxyEnv: false,
    }, {
      applyCopilotDefaults: false,
    })).toBeUndefined()
  })

  test('maps timeout overrides to undici agent options', () => {
    expect(resolveUndiciAgentOptions({
      proxyEnv: false,
      headersTimeoutMs: 600000,
      bodyTimeoutMs: 900000,
      connectTimeoutMs: 15000,
    })).toEqual({
      headersTimeout: 600000,
      bodyTimeout: 900000,
      connectTimeout: 15000,
    })
  })
})
