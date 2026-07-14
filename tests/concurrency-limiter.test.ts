import { describe, expect, test } from 'bun:test'

import {
  AsyncConcurrencyLimiter,
  ConcurrencyLimitError,
  DEFAULT_CONCURRENCY_MAX_QUEUE,
  DEFAULT_CONCURRENCY_QUEUE_TIMEOUT_MS,
  resolveConcurrencyLimitConfig,
} from '~/lib/concurrency-limiter'

describe('resolveConcurrencyLimitConfig', () => {
  test('stays disabled until maxConcurrency is explicitly configured', () => {
    expect(resolveConcurrencyLimitConfig({})).toBeUndefined()
    expect(() => resolveConcurrencyLimitConfig({ maxQueue: 1 })).toThrow('require maxConcurrency')
    expect(() => resolveConcurrencyLimitConfig({ queueTimeoutMs: 1 })).toThrow('require maxConcurrency')
  })

  test('applies bounded queue defaults only when enabled', () => {
    expect(resolveConcurrencyLimitConfig({ maxConcurrency: 8 })).toEqual({
      maxConcurrency: 8,
      maxQueue: DEFAULT_CONCURRENCY_MAX_QUEUE,
      queueTimeoutMs: DEFAULT_CONCURRENCY_QUEUE_TIMEOUT_MS,
    })
    expect(resolveConcurrencyLimitConfig({
      maxConcurrency: 8,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })).toEqual({
      maxConcurrency: 8,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
  })
})

describe('AsyncConcurrencyLimiter', () => {
  test('enforces max concurrency, FIFO queueing, and the queue bound', async () => {
    const limiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 2,
      maxQueue: 2,
      queueTimeoutMs: 1_000,
    })
    const first = await limiter.acquire()
    const second = await limiter.acquire()
    const thirdPromise = limiter.acquire()
    const fourthPromise = limiter.acquire()

    const overflow = await limiter.acquire().catch((error: unknown) => error)
    expect(overflow).toBeInstanceOf(ConcurrencyLimitError)
    expect((overflow as ConcurrencyLimitError).code).toBe('concurrency_queue_full')
    expect(limiter.snapshot(0)).toMatchObject({
      active: 2,
      queued: 2,
      available: 0,
      queueFullRejections: 1,
    })

    first.release()
    const third = await thirdPromise
    expect(limiter.snapshot().active).toBe(2)
    expect(limiter.snapshot().queued).toBe(1)

    second.release()
    const fourth = await fourthPromise
    expect(limiter.snapshot().queued).toBe(0)

    third.release()
    fourth.release()
    fourth.release()
    expect(limiter.snapshot()).toMatchObject({
      active: 0,
      totalAcquired: 4,
      totalReleased: 4,
    })
  })

  test('times out a queued acquisition without leaking capacity', async () => {
    const limiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 2,
      queueTimeoutMs: 20,
    })
    const active = await limiter.acquire()
    const error = await limiter.acquire().catch((error: unknown) => error)

    expect(error).toBeInstanceOf(ConcurrencyLimitError)
    expect((error as ConcurrencyLimitError).code).toBe('concurrency_queue_timeout')
    expect(limiter.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      queueTimeoutRejections: 1,
    })

    active.release()
    const next = await limiter.acquire()
    next.release()
    expect(limiter.snapshot().active).toBe(0)
  })

  test('removes an aborted waiter and preserves the next FIFO waiter', async () => {
    const limiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 2,
      queueTimeoutMs: 1_000,
    })
    const active = await limiter.acquire()
    const controller = new AbortController()
    const abortedPromise = limiter.acquire({ signal: controller.signal })
    const nextPromise = limiter.acquire()

    controller.abort()
    const error = await abortedPromise.catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ConcurrencyLimitError)
    expect((error as Error).name).toBe('AbortError')
    expect((error as ConcurrencyLimitError).code).toBe('concurrency_acquire_aborted')
    expect(limiter.snapshot()).toMatchObject({ queued: 1, abortedAcquisitions: 1 })

    active.release()
    const next = await nextPromise
    next.release()
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0 })
  })

  test('run always releases its lease when the operation fails', async () => {
    const limiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 100,
    })

    await expect(limiter.run(() => {
      throw new Error('operation failed')
    })).rejects.toThrow('operation failed')

    expect(limiter.snapshot()).toMatchObject({
      active: 0,
      totalAcquired: 1,
      totalReleased: 1,
    })
  })

  test('zero wait rejects only when no slot is immediately available', async () => {
    const limiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 1,
      queueTimeoutMs: 0,
    })
    const active = await limiter.acquire()
    const error = await limiter.acquire().catch((error: unknown) => error)
    expect((error as ConcurrencyLimitError).code).toBe('concurrency_queue_timeout')
    active.release()
  })

  test('snapshot contains only aggregate configuration and counters', async () => {
    const limiter = new AsyncConcurrencyLimiter({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
    })
    const lease = await limiter.acquire()

    expect(limiter.snapshot()).toEqual({
      maxConcurrency: 1,
      maxQueue: 0,
      queueTimeoutMs: 0,
      active: 1,
      queued: 0,
      available: 0,
      oldestQueueWaitMs: 0,
      totalAcquired: 1,
      totalReleased: 0,
      queueFullRejections: 0,
      queueTimeoutRejections: 0,
      abortedAcquisitions: 0,
    })

    lease.release()
  })

  test('rejects invalid construction options', () => {
    expect(() => new AsyncConcurrencyLimiter({ maxConcurrency: 0, maxQueue: 1, queueTimeoutMs: 1 }))
      .toThrow('maxConcurrency')
    expect(() => new AsyncConcurrencyLimiter({ maxConcurrency: 1, maxQueue: -1, queueTimeoutMs: 1 }))
      .toThrow('maxQueue')
    expect(() => new AsyncConcurrencyLimiter({ maxConcurrency: 1, maxQueue: 1, queueTimeoutMs: -1 }))
      .toThrow('queueTimeoutMs')
  })
})
