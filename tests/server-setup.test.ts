import { describe, expect, test } from 'bun:test'

import { consumeGithubToken, formatModelInventorySummary } from '~/lib/server-setup'

describe('consumeGithubToken', () => {
  test('prefers explicit CLI input, then GH_TOKEN, then GITHUB_TOKEN', () => {
    const explicitEnv = { GH_TOKEN: 'gh-token', GITHUB_TOKEN: 'github-token' }
    expect(consumeGithubToken('cli-token', explicitEnv)).toBe('cli-token')

    const ghEnv = { GH_TOKEN: 'gh-token', GITHUB_TOKEN: 'github-token' }
    expect(consumeGithubToken(undefined, ghEnv)).toBe('gh-token')

    const githubEnv = { GITHUB_TOKEN: 'github-token' }
    expect(consumeGithubToken(undefined, githubEnv)).toBe('github-token')
  })

  test('removes both environment aliases after consuming the startup secret', () => {
    const env: NodeJS.ProcessEnv = {
      GH_TOKEN: 'gh-token',
      GITHUB_TOKEN: 'github-token',
      HOME: '/home/test',
    }

    expect(consumeGithubToken(undefined, env)).toBe('gh-token')
    expect(env).toEqual({ HOME: '/home/test' })
  })

  test('reuses the in-memory token after a supervisor retry consumed its env source', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(consumeGithubToken(undefined, env, 'existing-process-token')).toBe('existing-process-token')
  })

  test('ignores blank values and falls back to the token file path', () => {
    const env = { GH_TOKEN: '  ', GITHUB_TOKEN: '' }
    expect(consumeGithubToken(undefined, env)).toBeUndefined()
  })
})

describe('formatModelInventorySummary', () => {
  test('keeps startup output bounded as the catalog grows', () => {
    expect(formatModelInventorySummary(39)).toBe('Loaded 39 Copilot models. Run `copilot-proxy models` for details.')
    expect(formatModelInventorySummary(1)).toContain('1 Copilot model.')
  })
})
