import type { State } from './state'

import consola from 'consola'

import { HTTPError } from './error'
import { MAX_TIMER_DELAY_MS } from './http-timeouts'
import { sleep } from './utils'

export async function checkRateLimit(state: State) {
  if (state.rateLimitSeconds === undefined)
    return

  const now = Date.now()

  if (!state.lastRequestTimestamp) {
    state.lastRequestTimestamp = now
    return
  }

  const requiredGapMs = state.rateLimitSeconds * 1000
  const elapsedMs = now - state.lastRequestTimestamp

  if (elapsedMs >= requiredGapMs) {
    state.lastRequestTimestamp = now
    return
  }

  const waitTimeMs = requiredGapMs - elapsedMs
  const waitTimeSeconds = Math.ceil(waitTimeMs / 1000)

  if (!state.rateLimitWait) {
    consola.warn(
      `Rate limit exceeded. Need to wait ${waitTimeSeconds} more seconds.`,
    )
    throw new HTTPError(
      'Rate limit exceeded',
      createRateLimitResponse('Rate limit exceeded', waitTimeSeconds),
    )
  }

  // Node and Bun coerce setTimeout delays above MAX_TIMER_DELAY_MS to 1ms.
  // Reject an over-full wait queue before reserving another slot so a burst of
  // queued requests cannot turn into immediate upstream traffic. Existing
  // reservations remain intact and continue to preserve their ordering.
  if (waitTimeMs > MAX_TIMER_DELAY_MS) {
    throw new HTTPError(
      'Rate limit wait queue is full',
      createRateLimitResponse(
        'Rate limit wait queue is full',
        waitTimeSeconds,
        'rate_limit_queue_full',
      ),
    )
  }

  // Reserve the slot this request will occupy after waiting. Concurrent
  // requests see this future timestamp and queue behind it instead of waking
  // up in the same burst.
  state.lastRequestTimestamp = now + waitTimeMs

  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )
  await sleep(waitTimeMs)

  consola.info('Rate limit wait completed, proceeding with request')
}

function createRateLimitResponse(message: string, retryAfterSeconds: number, code?: string): Response {
  return Response.json({
    error: {
      message,
      type: 'rate_limit_error',
      ...(code && { code }),
    },
  }, {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  })
}
