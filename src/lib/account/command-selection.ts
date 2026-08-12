import type { AccountContext } from './types'
import type { AccountType } from '~/lib/cli-validators'

import { state } from '~/lib/state'
import { getGitHubUser } from '~/services/github/get-user'

import { AccountRegistry } from './registry'
import {
  hardenAccountStoragePaths,
  readAccountsConfiguration,
  readAccountToken,
} from './store'

export interface CommandAccountSelection {
  accountId: string
  accountType: AccountType
  context: AccountContext
  explicit: boolean
  registry: AccountRegistry
}

export function selectCommandAccount(
  fallbackAccountType: AccountType,
  requestedAccountId?: string,
): CommandAccountSelection {
  if (requestedAccountId !== undefined && !requestedAccountId.trim())
    throw new Error('--account must contain an account id')
  const configuration = readAccountsConfiguration()
  if (!configuration) {
    if (requestedAccountId !== undefined) {
      throw new Error(
        `--account=${requestedAccountId} requires accounts.json; configure the account first with \`copilot-proxy accounts add\`.`,
      )
    }
    state.accountType = fallbackAccountType
    const registry = new AccountRegistry(undefined, state.defaultAccount)
    return {
      accountId: registry.defaultAccountId,
      accountType: fallbackAccountType,
      context: registry.defaultAccount,
      explicit: false,
      registry,
    }
  }

  const registry = new AccountRegistry(configuration)
  const accountId = requestedAccountId ?? configuration.defaultAccount
  const context = registry.get(accountId)
  if (!context)
    throw new Error(`Unknown account: ${accountId}`)

  hardenAccountStoragePaths()
  const githubToken = readAccountToken(accountId)
  if (!githubToken) {
    throw new Error(
      `Account ${accountId} has no persisted token. Run \`copilot-proxy accounts auth ${accountId}\`.`,
    )
  }
  context.githubToken = githubToken
  return {
    accountId,
    accountType: context.accountType,
    context,
    explicit: true,
    registry,
  }
}

export async function verifyCommandAccountIdentity(
  selection: CommandAccountSelection,
): Promise<void> {
  if (!selection.explicit)
    return
  const expectedUserId = selection.context.githubUserId
  if (expectedUserId === undefined)
    throw new Error(`Account ${selection.accountId} has no recorded GitHub user id`)
  const user = await getGitHubUser(selection.context)
  if (user.id !== expectedUserId) {
    throw new Error(
      `Persisted token for account ${selection.accountId} does not match its recorded GitHub identity (expected user id ${expectedUserId}, received ${user.id}).`,
    )
  }
  selection.context.githubLogin = user.login
  selection.context.githubUserId = user.id
  selection.context.identityState = 'ok'
}
