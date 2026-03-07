import type { DaemonConfig } from '../src/daemon/config'

import { describe, expect, test } from 'bun:test'
import { mergeDaemonConfigWithExplicitFlags } from '../src/daemon/config'

const savedConfig: DaemonConfig = {
  port: 4399,
  verbose: false,
  accountType: 'business',
  manual: true,
  rateLimit: 5,
  rateLimitWait: true,
  githubToken: 'ghu_saved',
  showToken: false,
  proxyEnv: false,
}

describe('mergeDaemonConfigWithExplicitFlags', () => {
  test('lets explicit --proxy-env override saved daemon config in supervisor mode', () => {
    const cliConfig: DaemonConfig = {
      ...savedConfig,
      proxyEnv: true,
    }

    const merged = mergeDaemonConfigWithExplicitFlags(
      savedConfig,
      cliConfig,
      ['start', '--_supervisor', '--proxy-env'],
    )

    expect(merged.proxyEnv).toBe(true)
    expect(merged.port).toBe(savedConfig.port)
    expect(merged.accountType).toBe(savedConfig.accountType)
  })

  test('only applies values for flags that were explicitly passed', () => {
    const cliConfig: DaemonConfig = {
      port: 4411,
      verbose: true,
      accountType: 'enterprise',
      manual: false,
      rateLimit: 9,
      rateLimitWait: false,
      githubToken: 'ghu_cli',
      showToken: true,
      proxyEnv: true,
    }

    const merged = mergeDaemonConfigWithExplicitFlags(
      savedConfig,
      cliConfig,
      ['start', '--_supervisor', '--port', '4411', '--proxy-env'],
    )

    expect(merged).toEqual({
      ...savedConfig,
      port: 4411,
      proxyEnv: true,
    })
  })

  test('recognizes short aliases and long-form equals syntax', () => {
    const cliConfig: DaemonConfig = {
      port: 4411,
      verbose: true,
      accountType: 'enterprise',
      manual: false,
      rateLimit: 9,
      rateLimitWait: false,
      githubToken: 'ghu_cli',
      showToken: true,
      proxyEnv: true,
    }

    const merged = mergeDaemonConfigWithExplicitFlags(
      savedConfig,
      cliConfig,
      [
        'start',
        '--_supervisor',
        '-p',
        '4411',
        '-v',
        '-a',
        'enterprise',
        '-r',
        '9',
        '-w',
        '-g',
        'ghu_cli',
        '--show-token',
        '--proxy-env=true',
      ],
    )

    expect(merged).toEqual({
      ...savedConfig,
      port: 4411,
      verbose: true,
      accountType: 'enterprise',
      rateLimit: 9,
      rateLimitWait: false,
      githubToken: 'ghu_cli',
      showToken: true,
      proxyEnv: true,
    })
  })

  test('lets explicit --api-key override saved daemon config', () => {
    const cliConfig: DaemonConfig = {
      ...savedConfig,
      apiKey: 'cli-key-123',
    }

    const merged = mergeDaemonConfigWithExplicitFlags(
      savedConfig,
      cliConfig,
      ['start', '--_supervisor', '--api-key', 'cli-key-123'],
    )

    expect(merged.apiKey).toBe('cli-key-123')
    expect(merged.port).toBe(savedConfig.port)
  })

  test('lets explicit -k alias override saved daemon config', () => {
    const cliConfig: DaemonConfig = {
      ...savedConfig,
      apiKey: 'short-key',
    }

    const merged = mergeDaemonConfigWithExplicitFlags(
      savedConfig,
      cliConfig,
      ['start', '--_supervisor', '-k', 'short-key'],
    )

    expect(merged.apiKey).toBe('short-key')
  })

  test('does not override apiKey when --api-key is not passed', () => {
    const configWithKey: DaemonConfig = {
      ...savedConfig,
      apiKey: 'saved-key',
    }
    const cliConfig: DaemonConfig = {
      ...savedConfig,
      apiKey: 'cli-key',
    }

    const merged = mergeDaemonConfigWithExplicitFlags(
      configWithKey,
      cliConfig,
      ['start', '--_supervisor', '--port', '4411'],
    )

    expect(merged.apiKey).toBe('saved-key')
  })
})
