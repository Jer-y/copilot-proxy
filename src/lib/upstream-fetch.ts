import { UpstreamTimeoutError } from './error'
import {
  DEFAULT_COPILOT_BODY_TIMEOUT_MS,
  DEFAULT_COPILOT_HEADERS_TIMEOUT_MS,
  DEFAULT_GITHUB_FETCH_TIMEOUT_MS,
} from './http-timeouts'

type FetchInput = Parameters<typeof fetch>[0]

interface FetchWithTimeoutOptions {
  timeoutMs?: number
  timeoutLabel?: string
}

export interface CopilotFetchTimeoutConfig {
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
  connectTimeoutMs?: number
}

let copilotFetchTimeoutConfig: CopilotFetchTimeoutConfig = {}

export function configureCopilotFetchTimeouts(config: CopilotFetchTimeoutConfig): void {
  copilotFetchTimeoutConfig = { ...config }
}

export function fetchCopilot(
  input: FetchInput,
  init?: RequestInit,
  options?: FetchWithTimeoutOptions,
): Promise<Response> {
  if (options?.timeoutMs !== undefined) {
    return fetchWithTimeout(input, init, {
      timeoutMs: options.timeoutMs,
      timeoutLabel: options.timeoutLabel ?? describeRequest(input),
    })
  }

  // Node uses the undici dispatcher configured in proxy.ts. Adding a second
  // fixed AbortSignal timeout here would silently cap requests at 15 minutes
  // even when the user configured a different value or explicitly disabled
  // the dispatcher timeout with 0.
  if (typeof Bun === 'undefined')
    return fetch(input, init)

  return fetchCopilotUnderBun(input, init)
}

export function fetchGitHub(
  input: FetchInput,
  init?: RequestInit,
  options?: FetchWithTimeoutOptions,
): Promise<Response> {
  return fetchWithTimeout(input, init, {
    timeoutMs: options?.timeoutMs ?? DEFAULT_GITHUB_FETCH_TIMEOUT_MS,
    timeoutLabel: options?.timeoutLabel ?? describeRequest(input),
  })
}

export async function fetchWithTimeout(
  input: FetchInput,
  init: RequestInit = {},
  options: Required<FetchWithTimeoutOptions>,
): Promise<Response> {
  if (options.timeoutMs === 0)
    return fetch(input, init)

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal

  try {
    return await fetch(input, {
      ...init,
      signal,
    })
  }
  catch (error) {
    if (timeoutSignal.aborted && !(init.signal?.aborted)) {
      throw new UpstreamTimeoutError(
        `Upstream request timed out after ${options.timeoutMs}ms: ${options.timeoutLabel}`,
        options.timeoutMs,
        options.timeoutLabel,
      )
    }
    throw error
  }
}

async function fetchCopilotUnderBun(
  input: FetchInput,
  init: RequestInit = {},
): Promise<Response> {
  const target = describeRequest(input)
  const headersTimeoutMs = copilotFetchTimeoutConfig.headersTimeoutMs
    ?? DEFAULT_COPILOT_HEADERS_TIMEOUT_MS
  const bodyTimeoutMs = copilotFetchTimeoutConfig.bodyTimeoutMs
    ?? DEFAULT_COPILOT_BODY_TIMEOUT_MS
  // Bun has its own connection timeout but does not expose a connection-ready
  // hook. Keep that runtime default when the flag is omitted; an explicit
  // value is enforced during the pre-header phase below.
  const connectTimeoutMs = copilotFetchTimeoutConfig.connectTimeoutMs ?? 0
  const timeoutController = new AbortController()
  const requestSignal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal
  const phaseTimers: Array<ReturnType<typeof setTimeout>> = []
  let phaseTimeoutError: UpstreamTimeoutError | undefined

  const schedulePhaseTimeout = (timeoutMs: number, phase: 'headers' | 'connect') => {
    if (timeoutMs === 0)
      return
    const timer = setTimeout(() => {
      phaseTimeoutError = new UpstreamTimeoutError(
        `Upstream ${phase} timed out after ${timeoutMs}ms: ${target}`,
        timeoutMs,
        target,
      )
      timeoutController.abort(phaseTimeoutError)
    }, timeoutMs)
    timer.unref?.()
    phaseTimers.push(timer)
  }

  // Bun fetch does not expose separate connection and response-header hooks.
  // Both explicit phases are therefore enforced until response headers arrive;
  // once they do, their timers are cleared and the independent body inactivity
  // timeout takes over.
  schedulePhaseTimeout(headersTimeoutMs, 'headers')
  schedulePhaseTimeout(connectTimeoutMs, 'connect')

  let response: Response
  try {
    response = await fetch(input, {
      ...init,
      signal: requestSignal,
    })
  }
  catch (error) {
    if (phaseTimeoutError)
      throw phaseTimeoutError
    throw error
  }
  finally {
    for (const timer of phaseTimers)
      clearTimeout(timer)
  }

  if (bodyTimeoutMs === 0 || !response.body)
    return response

  return wrapResponseBodyWithTimeout(
    response,
    bodyTimeoutMs,
    target,
    timeoutController,
  )
}

function wrapResponseBodyWithTimeout(
  response: Response,
  timeoutMs: number,
  target: string,
  timeoutController: AbortController,
): Response {
  const source = response.body
  if (!source)
    return response

  const reader = source.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let terminal = false
  let bodyTimeoutError: UpstreamTimeoutError | undefined

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (terminal)
        return

      clearTimer()
      timer = setTimeout(() => {
        if (terminal)
          return
        terminal = true
        bodyTimeoutError = new UpstreamTimeoutError(
          `Upstream body timed out after ${timeoutMs}ms: ${target}`,
          timeoutMs,
          target,
        )
        timeoutController.abort(bodyTimeoutError)
        controller.error(bodyTimeoutError)
        void reader.cancel(bodyTimeoutError).catch(() => {})
      }, timeoutMs)
      timer.unref?.()

      try {
        const { done, value } = await reader.read()
        clearTimer()
        if (terminal)
          return
        if (done) {
          terminal = true
          controller.close()
          return
        }
        controller.enqueue(value)
      }
      catch (error) {
        clearTimer()
        if (terminal)
          return
        terminal = true
        controller.error(bodyTimeoutError ?? error)
      }
    },
    async cancel(reason) {
      terminal = true
      clearTimer()
      timeoutController.abort(reason)
      await reader.cancel(reason)
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function describeRequest(input: FetchInput): string {
  if (typeof input === 'string')
    return input
  if (input instanceof URL)
    return input.toString()
  return input.url
}
