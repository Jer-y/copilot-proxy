import process from 'node:process'

import { UpstreamTimeoutError } from './error'
import {
  DEFAULT_COPILOT_BODY_TIMEOUT_MS,
  DEFAULT_COPILOT_CONNECT_TIMEOUT_MS,
  DEFAULT_COPILOT_HEADERS_TIMEOUT_MS,
  DEFAULT_GITHUB_FETCH_TIMEOUT_MS,
  MAX_TIMER_DELAY_MS,
} from './http-timeouts'
import { PROXY_ENV_KEYS, resolveProxyForUrlFromEnvironment } from './proxy-environment'

type FetchInput = Parameters<typeof fetch>[0]

interface FetchWithTimeoutOptions {
  timeoutMs?: number
  timeoutLabel?: string
}

export interface CopilotFetchTimeoutConfig {
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
  connectTimeoutMs?: number
  proxyEnv?: boolean
}

let copilotFetchTimeoutConfig: CopilotFetchTimeoutConfig = {}
let runtimeProxyEnvironment: NodeJS.ProcessEnv | undefined

export function configureCopilotFetchTimeouts(config: CopilotFetchTimeoutConfig): void {
  assertValidTimerDelay('headersTimeoutMs', config.headersTimeoutMs)
  assertValidTimerDelay('bodyTimeoutMs', config.bodyTimeoutMs)
  assertValidTimerDelay('connectTimeoutMs', config.connectTimeoutMs)
  copilotFetchTimeoutConfig = { ...config }
  runtimeProxyEnvironment = config.proxyEnv
    ? Object.fromEntries(
        PROXY_ENV_KEYS
          .map(key => [key, process.env[key]] as const)
          .filter((entry): entry is [typeof PROXY_ENV_KEYS[number], string] => entry[1] !== undefined),
      )
    : undefined
}

export function isRuntimeProxyEnvironmentEnabled(): boolean {
  return copilotFetchTimeoutConfig.proxyEnv === true
}

export function assertRuntimeProxyRoute(input: FetchInput): void {
  if (!runtimeProxyEnvironment)
    return
  const target = describeRequest(input)
  if (!resolveProxyForUrlFromEnvironment(target, runtimeProxyEnvironment)) {
    throw new Error(`--proxy-env resolved a direct route for ${target}; refusing to send upstream data outside the required proxy.`)
  }
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
    return fetchCopilotUnderNode(input, init)

  return fetchCopilotUnderBun(input, init)
}

export async function fetchCopilotUnderNode(
  input: FetchInput,
  init: RequestInit = {},
): Promise<Response> {
  const target = describeRequest(input)
  let response: Response
  try {
    response = await fetchWithRuntimeProxy(input, init)
  }
  catch (error) {
    throw normalizeUndiciTimeoutError(error, target)
  }

  if (!response.body)
    return response

  return wrapResponseBodyWithMappedErrors(
    response,
    error => normalizeUndiciTimeoutError(error, target),
  )
}

export function normalizeUndiciTimeoutError(error: unknown, target: string): unknown {
  const timeoutCode = findUndiciTimeoutCode(error)
  if (!timeoutCode)
    return error

  const phase = timeoutCode === 'UND_ERR_HEADERS_TIMEOUT'
    ? 'headers'
    : timeoutCode === 'UND_ERR_BODY_TIMEOUT'
      ? 'body'
      : 'connect'
  const timeoutMs = phase === 'headers'
    ? copilotFetchTimeoutConfig.headersTimeoutMs ?? DEFAULT_COPILOT_HEADERS_TIMEOUT_MS
    : phase === 'body'
      ? copilotFetchTimeoutConfig.bodyTimeoutMs ?? DEFAULT_COPILOT_BODY_TIMEOUT_MS
      : copilotFetchTimeoutConfig.connectTimeoutMs ?? DEFAULT_COPILOT_CONNECT_TIMEOUT_MS

  const normalized = new UpstreamTimeoutError(
    `Upstream ${phase} timed out after ${timeoutMs}ms: ${target}`,
    timeoutMs,
    target,
  )
  normalized.cause = error
  return normalized
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
  assertValidTimerDelay('timeoutMs', options.timeoutMs)
  if (options.timeoutMs === 0)
    return fetchWithRuntimeProxy(input, init)

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal

  try {
    return await fetchWithRuntimeProxy(input, {
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
    response = await fetchWithRuntimeProxy(input, {
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

function fetchWithRuntimeProxy(
  input: FetchInput,
  init: RequestInit = {},
): Promise<Response> {
  assertRuntimeProxyRoute(input)
  if (typeof Bun === 'undefined')
    return fetch(input, init)

  // The CLI restarts Bun with either a sanitized environment or the persisted
  // service proxy environment before this module is loaded. Bun snapshots that
  // startup environment, so ordinary fetch now has deterministic direct/proxy
  // behavior even after credentials are removed from process.env.
  return fetch(input, init)
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

function wrapResponseBodyWithMappedErrors(
  response: Response,
  mapError: (error: unknown) => unknown,
): Response {
  const source = response.body
  if (!source)
    return response

  const reader = source.getReader()
  let terminal = false

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (terminal)
        return

      try {
        const { done, value } = await reader.read()
        if (done) {
          terminal = true
          reader.releaseLock()
          controller.close()
          return
        }
        controller.enqueue(value)
      }
      catch (error) {
        terminal = true
        reader.releaseLock()
        controller.error(mapError(error))
      }
    },
    async cancel(reason) {
      terminal = true
      try {
        await reader.cancel(reason)
      }
      finally {
        reader.releaseLock()
      }
    },
  })

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function findUndiciTimeoutCode(
  error: unknown,
): 'UND_ERR_HEADERS_TIMEOUT' | 'UND_ERR_BODY_TIMEOUT' | 'UND_ERR_CONNECT_TIMEOUT' | undefined {
  const seen = new Set<object>()
  let current = error

  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    const code = 'code' in current ? current.code : undefined
    if (
      code === 'UND_ERR_HEADERS_TIMEOUT'
      || code === 'UND_ERR_BODY_TIMEOUT'
      || code === 'UND_ERR_CONNECT_TIMEOUT'
    ) {
      return code
    }
    current = 'cause' in current ? current.cause : undefined
  }

  return undefined
}

function assertValidTimerDelay(name: string, value: number | undefined): void {
  if (value === undefined)
    return

  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${name} must be an integer between 0 and ${MAX_TIMER_DELAY_MS}`)
  }
}

function describeRequest(input: FetchInput): string {
  if (typeof input === 'string')
    return input
  if (input instanceof URL)
    return input.toString()
  return input.url
}
