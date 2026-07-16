import type { ApprovalOptions } from './approval'
import type { RateLimitOptions } from './rate-limit'
import type { State } from './state'

import { awaitApproval } from './approval'
import { checkRateLimit } from './rate-limit'

export async function enforceRateLimit(
  state: State,
  options: RateLimitOptions = {},
): Promise<void> {
  await checkRateLimit(state, options)
}

export async function enforceManualApproval(
  state: State,
  options: ApprovalOptions = {},
): Promise<void> {
  if (state.manualApprove) {
    await awaitApproval(options)
  }
}
