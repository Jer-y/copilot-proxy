import { AsyncLocalStorage } from 'node:async_hooks'
import process from 'node:process'
import consola from 'consola'

import { HTTPError } from './error'

const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000
const MAX_PENDING_APPROVALS = 4

interface ApprovalRequestContext {
  method: string
  path: string
  clientAddress?: string
  origin?: string
  userAgent?: string
  model?: string
}

interface ApprovalQueueEntry {
  context?: ApprovalRequestContext
  options: ApprovalOptions
  reject: (reason?: unknown) => void
  resolve: () => void
  started: boolean
  queuedAbortListener?: () => void
}

const approvalRequestStorage = new AsyncLocalStorage<ApprovalRequestContext>()
const approvalQueue: ApprovalQueueEntry[] = []
let activeApproval: ApprovalQueueEntry | undefined

export interface ApprovalOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export function withApprovalRequestContext<T>(context: ApprovalRequestContext, callback: () => T): T {
  return approvalRequestStorage.run(context, callback)
}

export function setApprovalRequestModel(model: unknown): void {
  const context = approvalRequestStorage.getStore()
  if (context && typeof model === 'string')
    context.model = sanitizeAndTruncate(model)
}

export async function awaitApproval(options: ApprovalOptions = {}) {
  if (options.signal?.aborted)
    throw createApprovalAbortError()

  if (approvalQueue.length + (activeApproval ? 1 : 0) >= MAX_PENDING_APPROVALS) {
    throwApprovalUnavailable('Manual approval queue is full')
  }

  return await new Promise<void>((resolve, reject) => {
    const entry: ApprovalQueueEntry = {
      context: approvalRequestStorage.getStore(),
      options,
      reject,
      resolve,
      started: false,
    }

    if (options.signal) {
      entry.queuedAbortListener = () => {
        if (entry.started)
          return
        const index = approvalQueue.indexOf(entry)
        if (index === -1)
          return
        approvalQueue.splice(index, 1)
        removeQueuedAbortListener(entry)
        reject(createApprovalAbortError())
      }
      options.signal.addEventListener('abort', entry.queuedAbortListener, { once: true })
    }

    approvalQueue.push(entry)
    processApprovalQueue()
  })
}

function processApprovalQueue(): void {
  if (activeApproval)
    return

  const entry = approvalQueue.shift()
  if (!entry)
    return

  entry.started = true
  activeApproval = entry
  removeQueuedAbortListener(entry)

  const run = entry.context
    ? approvalRequestStorage.run(entry.context, () => awaitApprovalUnqueued(entry.options))
    : awaitApprovalUnqueued(entry.options)

  void raceApprovalWithAbort(run, entry.options.signal).then(
    () => entry.resolve(),
    (error: unknown) => entry.reject(error),
  )
  void run.then(
    () => finishApprovalRun(entry),
    () => finishApprovalRun(entry),
  )
}

function finishApprovalRun(entry: ApprovalQueueEntry): void {
  if (activeApproval !== entry)
    return
  activeApproval = undefined
  processApprovalQueue()
}

function removeQueuedAbortListener(entry: ApprovalQueueEntry): void {
  if (!entry.options.signal || !entry.queuedAbortListener)
    return
  entry.options.signal.removeEventListener('abort', entry.queuedAbortListener)
  entry.queuedAbortListener = undefined
}

async function awaitApprovalUnqueued(options: ApprovalOptions) {
  if (options.signal?.aborted)
    throw createApprovalAbortError()

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    consola.warn('Manual approval is enabled, but no interactive TTY is available; rejecting request.')
    throwApprovalUnavailable('Manual approval requires an interactive TTY')
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true
      controller.abort('manual approval timed out')
      resolve('timeout')
    }, timeoutMs)
    timeout.unref?.()
  })
  const promptSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const promptPromise = consola.prompt(formatApprovalPrompt(), {
    type: 'confirm',
    cancel: 'symbol',
    signal: promptSignal,
  } as Parameters<typeof consola.prompt>[1] & { signal: AbortSignal })

  const response = await Promise.race([
    promptPromise,
    timeoutPromise,
  ]).finally(() => {
    if (timeout)
      clearTimeout(timeout)
  })

  if (response === 'timeout' || timedOut) {
    consola.warn(`Manual approval timed out after ${timeoutMs}ms; rejecting request.`)
    throwApprovalUnavailable(`Manual approval timed out after ${timeoutMs}ms`)
  }

  if (typeof response === 'symbol') {
    throw new HTTPError(
      'Request rejected',
      Response.json({ message: 'Request rejected' }, { status: 403 }),
    )
  }

  if (!response) {
    throw new HTTPError(
      'Request rejected',
      Response.json({ message: 'Request rejected' }, { status: 403 }),
    )
  }
}

function raceApprovalWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal)
    return promise
  if (signal.aborted)
    return Promise.reject(createApprovalAbortError())

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(createApprovalAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, (error: unknown) => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

function createApprovalAbortError(): Error {
  const error = new Error('Manual approval was cancelled')
  error.name = 'AbortError'
  return error
}

function formatApprovalPrompt(): string {
  const context = approvalRequestStorage.getStore()
  if (!context)
    return 'Accept incoming request?'

  const details = [
    context.model ? `model=${sanitizeAndTruncate(context.model)}` : undefined,
    context.clientAddress ? `client=${sanitizeAndTruncate(context.clientAddress)}` : undefined,
    context.origin ? `origin=${sanitizeAndTruncate(context.origin)}` : undefined,
    context.userAgent ? `user-agent=${sanitizeAndTruncate(context.userAgent)}` : undefined,
  ].filter((value): value is string => value !== undefined)

  return `Accept incoming request? ${sanitizeAndTruncate(context.method)} ${sanitizeAndTruncate(context.path)}${details.length > 0 ? ` (${details.join(', ')})` : ''}`
}

function sanitizeAndTruncate(value: string): string {
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1F || (code >= 0x7F && code <= 0x9F) ? ' ' : character
  }).join('').trim()
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`
}

function throwApprovalUnavailable(message: string): never {
  throw new HTTPError(
    message,
    Response.json(
      {
        error: {
          message,
          type: 'server_error',
          code: 'manual_approval_unavailable',
        },
      },
      { status: 503 },
    ),
  )
}
