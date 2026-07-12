import { describe, expect, test } from 'bun:test'

import {
  cliEnablesProxyEnvironment,
  NETWORK_BOOTSTRAPPED_ENV,
  resolveProxyForUrlFromEnvironment,
  shouldRestartWithSanitizedNetworkEnvironment,
  withoutProxyEnvironment,
} from '~/lib/proxy-environment'

describe('Bun proxy environment bootstrap', () => {
  test('restarts a Bun start command to remove an unapproved ambient proxy', () => {
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start'],
      { HTTP_PROXY: 'http://ambient.invalid:8080' },
      true,
    )).toBe(true)
  })

  test('does not restart proxy-enabled, already bootstrapped, Node, or non-network commands', () => {
    expect(cliEnablesProxyEnvironment(['start', '--proxy-env'])).toBe(true)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start', '--proxy-env'],
      { HTTP_PROXY: 'http://approved.invalid:8080' },
      true,
    )).toBe(false)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start'],
      {
        HTTP_PROXY: 'http://ambient.invalid:8080',
        [NETWORK_BOOTSTRAPPED_ENV]: '1',
      },
      true,
    )).toBe(false)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start'],
      { HTTP_PROXY: 'http://ambient.invalid:8080' },
      false,
    )).toBe(false)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['debug'],
      { HTTP_PROXY: 'http://ambient.invalid:8080' },
      true,
    )).toBe(false)
  })

  test('sanitizes ambient Bun proxy settings for auth and check-usage unless explicitly enabled', () => {
    for (const command of ['auth', 'check-usage']) {
      expect(shouldRestartWithSanitizedNetworkEnvironment(
        [command],
        { HTTPS_PROXY: 'http://ambient.invalid:8080' },
        true,
      )).toBe(true)
      expect(shouldRestartWithSanitizedNetworkEnvironment(
        [command, '--proxy-env'],
        { HTTPS_PROXY: 'http://approved.invalid:8080' },
        true,
      )).toBe(false)
    }
  })

  test('always restarts a native service so startup-only proxy and TLS settings exist at process startup', () => {
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start', '--_service', '--proxy-env'],
      { COPILOT_PROXY_DATA_DIR: '/persisted' },
      true,
    )).toBe(true)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start', '--_service'],
      { COPILOT_PROXY_DATA_DIR: '/persisted' },
      false,
    )).toBe(true)
  })

  test('removes upper/lowercase proxy endpoints and bypass rules from the child env', () => {
    expect(withoutProxyEnvironment({
      HTTP_PROXY: 'http://one',
      https_proxy: 'http://two',
      NO_PROXY: 'localhost',
      HOME: '/home/test',
    })).toEqual({ HOME: '/home/test' })
  })

  test('resolves HTTPS targets only through HTTPS_PROXY or ALL_PROXY and honors NO_PROXY', () => {
    expect(resolveProxyForUrlFromEnvironment('https://api.github.com', {
      HTTP_PROXY: 'http://http-only.invalid:8080',
    })).toBeUndefined()
    expect(resolveProxyForUrlFromEnvironment('https://api.github.com', {
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
    })).toBe('http://secure-proxy.invalid:8080')
    expect(resolveProxyForUrlFromEnvironment('https://api.github.com', {
      ALL_PROXY: 'proxy.internal:8080',
    })).toBe('https://proxy.internal:8080')
    expect(resolveProxyForUrlFromEnvironment('https://api.github.com', {
      HTTPS_PROXY: 'http://secure-proxy.invalid:8080',
      NO_PROXY: 'api.github.com',
    })).toBeUndefined()
  })
})
