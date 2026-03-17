const VALID_ACCOUNT_TYPES = ['individual', 'business', 'enterprise'] as const

export type AccountType = (typeof VALID_ACCOUNT_TYPES)[number]

export function validatePort(raw: string): number | null {
  const port = Number.parseInt(raw, 10)
  if (Number.isNaN(port) || port <= 0 || port > 65535 || String(port) !== raw) {
    return null
  }
  return port
}

export function validateRateLimit(raw: string | undefined): { valid: boolean, value: number | undefined } {
  if (raw === undefined) {
    return { valid: true, value: undefined }
  }
  const rateLimit = Number.parseInt(raw, 10)
  if (Number.isNaN(rateLimit) || rateLimit <= 0 || rateLimit > 86400 || String(rateLimit) !== raw) {
    return { valid: false, value: undefined }
  }
  return { valid: true, value: rateLimit }
}

export function validateTimeoutMs(raw: string | undefined): { valid: boolean, value: number | undefined } {
  if (raw === undefined) {
    return { valid: true, value: undefined }
  }

  const timeoutMs = Number.parseInt(raw, 10)
  if (
    Number.isNaN(timeoutMs)
    || timeoutMs < 0
    || !Number.isSafeInteger(timeoutMs)
    || String(timeoutMs) !== raw
  ) {
    return { valid: false, value: undefined }
  }

  return { valid: true, value: timeoutMs }
}

export function validateAccountType(value: string): value is AccountType {
  return (VALID_ACCOUNT_TYPES as readonly string[]).includes(value)
}
