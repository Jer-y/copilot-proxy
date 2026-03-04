// ─── Token Refresh ──────────────────────────────────────────────
export const TOKEN_MAX_RETRIES = 3
export const TOKEN_RETRY_DELAYS = [1_000, 5_000, 15_000] as const

// ─── Supervisor Crash Recovery ──────────────────────────────────
/** Maximum backoff delay between supervisor restarts (ms) */
export const SUPERVISOR_MAX_BACKOFF_MS = 60_000
/** Minimum uptime (ms) before a run is considered "stable" (resets backoff) */
export const SUPERVISOR_STABLE_THRESHOLD_MS = 60_000
/** Initial backoff delay (ms) */
export const SUPERVISOR_INITIAL_BACKOFF_MS = 1_000
