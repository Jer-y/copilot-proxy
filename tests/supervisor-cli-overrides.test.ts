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
  headersTimeoutMs: 300000,
  bodyTimeoutMs: 300000,
  connectTimeoutMs: 10000,
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
      headersTimeoutMs: 600000,
      bodyTimeoutMs: 900000,
      connectTimeoutMs: 15000,
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
      headersTimeoutMs: 600000,
      bodyTimeoutMs: 900000,
      connectTimeoutMs: 15000,
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
        '--headers-timeout-ms',
        '600000',
        '--body-timeout-ms=900000',
        '--connect-timeout-ms',
        '15000',
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
      headersTimeoutMs: 600000,
      bodyTimeoutMs: 900000,
      connectTimeoutMs: 15000,
      githubToken: 'ghu_cli',
      showToken: true,
      proxyEnv: true,
    })
  })
})
