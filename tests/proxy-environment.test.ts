import { describe, expect, test } from 'bun:test'

import {
  cliEnablesProxyEnvironment,
  NETWORK_BOOTSTRAPPED_ENV,
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

  test('does not restart proxy-enabled, already bootstrapped, Node, or non-start commands', () => {
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
})
