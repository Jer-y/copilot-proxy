import type { AccountContext, AccountIdentityState } from './types'

import { getGitHubUser } from '~/services/github/get-user'

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
const WINDOWS_RESERVED_ACCOUNT_IDS = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/

export interface AccountIdentityAssessment {
  state: AccountIdentityState
  login?: string
  userId?: number
  error?: unknown
}

export function assertValidAccountId(accountId: string): void {
  if (
    !ACCOUNT_ID_PATTERN.test(accountId)
    || accountId === '.'
    || accountId === '..'
    || WINDOWS_RESERVED_ACCOUNT_IDS.test(accountId)
  ) {
    throw new Error(
      `Invalid account id "${accountId}". Use 1-32 lowercase letters, digits, underscores, or hyphens; Windows reserved names are not allowed.`,
    )
  }
}

export async function assessAccountIdentity(
  ctx: AccountContext,
  expectedUserId?: number,
): Promise<AccountIdentityAssessment> {
  try {
    const user = await getGitHubUser(ctx)
    if (expectedUserId !== undefined && user.id !== expectedUserId) {
      return {
        state: 'mismatch',
        login: user.login,
        userId: user.id,
      }
    }
    return {
      state: 'ok',
      login: user.login,
      userId: user.id,
    }
  }
  catch (error) {
    return { state: 'unverified', error }
  }
}
