import fs from 'node:fs'
import { afterEach, describe, expect, mock, test } from 'bun:test'

import { checkUsageProxyRequiredTargets, runCheckUsage } from '~/check-usage'
import { writeAccountsConfiguration, writeAccountToken } from '~/lib/account/store'
import { PATHS } from '~/lib/paths'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  cleanAccountState()
})

describe('check-usage command', () => {
  test('requires device-flow routing only for legacy mode', () => {
    expect(checkUsageProxyRequiredTargets({ explicit: true })).not.toContain('https://github.com')
    expect(checkUsageProxyRequiredTargets({ explicit: false })).toContain('https://github.com')
  })

  test('uses the selected enterprise account and never the coexisting legacy token', async () => {
    writeAccountsConfiguration({
      version: 1,
      revision: 1,
      defaultAccount: 'personal',
      requiredRoutes: [],
      accounts: [
        { id: 'personal', accountType: 'individual', githubLogin: 'alice', githubUserId: 1 },
        { id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 },
      ],
      routes: [],
    })
    writeAccountToken('personal', 'token_personal')
    writeAccountToken('work', 'token_work')
    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, 'token_legacy', { mode: 0o600 })

    const requests: Array<{ authorization: string | null, target: string }> = []
    const output: string[] = []
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const target = String(input)
      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      const authorization = headers.get('authorization')
      requests.push({ authorization, target })
      if (target.includes('update.code.visualstudio.com'))
        return Response.json(['1.111.0'])
      if (target === 'https://api.github.com/user') {
        return authorization === 'token token_work'
          ? Response.json({ id: 2, login: 'alice-work' })
          : new Response('wrong GitHub identity token', { status: 401 })
      }
      if (target.endsWith('/copilot_internal/user')) {
        return authorization === 'token token_work'
          ? Response.json({
              copilot_plan: 'enterprise',
              quota_reset_date: '2026-09-01',
              quota_snapshots: {
                chat: quota(100, 90),
                completions: quota(100, 80),
                premium_interactions: quota(300, 240),
              },
            })
          : new Response('wrong GitHub token', { status: 401 })
      }
      return new Response('unexpected request', { status: 500 })
    }) as unknown as typeof fetch

    const usage = await runCheckUsage({
      account: 'work',
      proxyEnv: false,
    }, {
      writeOutput(value) {
        output.push(value)
      },
    })

    expect(usage.copilot_plan).toBe('enterprise')
    expect(output.join('')).toContain('account: work/enterprise')
    expect(requests).toContainEqual({
      authorization: 'token token_work',
      target: 'https://api.github.com/user',
    })
    expect(requests).toContainEqual({
      authorization: 'token token_work',
      target: 'https://api.github.com/copilot_internal/user',
    })
    expect(JSON.stringify(requests)).not.toContain('token_legacy')
    expect(requests.some(request => request.target.includes('/login/device/code'))).toBe(false)
    expect(requests.some(request => request.target.includes('/copilot_internal/v2/token'))).toBe(false)
  })

  test('fails closed when the persisted token does not match the recorded account identity', async () => {
    writeAccountsConfiguration({
      version: 1,
      revision: 1,
      defaultAccount: 'work',
      requiredRoutes: [],
      accounts: [
        { id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 },
      ],
      routes: [],
    })
    writeAccountToken('work', 'token_wrong_identity')
    fs.writeFileSync(PATHS.GITHUB_TOKEN_PATH, 'token_legacy', { mode: 0o600 })

    const targets: string[] = []
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const target = String(input)
      targets.push(target)
      if (target.includes('update.code.visualstudio.com'))
        return Response.json(['1.111.0'])
      if (target === 'https://api.github.com/user')
        return Response.json({ id: 999, login: 'mallory' })
      return new Response('must not continue after identity mismatch', { status: 500 })
    }) as unknown as typeof fetch

    await expect(runCheckUsage({ proxyEnv: false }))
      .rejects
      .toThrow('does not match its recorded GitHub identity')
    expect(targets).toContain('https://api.github.com/user')
    expect(targets.some(target => target.endsWith('/copilot_internal/user'))).toBe(false)
    expect(JSON.stringify(targets)).not.toContain('token_legacy')
  })
})

function quota(entitlement: number, remaining: number) {
  return {
    entitlement,
    percent_remaining: remaining / entitlement * 100,
    remaining,
    unlimited: false,
  }
}

function cleanAccountState(): void {
  fs.rmSync(PATHS.ACCOUNTS_CONFIG, { force: true })
  fs.rmSync(PATHS.TOKENS_DIR, { force: true, recursive: true })
  fs.rmSync(PATHS.GITHUB_TOKEN_PATH, { force: true })
}
