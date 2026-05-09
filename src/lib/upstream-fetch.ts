import { UpstreamTimeoutError } from './error'
import {
  DEFAULT_COPILOT_FETCH_TIMEOUT_MS,
  DEFAULT_GITHUB_FETCH_TIMEOUT_MS,
} from './http-timeouts'

type FetchInput = Parameters<typeof fetch>[0]

interface FetchWithTimeoutOptions {
  timeoutMs?: number
  timeoutLabel?: string
}

export function fetchCopilot(
  input: FetchInput,
  init?: RequestInit,
  options?: FetchWithTimeoutOptions,
): Promise<Response> {
  return fetchWithTimeout(input, init, {
    timeoutMs: options?.timeoutMs ?? DEFAULT_COPILOT_FETCH_TIMEOUT_MS,
    timeoutLabel: options?.timeoutLabel ?? describeRequest(input),
  })
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

function describeRequest(input: FetchInput): string {
  if (typeof input === 'string')
    return input
  if (input instanceof URL)
    return input.toString()
  return input.url
}
