import fs from 'node:fs'
import { expect, spyOn, test } from 'bun:test'
import consola from 'consola'

import { createAccountContext } from '~/lib/account/context'
import { ensurePaths, PATHS } from '~/lib/paths'
import { state } from '~/lib/state'
import { setupGitHubToken } from '~/lib/token'

test('authentication, initial token fetch, and refresh never log plaintext tokens', async () => {
  const oldTokenFile = fs.existsSync(PATHS.GITHUB_TOKEN_PATH) ? fs.readFileSync(PATHS.GITHUB_TOKEN_PATH) : undefined
  const oldGithubToken = state.defaultAccount.githubToken
  const oldLevel = consola.level
  const silentLog = Object.assign(() => {}, { raw: () => {} })
  const info = spyOn(consola, 'info').mockImplementation(silentLog)
  const debug = spyOn(consola, 'debug').mockImplementation(silentLog)
  const githubToken = 'GITHUB_TOKEN_RETIREMENT_SENTINEL'
  const copilotToken = 'COPILOT_TOKEN_RETIREMENT_SENTINEL'
  const refreshedToken = 'REFRESH_TOKEN_RETIREMENT_SENTINEL'
  const payload = { token: copilotToken, refresh_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600 }
  const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload))
  try {
    consola.level = 5
    await ensurePaths()
    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, githubToken, { mode: 0o600 })
    await setupGitHubToken({ logUser: false })
    expect(state.defaultAccount.githubToken).toBe(githubToken)
    const context = createAccountContext()
    context.githubToken = githubToken
    await context.tokens.setup({ scheduleRefresh: false })
    expect(context.copilotToken).toBe(copilotToken)
    await context.tokens.refreshWithRetry({ fetchToken: async () => ({ ...payload, token: refreshedToken }) })
    expect(context.copilotToken).toBe(refreshedToken)
    const logs = JSON.stringify([...info.mock.calls, ...debug.mock.calls])
    for (const token of [githubToken, copilotToken, refreshedToken])
      expect(logs).not.toContain(token)
  }
  finally {
    fetchSpy.mockRestore()
    info.mockRestore()
    debug.mockRestore()
    consola.level = oldLevel
    state.defaultAccount.githubToken = oldGithubToken
    if (oldTokenFile)
      fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, oldTokenFile, { mode: 0o600 })
    else
      fs.rmSync(PATHS.GITHUB_TOKEN_PATH, { force: true })
  }
})
