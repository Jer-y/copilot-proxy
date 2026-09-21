import type { AccountsConfiguration } from '~/lib/account/types'
import type { AccountType } from '~/lib/cli-validators'
import { expect, test } from 'bun:test'

import { setupProxyRequiredTargets } from '~/setup'
import { startProxyRequiredTargets } from '~/start'

test.each(['individual', 'business', 'enterprise'] as const)('preserves exact ordered network targets for %s', (accountType) => {
  const origin = accountType === 'individual' ? 'https://api.githubcopilot.com' : `https://api.${accountType}.githubcopilot.com`
  const expected = ['https://api.github.com', origin, 'https://update.code.visualstudio.com', 'https://raw.githubusercontent.com']
  expect(startProxyRequiredTargets(accountType)).toEqual(expected)
  expect(setupProxyRequiredTargets(accountType)).toEqual(['https://github.com', ...expected])
})

test('preserves configured account order and deduplication without adding fallback origins', () => {
  const configuration: AccountsConfiguration = {
    version: 1,
    revision: 1,
    defaultAccount: 'slot0',
    accounts: (['business', 'enterprise', 'business'] as AccountType[]).map((accountType, index) => ({
      id: `slot${index}`,
      accountType,
      githubLogin: `user${index}`,
      githubUserId: index + 1,
    })),
    routes: [],
    requiredRoutes: [],
  }
  const expected = ['https://api.github.com', 'https://api.business.githubcopilot.com', 'https://api.enterprise.githubcopilot.com', 'https://update.code.visualstudio.com', 'https://raw.githubusercontent.com']
  expect(startProxyRequiredTargets('individual', configuration)).toEqual(expected)
  expect(setupProxyRequiredTargets('individual', configuration)).toEqual(['https://github.com', ...expected])
})
