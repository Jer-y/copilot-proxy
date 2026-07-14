import { describe, expect, test } from 'bun:test'
import { validateAccountType, validateMaxConcurrency, validateMaxQueue, validatePort, validateQueueTimeoutMs, validateRateLimit, validateTimeoutMs } from '~/lib/cli-validators'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'

describe('validatePort', () => {
  test('valid port returns number', () => {
    expect(validatePort('4399')).toBe(4399)
  })
  test('port 1 is valid', () => {
    expect(validatePort('1')).toBe(1)
  })
  test('port 65535 is valid', () => {
    expect(validatePort('65535')).toBe(65535)
  })
  test('port 0 returns null', () => {
    expect(validatePort('0')).toBeNull()
  })
  test('port 65536 returns null', () => {
    expect(validatePort('65536')).toBeNull()
  })
  test('non-numeric string returns null', () => {
    expect(validatePort('abc')).toBeNull()
  })
  test('float string returns null', () => {
    expect(validatePort('3.14')).toBeNull()
  })
  test('port with leading zeros returns null', () => {
    expect(validatePort('0080')).toBeNull()
  })
})

describe('validateRateLimit', () => {
  test('undefined returns valid with undefined value', () => {
    expect(validateRateLimit(undefined)).toEqual({ valid: true, value: undefined })
  })
  test('valid rate limit returns number', () => {
    expect(validateRateLimit('60')).toEqual({ valid: true, value: 60 })
  })
  test('rate limit 1 is valid', () => {
    expect(validateRateLimit('1')).toEqual({ valid: true, value: 1 })
  })
  test('rate limit 86400 is valid', () => {
    expect(validateRateLimit('86400')).toEqual({ valid: true, value: 86400 })
  })
  test('rate limit 0 is invalid', () => {
    expect(validateRateLimit('0')).toEqual({ valid: false, value: undefined })
  })
  test('rate limit 86401 is invalid', () => {
    expect(validateRateLimit('86401')).toEqual({ valid: false, value: undefined })
  })
  test('non-numeric string is invalid', () => {
    expect(validateRateLimit('abc')).toEqual({ valid: false, value: undefined })
  })
})

describe('validateAccountType', () => {
  test('individual is valid', () => {
    expect(validateAccountType('individual')).toBe(true)
  })
  test('business is valid', () => {
    expect(validateAccountType('business')).toBe(true)
  })
  test('enterprise is valid', () => {
    expect(validateAccountType('enterprise')).toBe(true)
  })
  test('unknown type is invalid', () => {
    expect(validateAccountType('team')).toBe(false)
  })
})

describe('concurrency option validators', () => {
  test('validates an optional positive max concurrency', () => {
    expect(validateMaxConcurrency(undefined)).toEqual({ valid: true, value: undefined })
    expect(validateMaxConcurrency('1')).toEqual({ valid: true, value: 1 })
    expect(validateMaxConcurrency('32')).toEqual({ valid: true, value: 32 })
    expect(validateMaxConcurrency('0')).toEqual({ valid: false, value: undefined })
    expect(validateMaxConcurrency('1.5')).toEqual({ valid: false, value: undefined })
  })

  test('allows zero to disable queueing and rejects unsafe queue sizes', () => {
    expect(validateMaxQueue(undefined)).toEqual({ valid: true, value: undefined })
    expect(validateMaxQueue('0')).toEqual({ valid: true, value: 0 })
    expect(validateMaxQueue('50')).toEqual({ valid: true, value: 50 })
    expect(validateMaxQueue('-1')).toEqual({ valid: false, value: undefined })
    expect(validateMaxQueue(String(Number.MAX_SAFE_INTEGER + 1))).toEqual({ valid: false, value: undefined })
  })

  test('allows zero queue wait and enforces the runtime timer maximum', () => {
    expect(validateQueueTimeoutMs('0')).toEqual({ valid: true, value: 0 })
    expect(validateQueueTimeoutMs('30000')).toEqual({ valid: true, value: 30_000 })
    expect(validateQueueTimeoutMs(String(MAX_TIMER_DELAY_MS + 1))).toEqual({ valid: false, value: undefined })
  })
})

describe('validateTimeoutMs', () => {
  test('undefined returns valid with undefined value', () => {
    expect(validateTimeoutMs(undefined)).toEqual({ valid: true, value: undefined })
  })

  test('zero is valid', () => {
    expect(validateTimeoutMs('0')).toEqual({ valid: true, value: 0 })
  })

  test('positive integer is valid', () => {
    expect(validateTimeoutMs('600000')).toEqual({ valid: true, value: 600000 })
  })

  test('accepts the largest JavaScript timer delay', () => {
    expect(validateTimeoutMs(String(MAX_TIMER_DELAY_MS))).toEqual({
      valid: true,
      value: MAX_TIMER_DELAY_MS,
    })
  })

  test('rejects delays that runtimes would coerce to 1ms', () => {
    expect(validateTimeoutMs(String(MAX_TIMER_DELAY_MS + 1))).toEqual({
      valid: false,
      value: undefined,
    })
  })

  test('negative integer is invalid', () => {
    expect(validateTimeoutMs('-1')).toEqual({ valid: false, value: undefined })
  })

  test('non-integer string is invalid', () => {
    expect(validateTimeoutMs('3.14')).toEqual({ valid: false, value: undefined })
  })

  test('non-numeric string is invalid', () => {
    expect(validateTimeoutMs('abc')).toEqual({ valid: false, value: undefined })
  })
})
