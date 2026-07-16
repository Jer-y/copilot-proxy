import type { State } from './state'

import consola from 'consola'

import { HTTPError } from './error'
import { MAX_TIMER_DELAY_MS } from './http-timeouts'

export interface RateLimitOptions {
  signal?: AbortSignal
}

interface RateLimitReservation {
  abortListener?: () => void
  dueAt: number
  gapMs: number
  resolve: () => void
  settled: boolean
  signal?: AbortSignal
}

interface RateLimitWaitQueue {
  baselineTimestamp: number
  reservations: RateLimitReservation[]
  timer?: ReturnType<typeof setTimeout>
}

const waitQueues = new WeakMap<State, RateLimitWaitQueue>()

export async function checkRateLimit(
  state: State,
  options: RateLimitOptions = {},
): Promise<void> {
  if (state.rateLimitSeconds === undefined)
    return

  if (options.signal?.aborted)
    throw createRateLimitAbortError()

  const now = Date.now()

  if (!state.lastRequestTimestamp) {
    state.lastRequestTimestamp = now
    return
  }

  const requiredGapMs = state.rateLimitSeconds * 1000
  const elapsedMs = now - state.lastRequestTimestamp
  const existingQueue = waitQueues.get(state)

  if (elapsedMs >= requiredGapMs && !existingQueue?.reservations.length) {
    state.lastRequestTimestamp = now
    return
  }

  const dueAt = existingQueue?.reservations.length
    ? existingQueue.reservations.at(-1)!.dueAt + requiredGapMs
    : state.lastRequestTimestamp + requiredGapMs
  const waitTimeMs = Math.max(0, dueAt - now)
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

  consola.warn(
    `Rate limit reached. Waiting ${waitTimeSeconds} seconds before proceeding...`,
  )

  await reserveRateLimitSlot(
    state,
    existingQueue ?? {
      baselineTimestamp: state.lastRequestTimestamp,
      reservations: [],
    },
    dueAt,
    requiredGapMs,
    options.signal,
  )

  consola.info('Rate limit wait completed, proceeding with request')
}

function reserveRateLimitSlot(
  state: State,
  queue: RateLimitWaitQueue,
  dueAt: number,
  gapMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const reservation: RateLimitReservation = {
      dueAt,
      gapMs,
      resolve,
      settled: false,
      signal,
    }

    if (signal) {
      reservation.abortListener = () => {
        const index = queue.reservations.indexOf(reservation)
        if (index === -1 || reservation.settled)
          return

        queue.reservations.splice(index, 1)
        settleReservation(reservation)
        compactQueueFrom(queue, index)
        syncQueueState(state, queue)
        scheduleQueueHead(state, queue)
        reject(createRateLimitAbortError())
      }
      signal.addEventListener('abort', reservation.abortListener, { once: true })
    }

    queue.reservations.push(reservation)
    waitQueues.set(state, queue)
    state.lastRequestTimestamp = dueAt

    if (queue.reservations.length === 1)
      scheduleQueueHead(state, queue)
  })
}

function completeQueueHead(state: State, queue: RateLimitWaitQueue): void {
  const reservation = queue.reservations.shift()
  if (!reservation || reservation.settled)
    return

  queue.timer = undefined
  settleReservation(reservation)

  // Anchor following reservations to the time this request actually proceeds,
  // rather than to an already elapsed nominal timer slot.
  queue.baselineTimestamp = Date.now()
  compactQueueFrom(queue, 0)
  syncQueueState(state, queue)
  scheduleQueueHead(state, queue)
  reservation.resolve()
}

function compactQueueFrom(queue: RateLimitWaitQueue, startIndex: number): void {
  let previousTimestamp = startIndex === 0
    ? queue.baselineTimestamp
    : queue.reservations[startIndex - 1].dueAt

  for (let index = startIndex; index < queue.reservations.length; index++) {
    const reservation = queue.reservations[index]
    reservation.dueAt = previousTimestamp + reservation.gapMs
    previousTimestamp = reservation.dueAt
  }
}

function scheduleQueueHead(state: State, queue: RateLimitWaitQueue): void {
  if (queue.timer !== undefined) {
    clearTimeout(queue.timer)
    queue.timer = undefined
  }

  const head = queue.reservations[0]
  if (!head)
    return

  queue.timer = setTimeout(
    completeQueueHead,
    Math.max(0, head.dueAt - Date.now()),
    state,
    queue,
  )
}

function syncQueueState(state: State, queue: RateLimitWaitQueue): void {
  const tail = queue.reservations.at(-1)
  state.lastRequestTimestamp = tail?.dueAt ?? queue.baselineTimestamp

  if (queue.reservations.length === 0) {
    if (queue.timer !== undefined) {
      clearTimeout(queue.timer)
      queue.timer = undefined
    }
    waitQueues.delete(state)
  }
}

function settleReservation(reservation: RateLimitReservation): void {
  if (reservation.settled)
    return
  reservation.settled = true
  if (reservation.signal && reservation.abortListener)
    reservation.signal.removeEventListener('abort', reservation.abortListener)
}

function createRateLimitAbortError(): Error {
  const error = new Error('Waiting for the rate limit interval was aborted')
  error.name = 'AbortError'
  return error
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
