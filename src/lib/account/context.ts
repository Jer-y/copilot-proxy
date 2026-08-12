import type { AccountContext, CreateAccountContextOptions } from './types'

import { RecoveryRegistry } from './recovery-registry'
import { TokenLifecycle } from './token-lifecycle'

export function createAccountContext(
  options: CreateAccountContextOptions = {},
): AccountContext {
  const ctx = {
    id: options.id ?? 'default',
    accountType: options.accountType ?? 'individual',
    identityState: 'unverified',
    availability: 'initializing',
  } as AccountContext
  Object.defineProperty(ctx, 'tokens', {
    configurable: false,
    enumerable: true,
    value: new TokenLifecycle(ctx),
    writable: false,
  })
  Object.defineProperty(ctx, 'recovery', {
    configurable: false,
    enumerable: true,
    value: new RecoveryRegistry(),
    writable: false,
  })
  return ctx
}
