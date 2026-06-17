import type { DaemonConfig } from '../src/daemon/config'

import { describe, expect, test } from 'bun:test'
import { buildServiceStartArgs } from '../src/daemon/enable'

const baseConfig: DaemonConfig = {
  port: 4399,
  host: '127.0.0.1',
  verbose: false,
  accountType: 'individual',
  manual: false,
  rateLimitWait: false,
  showToken: false,
  proxyEnv: false,
}

describe('buildServiceStartArgs', () => {
  test('builds minimal foreground start args', () => {
    expect(buildServiceStartArgs('/tmp/main.js', baseConfig)).toEqual([
      '/tmp/main.js',
      'start',
      '--port',
      '4399',
      '--host',
      '127.0.0.1',
      '--account-type',
      'individual',
    ])
  })

  test('includes optional switches and never includes github token or show-token', () => {
    const config: DaemonConfig = {
      ...baseConfig,
      port: 4411,
      host: '0.0.0.0',
      accountType: 'enterprise',
      verbose: true,
      manual: true,
      rateLimit: 9,
      rateLimitWait: true,
      headersTimeoutMs: 600000,
      bodyTimeoutMs: 900000,
      connectTimeoutMs: 15000,
      showToken: true,
      proxyEnv: true,
      githubToken: 'ghu_secret_should_not_be_in_args',
    }

    const args = buildServiceStartArgs('/tmp/main.js', config)
    expect(args).toEqual([
      '/tmp/main.js',
      'start',
      '--port',
      '4411',
      '--host',
      '0.0.0.0',
      '--account-type',
      'enterprise',
      '--verbose',
      '--manual',
      '--rate-limit',
      '9',
      '--wait',
      '--headers-timeout-ms',
      '600000',
      '--body-timeout-ms',
      '900000',
      '--connect-timeout-ms',
      '15000',
      '--proxy-env',
    ])
    expect(args).not.toContain('--github-token')
    expect(args).not.toContain(config.githubToken!)
    expect(args).not.toContain('--show-token')
    expect(args).not.toContain('--_supervisor')
  })
})
