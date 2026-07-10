import { AsyncLocalStorage } from 'node:async_hooks'
import process from 'node:process'
import consola from 'consola'

import { HTTPError } from './error'

const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000
let approvalQueue: Promise<void> = Promise.resolve()

interface ApprovalRequestContext {
  method: string
  path: string
  clientAddress?: string
  origin?: string
  userAgent?: string
  model?: string
}

const approvalRequestStorage = new AsyncLocalStorage<ApprovalRequestContext>()

export function withApprovalRequestContext<T>(context: ApprovalRequestContext, callback: () => T): T {
  return approvalRequestStorage.run(context, callback)
}

export function setApprovalRequestModel(model: unknown): void {
  const context = approvalRequestStorage.getStore()
  if (context && typeof model === 'string')
    context.model = sanitizeAndTruncate(model)
}

export async function awaitApproval(options?: { timeoutMs?: number }) {
  const run = approvalQueue.then(
    () => awaitApprovalUnqueued(options),
    () => awaitApprovalUnqueued(options),
  )
  approvalQueue = run.catch(() => {})
  return run
}

async function awaitApprovalUnqueued(options?: { timeoutMs?: number }) {
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
  const promptPromise = consola.prompt(formatApprovalPrompt(), {
    type: 'confirm',
    cancel: 'symbol',
    signal: controller.signal,
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
