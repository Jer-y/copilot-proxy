export const DEFAULT_COPILOT_HEADERS_TIMEOUT_MS = 15 * 60 * 1000
export const DEFAULT_COPILOT_BODY_TIMEOUT_MS = 15 * 60 * 1000
export const DEFAULT_COPILOT_CONNECT_TIMEOUT_MS = 30 * 1000
export const DEFAULT_GITHUB_FETCH_TIMEOUT_MS = 30 * 1000

// Node and Bun both implement timers with a signed 32-bit millisecond delay.
// Larger values are coerced to 1ms, which turns a nominally long timeout into
// an immediate one.
export const MAX_TIMER_DELAY_MS = 2_147_483_647
