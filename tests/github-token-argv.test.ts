import { describe, expect, test } from 'bun:test'

import {
  analyzeBootstrapArguments,
  removeGithubTokenArguments,
  resolveGithubTokenCommand,
} from '~/daemon/github-token-argv'

describe('github token argv sanitization', () => {
  test('resolves internal start booleans only from real subcommand arguments', () => {
    const cases = [
      { args: ['-v', 'start', '--_service'], nativeService: true, processLog: false },
      { args: ['start', '--service'], nativeService: true, processLog: false },
      { args: ['start', '---service'], nativeService: true, processLog: false },
      { args: ['start', '--_service=false'], nativeService: false, processLog: false },
      { args: ['start', '--service', '--no-service'], nativeService: false, processLog: false },
      { args: ['--_service', 'start'], nativeService: false, processLog: false },
      { args: ['start', '--host', '--_service'], nativeService: false, processLog: false },
      { args: ['start', '--host', '--', '--service'], nativeService: true, processLog: false },
      { args: ['start', '--', '--service'], nativeService: false, processLog: false },
      { args: ['start', '--_log-file'], nativeService: false, processLog: true },
      { args: ['start', '--logFile'], nativeService: false, processLog: true },
      { args: ['start', '---log-file'], nativeService: false, processLog: true },
      { args: ['start', '--_log-file=false'], nativeService: false, processLog: false },
      { args: ['--_log-file', 'start'], nativeService: false, processLog: false },
      { args: ['start', '-p', '--logFile'], nativeService: false, processLog: false },
      { args: ['start', '--no-logFile', '---log-file'], nativeService: false, processLog: true },
    ]

    for (const testCase of cases) {
      const analysis = analyzeBootstrapArguments(testCase.args)
      expect({
        args: testCase.args,
        nativeService: analysis.nativeService,
        processLog: analysis.processLog,
      }).toEqual(testCase)
    }

    const help = analyzeBootstrapArguments([
      '--help',
      'start',
      '--_service',
      '--_log-file',
      '--github-token=help-token',
      '--_data-dir=/tmp/help-data',
    ])
    expect(help).toMatchObject({
      dataDir: '/tmp/help-data',
      nativeService: false,
      processLog: false,
      rootHelp: true,
      token: 'help-token',
    })
  })

  test('shares Citty consumption semantics with early data-dir selection', () => {
    const cases = [
      {
        args: ['start', '---data-dir', '--_data-dir', '--github-token=nested-token'],
        expectedDataDir: undefined,
        expectedToken: 'nested-token',
      },
      {
        args: ['start', '--host', '--_data-dir=inline-leak', '--github-token=real-token'],
        expectedDataDir: undefined,
        expectedToken: 'real-token',
      },
      {
        args: ['start', '-vp', '--_data-dir', '--github-token=short-token'],
        expectedDataDir: undefined,
        expectedToken: 'short-token',
      },
      {
        args: ['start', '-pv', '--_data-dir', '/tmp/short-path', '--github-token=short-token'],
        expectedDataDir: '/tmp/short-path',
        expectedToken: 'short-token',
      },
      {
        args: ['auth', '--github-token', '--_data-dir', '--github-token=auth-token'],
        expectedDataDir: undefined,
        expectedToken: 'auth-token',
      },
      {
        args: ['--github-token', '--_data-dir', '--github-token=prefix-token', 'auth'],
        expectedDataDir: undefined,
        expectedToken: 'prefix-token',
      },
      {
        args: ['start', '--host', '--', '--_data-dir', '/tmp/after-consumed-terminator', '--github-token=start-token'],
        expectedDataDir: '/tmp/after-consumed-terminator',
        expectedToken: 'start-token',
      },
      {
        args: ['auth', '--github-token', '--', '--_data-dir', '/tmp/after-consumed-terminator', '--github-token=auth-token'],
        expectedDataDir: '/tmp/after-consumed-terminator',
        expectedToken: 'auth-token',
      },
      {
        args: ['start', '--', '--_data-dir', '/tmp/after-standalone-terminator', '--github-token=ignored'],
        expectedDataDir: undefined,
        expectedToken: undefined,
      },
      {
        args: ['auth', '--_data-dir', '/tmp/first', '--_data-dir', '--github-token=repeated-token'],
        expectedDataDir: '/tmp/first',
        expectedToken: 'repeated-token',
      },
      {
        args: ['--_data-dir', '-dash-path', 'auth', '--github-token=prefix-path-token'],
        expectedDataDir: '-dash-path',
        expectedToken: 'prefix-path-token',
      },
      {
        args: ['--_data-dir', 'auth', '--github-token=dual-role-token'],
        expectedDataDir: 'auth',
        expectedToken: 'dual-role-token',
      },
      {
        args: ['start', '--_data-dir=/tmp/inline', '--github-token=inline-token'],
        expectedDataDir: '/tmp/inline',
        expectedToken: 'inline-token',
      },
    ] as const

    for (const testCase of cases) {
      const analysis = analyzeBootstrapArguments([...testCase.args])
      expect(analysis.dataDir).toBe(testCase.expectedDataDir)
      expect(analysis.token).toBe(testCase.expectedToken)
    }
  })

  test('locates Citty subcommands after short, long, and unknown prefix options', () => {
    expect(resolveGithubTokenCommand(['-v', '--verbose', '-x', 'start'])).toBe('start')
    expect(resolveGithubTokenCommand(['--unknown=value', '-xyz', 'auth'])).toBe('auth')
    expect(removeGithubTokenArguments([
      '-v',
      '--unknown',
      'start',
      '--github-token',
      'prefixed-command-token',
      '--port',
      '0',
    ])).toEqual({
      args: ['-v', '--unknown', 'start', '--port', '0'],
      token: 'prefixed-command-token',
    })
  })

  test('removes token-bearing prefix options without consuming the subcommand', () => {
    expect(removeGithubTokenArguments([
      '--github-token',
      'separated-prefix-token',
      'start',
      '--port',
      '0',
    ])).toEqual({
      args: ['start', '--port', '0'],
      token: 'separated-prefix-token',
    })
    expect(removeGithubTokenArguments([
      '--githubToken=long-prefix-token',
      '-v',
      'start',
      '--port',
      '0',
    ])).toEqual({
      args: ['-v', 'start', '--port', '0'],
      token: 'long-prefix-token',
    })
    expect(removeGithubTokenArguments([
      '-xgshort-prefix-token',
      '--unknown',
      'auth',
    ])).toEqual({
      args: ['-x', '--unknown', 'auth'],
      token: 'short-prefix-token',
    })
    expect(removeGithubTokenArguments([
      '--github-token',
      '-dash-prefixed-token',
      'start',
    ])).toEqual({
      args: ['start'],
      token: '-dash-prefixed-token',
    })
    expect(removeGithubTokenArguments([
      '-g',
      'auth',
      '--github-token',
      'auth-token',
    ])).toEqual({
      args: ['-g', 'auth'],
      token: 'auth-token',
    })
    expect(removeGithubTokenArguments([
      '--github-token',
      'start',
      '--github-token',
      'start-token',
    ])).toEqual({
      args: ['--github-token', 'start'],
      token: 'start-token',
    })
  })

  test('does not search past Citty terminators, option values, or other commands', () => {
    for (const args of [
      ['--', 'start', '--github-token', 'secret'],
      ['--unknown', 'value', 'start', '--github-token', 'secret'],
      ['positional', '--unknown', 'auth', '--github-token', 'secret'],
      ['debug', 'start', '--github-token', 'secret'],
    ]) {
      expect(resolveGithubTokenCommand(args)).toBeUndefined()
      expect(removeGithubTokenArguments(args)).toEqual({ args })
    }
  })

  test('removes long and short token forms while preserving other arguments', () => {
    expect(removeGithubTokenArguments([
      'start',
      '--port',
      '4400',
      '--github-token=first',
      '-g',
      'second',
      '--verbose',
    ])).toEqual({
      args: ['start', '--port', '4400', '--verbose'],
      token: 'second',
    })
  })

  test('removes Citty camelCase token forms for start and auth', () => {
    expect(removeGithubTokenArguments([
      'start',
      '--githubToken',
      'camel-separated',
      '--verbose',
    ])).toEqual({
      args: ['start', '--verbose'],
      token: 'camel-separated',
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--githubToken=camel-equals',
      '--verbose',
    ])).toEqual({
      args: ['auth', '--verbose'],
      token: 'camel-equals',
    })
  })

  test('prefers Citty canonical token values over camelCase aliases', () => {
    expect(removeGithubTokenArguments([
      'start',
      '--github-token=canonical-first',
      '--githubToken=camel-second',
    ])).toEqual({
      args: ['start'],
      token: 'canonical-first',
    })
    expect(removeGithubTokenArguments([
      'auth',
      '-gcanonical-short',
      '--githubToken=camel-second',
    ])).toEqual({
      args: ['auth'],
      token: 'canonical-short',
    })
    expect(removeGithubTokenArguments([
      'start',
      '--githubToken=camel-first',
      '--github-token=canonical-second',
    ])).toEqual({
      args: ['start'],
      token: 'canonical-second',
    })
  })

  test('does not interpret arguments after the option terminator', () => {
    expect(removeGithubTokenArguments([
      'start',
      '--',
      '--github-token',
      'not-an-option',
    ])).toEqual({
      args: ['start', '--', '--github-token', 'not-an-option'],
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--',
      '--githubToken=not-an-option',
    ])).toEqual({
      args: ['auth', '--', '--githubToken=not-an-option'],
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--_data-dir',
      '--',
      '--githubToken=not-an-option',
    ])).toEqual({
      args: ['auth', '--_data-dir', '--', '--githubToken=not-an-option'],
    })
  })

  test('removes compact and clustered short token forms using citty semantics', () => {
    expect(removeGithubTokenArguments(['start', '-dgcompact', '--port', '4400'])).toEqual({
      args: ['start', '-d', '--port', '4400'],
      token: 'compact',
    })
    expect(removeGithubTokenArguments(['start', '-xgclustered'])).toEqual({
      args: ['start', '-x'],
      token: 'clustered',
    })
    expect(removeGithubTokenArguments(['start', '-g=literal'])).toEqual({
      args: ['start'],
      token: '=literal',
    })
  })

  test('consumes dash-prefixed token values without confusing earlier string options', () => {
    expect(removeGithubTokenArguments(['start', '--github-token', '-secret'])).toEqual({
      args: ['start'],
      token: '-secret',
    })
    expect(removeGithubTokenArguments(['start', '-dg', '-cluster-secret'])).toEqual({
      args: ['start', '-d'],
      token: '-cluster-secret',
    })
    expect(removeGithubTokenArguments(['start', '-Hhost-with-g'])).toEqual({
      args: ['start', '-Hhost-with-g'],
    })
    expect(removeGithubTokenArguments(['start', '-p', '-gnot-a-token'])).toEqual({
      args: ['start', '-p', '-gnot-a-token'],
    })
    expect(removeGithubTokenArguments(['start', '--host', '--github-token=still-host-data'])).toEqual({
      args: ['start', '--host', '--github-token=still-host-data'],
    })
    expect(removeGithubTokenArguments(['start', '--max-concurrency', '--github-token=still-option-data'])).toEqual({
      args: ['start', '--max-concurrency', '--github-token=still-option-data'],
    })
    expect(removeGithubTokenArguments(['start', '--preset', '--github-token=still-preset-data'])).toEqual({
      args: ['start', '--preset', '--github-token=still-preset-data'],
    })
    expect(removeGithubTokenArguments(['start', '--maxConcurrency', '--githubToken=still-option-data'])).toEqual({
      args: ['start', '--maxConcurrency', '--githubToken=still-option-data'],
    })
    expect(removeGithubTokenArguments(['start', '--dataDir', '--githubToken=still-data-dir-data'])).toEqual({
      args: ['start', '--dataDir', '--githubToken=still-data-dir-data'],
    })
    expect(removeGithubTokenArguments(['start', '-vp', '-gstill-port-data'])).toEqual({
      args: ['start', '-vp', '-gstill-port-data'],
    })
    expect(removeGithubTokenArguments(['start', '-xH', '-gstill-host-data'])).toEqual({
      args: ['start', '-xH', '-gstill-host-data'],
    })
    expect(removeGithubTokenArguments(['auth', '-pgactual-auth-token'])).toEqual({
      args: ['auth', '-p'],
      token: 'actual-auth-token',
    })
    expect(removeGithubTokenArguments([
      'start',
      '--host',
      '--',
      '--github-token',
      'token-after-consumed-terminator',
    ])).toEqual({
      args: ['start', '--host', '--'],
      token: 'token-after-consumed-terminator',
    })
    expect(removeGithubTokenArguments([
      'start',
      'positional',
      '--unknown',
      '--github-token',
      'token-after-positional',
    ])).toEqual({
      args: ['start', 'positional', '--unknown'],
      token: 'token-after-positional',
    })
  })

  test('flags token-shaped arguments consumed as other option values', () => {
    const sentinel = 'FAKE_GITHUB_TOKEN_SENTINEL'
    const malformedCases = [
      ['start', '--port', `--github-token=${sentinel}`],
      ['start', '--port', '--no-verbose', `--github-token=${sentinel}`],
      ['start', '--preset', `--githubToken=${sentinel}`],
      ['start', '--host', '--github-token', sentinel],
      ['start', '-p', `-g${sentinel}`],
      ['start', '--host', '-xg', sentinel],
      ['start', `--host=--github-token=${sentinel}`],
      ['start', `--port=-g${sentinel}`],
      ['start', `-vp-g${sentinel}`],
      ['start', '--', `--github-token=${sentinel}`],
      ['start', '--_data-dir', `--github-token=${sentinel}`],
      ['auth', '--_data-dir', `--githubToken=${sentinel}`],
      [`--no-github-token=${sentinel}`, 'start'],
      [`--no-g=${sentinel}`, 'start'],
      ['start', `--no-g=${sentinel}`],
      [`--host=--github-token=${sentinel}`, 'start'],
    ]

    for (const args of malformedCases) {
      const analysis = analyzeBootstrapArguments(args)
      expect(analysis.misplacedGithubToken, args.join(' ')).toBe(true)
      expect(analysis.token, args.join(' ')).toBeUndefined()
    }

    const normal = analyzeBootstrapArguments([
      'start',
      '--port',
      '4400',
      `--github-token=${sentinel}`,
    ])
    expect(normal.misplacedGithubToken).toBe(false)
    expect(normal.token).toBe(sentinel)
    expect(normal.args).toEqual(['start', '--port', '4400'])

    const separatedNegative = analyzeBootstrapArguments([
      '--no-github-token',
      sentinel,
      'start',
    ])
    expect(separatedNegative.misplacedGithubToken).toBe(true)
    expect(separatedNegative.token).toBeUndefined()

    const separatedShortNegative = analyzeBootstrapArguments([
      '--no-g',
      sentinel,
      'start',
    ])
    expect(separatedShortNegative.misplacedGithubToken).toBe(true)
    expect(separatedShortNegative.token).toBeUndefined()
  })

  test('preserves missing and empty camelCase token values like the dashed form', () => {
    expect(removeGithubTokenArguments(['start', '--githubToken'])).toEqual({
      args: ['start', '--githubToken'],
    })
    expect(removeGithubTokenArguments(['auth', '--githubToken='])).toEqual({
      args: ['auth', '--githubToken='],
    })
    expect(removeGithubTokenArguments(['start', '--githubToken', '-secret'])).toEqual({
      args: ['start'],
      token: '-secret',
    })
  })

  test('does not extract token-shaped values consumed by the auth data-dir bootstrap', () => {
    expect(removeGithubTokenArguments([
      '--_data-dir',
      '--github-token=prefix-data-dir-value',
      'auth',
      '--help',
    ])).toEqual({
      args: [
        '--_data-dir',
        '--github-token=prefix-data-dir-value',
        'auth',
        '--help',
      ],
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--_data-dir',
      '--githubToken=still-data-dir-data',
    ])).toEqual({
      args: ['auth', '--_data-dir', '--githubToken=still-data-dir-data'],
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--_data-dir',
      '--github-token',
      'still-positional-data',
    ])).toEqual({
      args: ['auth', '--_data-dir', '--github-token', 'still-positional-data'],
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--_data-dir',
      '-gstill-data-dir-data',
    ])).toEqual({
      args: ['auth', '--_data-dir', '-gstill-data-dir-data'],
    })
  })

  test('only protects the first effective auth data-dir bootstrap value', () => {
    expect(removeGithubTokenArguments([
      'auth',
      '--_data-dir',
      '/tmp/first-data-dir',
      '--_data-dir',
      '--github-token=real-token',
      '--help',
    ])).toEqual({
      args: [
        'auth',
        '--_data-dir',
        '/tmp/first-data-dir',
        '--_data-dir',
        '--help',
      ],
      token: 'real-token',
    })
  })

  test('does not protect a raw data-dir value after its option was consumed', () => {
    expect(removeGithubTokenArguments([
      'start',
      '---data-dir',
      '--_data-dir',
      '--github-token=nested-token',
      '--help',
    ])).toEqual({
      args: ['start', '---data-dir', '--_data-dir', '--help'],
      token: 'nested-token',
    })
    expect(removeGithubTokenArguments([
      'start',
      '--host',
      '--_data-dir',
      '--githubToken=nested-camel-token',
    ])).toEqual({
      args: ['start', '--host', '--_data-dir'],
      token: 'nested-camel-token',
    })
    expect(removeGithubTokenArguments([
      'start',
      '-vp',
      '--_data-dir',
      '-gnested-short-token',
    ])).toEqual({
      args: ['start', '-vp', '--_data-dir'],
      token: 'nested-short-token',
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--github-token',
      '--_data-dir',
      '--github-token=nested-auth-token',
    ])).toEqual({
      args: ['auth'],
      token: 'nested-auth-token',
    })
    expect(removeGithubTokenArguments([
      '--github-token',
      '--_data-dir',
      '--github-token=nested-prefix-token',
      'start',
    ])).toEqual({
      args: ['start'],
      token: 'nested-prefix-token',
    })
  })

  test('extracts independent tokens after inline data-dir values and unsupported auth aliases', () => {
    expect(removeGithubTokenArguments([
      'auth',
      '--_data-dir=/tmp/copilot-proxy',
      '--githubToken=independent-token',
    ])).toEqual({
      args: ['auth', '--_data-dir=/tmp/copilot-proxy'],
      token: 'independent-token',
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--_data-dir=',
      '--githubToken',
      'independent-token',
    ])).toEqual({
      args: ['auth', '--_data-dir='],
      token: 'independent-token',
    })
    expect(removeGithubTokenArguments([
      'auth',
      '--dataDir',
      '--githubToken=independent-token',
    ])).toEqual({
      args: ['auth', '--dataDir'],
      token: 'independent-token',
    })
    expect(removeGithubTokenArguments([
      'start',
      '--dataDir=/tmp/copilot-proxy',
      '--githubToken=independent-token',
    ])).toEqual({
      args: ['start', '--dataDir=/tmp/copilot-proxy'],
      token: 'independent-token',
    })
  })

  test('consumes Citty kebab aliases generated from leading-underscore start options', () => {
    expect(removeGithubTokenArguments([
      'start',
      '---data-dir',
      '--github-token=still-data-dir-data',
    ])).toEqual({
      args: ['start', '---data-dir', '--github-token=still-data-dir-data'],
    })
    expect(removeGithubTokenArguments([
      'start',
      '---instance-token',
      '-gstill-instance-token-data',
    ])).toEqual({
      args: ['start', '---instance-token', '-gstill-instance-token-data'],
    })
  })

  test('does not rewrite unrelated commands', () => {
    expect(removeGithubTokenArguments(['debug', '--github-token=opaque'])).toEqual({
      args: ['debug', '--github-token=opaque'],
    })
  })

  test('extracts auth command tokens before the device flow starts', () => {
    expect(removeGithubTokenArguments([
      'auth',
      '--github-token',
      'ghu_auth_token',
      '--verbose',
    ])).toEqual({
      args: ['auth', '--verbose'],
      token: 'ghu_auth_token',
    })
    expect(removeGithubTokenArguments(['auth', '-vgcompact'])).toEqual({
      args: ['auth', '-v'],
      token: 'compact',
    })
  })
})
