import { MAX_TIMER_DELAY_MS } from './http-timeouts'

export const DEFAULT_CONCURRENCY_MAX_QUEUE = 50
export const DEFAULT_CONCURRENCY_QUEUE_TIMEOUT_MS = 30_000

export interface ConcurrencyLimitConfig {
  maxConcurrency: number
  maxQueue: number
  queueTimeoutMs: number
}

export interface ConcurrencyLimitInput {
  maxConcurrency?: number
  maxQueue?: number
  queueTimeoutMs?: number
}

export type ConcurrencyLimitErrorCode
  = | 'concurrency_queue_full'
    | 'concurrency_queue_timeout'
    | 'concurrency_acquire_aborted'

export class ConcurrencyLimitError extends Error {
  readonly code: ConcurrencyLimitErrorCode

  constructor(code: ConcurrencyLimitErrorCode, message: string) {
    super(message)
    this.name = code === 'concurrency_acquire_aborted'
      ? 'AbortError'
      : 'ConcurrencyLimitError'
    this.code = code
  }
}

export interface ConcurrencyLease {
  readonly released: boolean
  release: () => void
}

export interface ConcurrencyAcquireOptions {
  signal?: AbortSignal
}

export interface ConcurrencyLimiterSnapshot extends ConcurrencyLimitConfig {
  active: number
  queued: number
  available: number
  oldestQueueWaitMs: number
  totalAcquired: number
  totalReleased: number
  queueFullRejections: number
  queueTimeoutRejections: number
  abortedAcquisitions: number
}

interface QueueEntry {
  enqueuedAt: number
  signal?: AbortSignal
  abortListener?: () => void
  timeout?: ReturnType<typeof setTimeout>
  settled: boolean
  resolve: (lease: ConcurrencyLease) => void
  reject: (error: ConcurrencyLimitError) => void
}

/**
 * Resolve optional CLI/service settings to the concrete limiter configuration.
 * The limiter remains disabled unless maxConcurrency is explicitly set.
 */
export function resolveConcurrencyLimitConfig(input: ConcurrencyLimitInput): ConcurrencyLimitConfig | undefined {
  const { maxConcurrency, maxQueue, queueTimeoutMs } = input

  if (maxConcurrency === undefined) {
    if (maxQueue !== undefined || queueTimeoutMs !== undefined) {
      throw new TypeError('maxQueue and queueTimeoutMs require maxConcurrency')
    }
    return undefined
  }

  const config = {
    maxConcurrency,
    maxQueue: maxQueue ?? DEFAULT_CONCURRENCY_MAX_QUEUE,
    queueTimeoutMs: queueTimeoutMs ?? DEFAULT_CONCURRENCY_QUEUE_TIMEOUT_MS,
  }
  validateConcurrencyLimitConfig(config)
  return config
}

/**
 * FIFO async semaphore with a bounded queue and idempotent leases.
 * queueTimeoutMs=0 means that a request may use an immediately available slot
 * but never wait; maxQueue=0 disables queueing entirely.
 */
export class AsyncConcurrencyLimiter {
  readonly config: Readonly<ConcurrencyLimitConfig>

  private active = 0
  private readonly queue: QueueEntry[] = []
  private totalAcquired = 0
  private totalReleased = 0
  private queueFullRejections = 0
  private queueTimeoutRejections = 0
  private abortedAcquisitions = 0

  constructor(config: ConcurrencyLimitConfig) {
    validateConcurrencyLimitConfig(config)
    this.config = Object.freeze({ ...config })
  }

  acquire(options: ConcurrencyAcquireOptions = {}): Promise<ConcurrencyLease> {
    const { signal } = options
    if (signal?.aborted) {
      this.abortedAcquisitions++
      return Promise.reject(createAcquireAbortedError())
    }

    if (this.active < this.config.maxConcurrency && this.queue.length === 0) {
      return Promise.resolve(this.createLease())
    }

    if (this.config.maxQueue === 0 || this.queue.length >= this.config.maxQueue) {
      this.queueFullRejections++
      return Promise.reject(new ConcurrencyLimitError(
        'concurrency_queue_full',
        'Upstream concurrency wait queue is full',
      ))
    }

    if (this.config.queueTimeoutMs === 0) {
      this.queueTimeoutRejections++
      return Promise.reject(new ConcurrencyLimitError(
        'concurrency_queue_timeout',
        'Upstream concurrency slot was not immediately available',
      ))
    }

    return new Promise<ConcurrencyLease>((resolve, reject) => {
      const entry: QueueEntry = {
        enqueuedAt: Date.now(),
        signal,
        settled: false,
        resolve,
        reject,
      }

      if (signal) {
        entry.abortListener = () => {
          if (!this.removeQueuedEntry(entry))
            return
          this.abortedAcquisitions++
          this.rejectEntry(entry, createAcquireAbortedError())
          this.drain()
        }
        signal.addEventListener('abort', entry.abortListener, { once: true })
      }

      entry.timeout = setTimeout(() => {
        if (!this.removeQueuedEntry(entry))
          return
        this.queueTimeoutRejections++
        this.rejectEntry(entry, new ConcurrencyLimitError(
          'concurrency_queue_timeout',
          `Timed out waiting ${this.config.queueTimeoutMs}ms for an upstream concurrency slot`,
        ))
        this.drain()
      }, this.config.queueTimeoutMs)
      entry.timeout.unref?.()

      this.queue.push(entry)
    })
  }

  async run<T>(
    operation: (lease: ConcurrencyLease) => T | PromiseLike<T>,
    options: ConcurrencyAcquireOptions = {},
  ): Promise<T> {
    const lease = await this.acquire(options)
    try {
      return await operation(lease)
    }
    finally {
      lease.release()
    }
  }

  snapshot(now = Date.now()): ConcurrencyLimiterSnapshot {
    return {
      ...this.config,
      active: this.active,
      queued: this.queue.length,
      available: Math.max(0, this.config.maxConcurrency - this.active),
      oldestQueueWaitMs: this.queue.length > 0
        ? Math.max(0, now - this.queue[0].enqueuedAt)
        : 0,
      totalAcquired: this.totalAcquired,
      totalReleased: this.totalReleased,
      queueFullRejections: this.queueFullRejections,
      queueTimeoutRejections: this.queueTimeoutRejections,
      abortedAcquisitions: this.abortedAcquisitions,
    }
  }

  private createLease(): ConcurrencyLease {
    this.active++
    this.totalAcquired++
    let released = false

    return {
      get released() {
        return released
      },
      release: () => {
        if (released)
          return
        released = true
        this.active--
        this.totalReleased++
        this.drain()
      },
    }
  }

  private drain(): void {
    while (this.active < this.config.maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!
      if (entry.settled)
        continue
      this.cleanupEntry(entry)
      entry.settled = true
      entry.resolve(this.createLease())
    }
  }

  private removeQueuedEntry(entry: QueueEntry): boolean {
    if (entry.settled)
      return false
    const index = this.queue.indexOf(entry)
    if (index === -1)
      return false
    this.queue.splice(index, 1)
    return true
  }

  private rejectEntry(entry: QueueEntry, error: ConcurrencyLimitError): void {
    if (entry.settled)
      return
    this.cleanupEntry(entry)
    entry.settled = true
    entry.reject(error)
  }

  private cleanupEntry(entry: QueueEntry): void {
    if (entry.timeout)
      clearTimeout(entry.timeout)
    if (entry.signal && entry.abortListener)
      entry.signal.removeEventListener('abort', entry.abortListener)
  }
}

function validateConcurrencyLimitConfig(config: ConcurrencyLimitConfig): void {
  if (!Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency <= 0)
    throw new TypeError('maxConcurrency must be a positive safe integer')
  if (!Number.isSafeInteger(config.maxQueue) || config.maxQueue < 0)
    throw new TypeError('maxQueue must be a non-negative safe integer')
  if (!Number.isSafeInteger(config.queueTimeoutMs)
    || config.queueTimeoutMs < 0
    || config.queueTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`queueTimeoutMs must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`)
  }
}

function createAcquireAbortedError(): ConcurrencyLimitError {
  return new ConcurrencyLimitError(
    'concurrency_acquire_aborted',
    'Waiting for an upstream concurrency slot was aborted',
  )
}
