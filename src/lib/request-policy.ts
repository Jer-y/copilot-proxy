import type { State } from './state'

import { awaitApproval } from './approval'
import { checkRateLimit } from './rate-limit'

export async function enforceRateLimit(state: State): Promise<void> {
  await checkRateLimit(state)
}

export async function enforceManualApproval(state: State): Promise<void> {
  if (state.manualApprove) {
    await awaitApproval()
  }
}
