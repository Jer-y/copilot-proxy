import { describe, expect, test } from 'bun:test'
import { parseArgs as parseCittyArgs } from 'citty'

import {
  cliEnablesProxyEnvironment,
  NETWORK_BOOTSTRAPPED_ENV,
  resolveProxyForUrlFromEnvironment,
  shouldRestartWithSanitizedNetworkEnvironment,
  withoutProxyEnvironment,
} from '~/lib/proxy-environment'

describe('Bun proxy environment bootstrap', () => {
  test('matches Citty boolean parsing before network bootstrap', () => {
    const cases = [
      { label: 'omitted', rawArgs: [] },
      { label: 'bare true', rawArgs: ['--proxy-env'] },
      { label: 'explicit true', rawArgs: ['--proxy-env=true'] },
      { label: 'explicit false', rawArgs: ['--proxy-env=false'] },
      { label: 'numeric one is true', rawArgs: ['--proxy-env=1'] },
      { label: 'numeric zero is also true', rawArgs: ['--proxy-env=0'] },
      { label: 'camel-case alias', rawArgs: ['--proxyEnv'] },
      { label: 'true camel-case alias overrides primary default value', rawArgs: ['--proxyEnv', '--proxy-env=false'] },
      { label: 'later positive value wins true', rawArgs: ['--proxy-env=false', '--proxy-env=true'] },
      { label: 'later positive value wins false', rawArgs: ['--proxy-env=true', '--proxy-env=false'] },
      { label: 'negative flag wins before positive', rawArgs: ['--no-proxy-env', '--proxy-env'] },
      { label: 'negative flag wins after positive', rawArgs: ['--proxy-env', '--no-proxy-env'] },
      { label: 'long string option consumes flag-like value', rawArgs: ['--port', '--proxy-env'] },
      { label: 'short string option consumes flag-like value', rawArgs: ['-p', '--proxy-env'] },
      { label: 'short string cluster keeps target text in the value', rawArgs: ['-p--proxy-env'] },
      { label: 'inline string value is not a boolean option', rawArgs: ['--port=--proxy-env'] },
      { label: 'option after delimiter is positional', rawArgs: ['--', '--proxy-env'] },
      { label: 'delimiter consumed as a string value does not stop parsing', rawArgs: ['--port', '--', '--proxy-env'] },
      { label: 'Citty removes negative flags before parsing string values', rawArgs: ['--port', '--no-verbose', '--proxy-env'] },
    ]

    for (const { label, rawArgs } of cases) {
      const cittyArgs = parseCittyArgs(rawArgs, {
        'port': { type: 'string', alias: 'p' },
        'verbose': { type: 'boolean', alias: 'v', default: false },
        'proxy-env': { type: 'boolean', default: false },
      })
      expect({
        enabled: cliEnablesProxyEnvironment(['start', ...rawArgs]),
        label,
      }).toEqual({
        enabled: Boolean(cittyArgs['proxy-env']),
        label,
      })
    }
  })

  test('restarts a Bun start command to remove an unapproved ambient proxy', () => {
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start'],
      { HTTP_PROXY: 'http://ambient.invalid:8080' },
      true,
    )).toBe(true)
  })

  test('uses the real root subcommand after prefix options', () => {
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['-v', 'start'],
      { HTTPS_PROXY: 'http://ambient.invalid:8080' },
      true,
    )).toBe(true)
    expect(cliEnablesProxyEnvironment(['-v', 'start', '--proxy-env'])).toBe(true)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['-v', 'start', '--proxy-env'],
      { HTTPS_PROXY: 'http://approved.invalid:8080' },
      true,
    )).toBe(false)
    expect(cliEnablesProxyEnvironment(['--proxy-env', 'start'])).toBe(false)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['--proxy-env', 'start'],
      { HTTPS_PROXY: 'http://ambient.invalid:8080' },
      true,
    )).toBe(true)
  })

  test('does not restart network or native-service bootstraps for root help', () => {
    for (const args of [
      ['--help', 'start'],
      ['-h', 'auth'],
      ['start', '--help', '--_service'],
      ['start', '--host', '--help', '--_service'],
    ]) {
      expect(cliEnablesProxyEnvironment([...args, '--proxy-env'])).toBe(false)
      expect(shouldRestartWithSanitizedNetworkEnvironment(
        args,
        { HTTPS_PROXY: 'http://ambient.invalid:8080' },
        true,
      )).toBe(false)
    }
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

  test('sanitizes ambient Bun proxy settings for every network command unless explicitly enabled', () => {
    for (const command of ['auth', 'check-usage', 'setup', 'models', 'doctor']) {
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
      expect(shouldRestartWithSanitizedNetworkEnvironment(
        [command, '--proxy-env=1'],
        { HTTPS_PROXY: 'http://approved.invalid:8080' },
        true,
      )).toBe(false)
      expect(shouldRestartWithSanitizedNetworkEnvironment(
        [command, '--proxy-env=false'],
        { HTTPS_PROXY: 'http://ambient.invalid:8080' },
        true,
      )).toBe(true)
    }
  })

  test('does not treat proxy-looking string option values as flags', () => {
    for (const args of [
      ['start', '--port', '--proxy-env'],
      ['auth', '--github-token', '--proxy-env'],
      ['auth', '--_data-dir', '--proxy-env'],
      ['--_data-dir', '--proxy-env', 'auth'],
      ['setup', 'codex', '--model', '--proxy-env'],
      ['models', '--client', '--proxy-env'],
      ['doctor', '--endpoint', '--proxy-env'],
    ]) {
      expect(cliEnablesProxyEnvironment(args)).toBe(false)
      expect(shouldRestartWithSanitizedNetworkEnvironment(
        args,
        { HTTPS_PROXY: 'http://ambient.invalid:8080' },
        true,
      )).toBe(true)
    }

    expect(cliEnablesProxyEnvironment([
      'auth',
      '--_data-dir',
      '/tmp/first',
      '--_data-dir',
      '--proxy-env',
    ])).toBe(true)
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
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['-v', 'start', '--_service'],
      { COPILOT_PROXY_DATA_DIR: '/persisted' },
      false,
    )).toBe(true)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start', '--service'],
      { COPILOT_PROXY_DATA_DIR: '/persisted' },
      false,
    )).toBe(true)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start', '---service'],
      { COPILOT_PROXY_DATA_DIR: '/persisted' },
      false,
    )).toBe(true)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['--_service', 'start'],
      { COPILOT_PROXY_DATA_DIR: '/persisted' },
      false,
    )).toBe(false)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start', '--host', '--_service'],
      { COPILOT_PROXY_DATA_DIR: '/persisted' },
      false,
    )).toBe(false)
    expect(shouldRestartWithSanitizedNetworkEnvironment(
      ['start', '--service', '--no-service'],
      { COPILOT_PROXY_DATA_DIR: '/persisted' },
      false,
    )).toBe(false)
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
