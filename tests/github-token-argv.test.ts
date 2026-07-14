import { describe, expect, test } from 'bun:test'

import { removeGithubTokenArguments } from '~/daemon/github-token-argv'

describe('github token argv sanitization', () => {
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

  test('does not interpret arguments after the option terminator', () => {
    expect(removeGithubTokenArguments([
      'start',
      '--',
      '--github-token',
      'not-an-option',
    ])).toEqual({
      args: ['start', '--', '--github-token', 'not-an-option'],
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
