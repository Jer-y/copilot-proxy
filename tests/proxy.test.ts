import { describe, expect, test } from 'bun:test'

import {
  clearProxyEnvironment,
  DEFAULT_COPILOT_BODY_TIMEOUT_MS,
  DEFAULT_COPILOT_CONNECT_TIMEOUT_MS,
  DEFAULT_COPILOT_HEADERS_TIMEOUT_MS,
  initializeNodeHttpClient,
  resolveUndiciAgentOptions,
  throwProxyDispatchError,
} from '../src/lib/proxy'
import { NETWORK_BOOTSTRAPPED_ENV } from '../src/lib/proxy-environment'
import { fetchWithTimeout } from '../src/lib/upstream-fetch'

describe('clearProxyEnvironment', () => {
  test('removes upper- and lower-case proxy variables without touching unrelated env', () => {
    const env: NodeJS.ProcessEnv = {
      HTTP_PROXY: 'http://proxy.example',
      https_proxy: 'http://proxy.example',
      ALL_PROXY: 'socks://proxy.example',
      NO_PROXY: 'localhost',
      HOME: '/home/test',
    }

    clearProxyEnvironment(env)

    expect(env).toEqual({ HOME: '/home/test' })
  })
})

describe('throwProxyDispatchError', () => {
  test('reports proxy resolution errors instead of falling back to direct egress', () => {
    expect(() => throwProxyDispatchError(new Error('invalid required proxy')))
      .toThrow('invalid required proxy')
  })
})

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

describe('Bun HTTP client initialization', () => {
  test('clears an already-sanitized ambient proxy when proxy mode is disabled', () => {
    process.env.HTTP_PROXY = 'http://ambient.invalid:8080'
    process.env[NETWORK_BOOTSTRAPPED_ENV] = '1'
    try {
      initializeNodeHttpClient({ proxyEnv: false })
      expect(process.env.HTTP_PROXY).toBeUndefined()
    }
    finally {
      delete process.env.HTTP_PROXY
      delete process.env[NETWORK_BOOTSTRAPPED_ENV]
    }
  })

  test('removes approved proxy credentials from the JS environment after Bun snapshots them', () => {
    process.env.HTTPS_PROXY = 'http://approved.invalid:8080'
    try {
      initializeNodeHttpClient({ proxyEnv: true })
      expect(process.env.HTTPS_PROXY).toBeUndefined()
    }
    finally {
      delete process.env.HTTPS_PROXY
    }
  })

  test('refuses a per-request NO_PROXY bypass after Bun clears proxy credentials', async () => {
    process.env.HTTPS_PROXY = 'http://approved.invalid:8080'
    process.env.NO_PROXY = 'blocked.example'
    try {
      initializeNodeHttpClient({ proxyEnv: true })
      await expect(fetchWithTimeout('https://blocked.example/resource', {}, {
        timeoutMs: 100,
        timeoutLabel: 'blocked target',
      })).rejects.toThrow('refusing to send upstream data')
    }
    finally {
      delete process.env.HTTPS_PROXY
      delete process.env.NO_PROXY
      initializeNodeHttpClient({ proxyEnv: false })
    }
  })
})
