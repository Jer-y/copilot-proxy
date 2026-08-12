export function hashFraction(accountId: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < accountId.length; index++) {
    hash ^= accountId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash / 0x1_0000_0000
}

export function jitterTokenRefreshDelay(
  delayMs: number,
  accountId: string,
  enabled: boolean,
): number {
  if (!enabled)
    return delayMs
  const maxJitter = Math.min(delayMs * 0.05, 30_000)
  return delayMs - hashFraction(accountId) * maxJitter
}

export function jitterModelRefreshInterval(
  intervalMs: number,
  accountId: string,
  enabled: boolean,
): number {
  if (!enabled)
    return intervalMs
  const maxJitter = Math.min(intervalMs * 0.05, 30_000)
  return intervalMs + (hashFraction(accountId) * 2 - 1) * maxJitter
}
