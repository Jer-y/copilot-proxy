// ─── Token Refresh ──────────────────────────────────────────────
export const TOKEN_MAX_RETRIES = 3
export const TOKEN_RETRY_DELAYS = [1_000, 5_000, 15_000] as const

export const MANUAL_APPROVAL_REMOVED_MESSAGE = 'Manual request approval has been removed. Remove --manual or set legacy manual:false only if unattended forwarding is intended.'
