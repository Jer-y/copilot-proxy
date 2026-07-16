import type { ServerSentEventMessage } from 'fetch-event-stream'
import type WebSocket from 'ws'
import type { RawData } from 'ws'

import type { ResponsesPayload } from '~/services/copilot/create-responses'

import { Buffer } from 'node:buffer'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError, JSONResponseError, UpstreamTimeoutError } from '~/lib/error'
import { state } from '~/lib/state'
import { createResponses } from '~/services/copilot/create-responses'
import { openCopilotResponsesWebSocketAttempt } from '~/services/copilot/responses-websocket'

const DEFAULT_PROBE_TIMEOUT_MS = 180_000
const CLOSE_HANDSHAKE_TIMEOUT_MS = 1_000
const TERMINAL_EVENT_TYPES = new Set([
  'error',
  'response.completed',
  'response.failed',
  'response.incomplete',
])

export type LiveResponsesWebSocketPayload
  = | ResponsesPayload
    | ({ model: string } & Record<string, unknown>)

export interface DirectCopilotResponsesWebSocketProbeOptions {
  hasVision?: boolean
  initiator?: 'agent' | 'user'
  payload: LiveResponsesWebSocketPayload
  timeoutMs?: number
}

export interface DirectCopilotResponsesSSEProbeOptions {
  payload: ResponsesPayload
  timeoutMs?: number
}

export type LiveResponsesWebSocketProbePhase
  = | 'handshake'
    | 'protocol'
    | 'timeout'
    | 'transport'

export type LiveResponsesSSEProbePhase
  = | 'protocol'
    | 'request'
    | 'timeout'
    | 'transport'

export interface LiveResponsesWebSocketErrorDetails {
  code?: string
  message?: string
  param?: string | null
  status?: number
  type?: string
}

export interface LiveResponsesWebSocketCloseDetails {
  code: number
  reason: string
}

export interface LiveResponsesWebSocketResponse extends Record<string, unknown> {
  error?: LiveResponsesWebSocketErrorDetails | null
  id?: string
  incomplete_details?: Record<string, unknown> | null
  output?: Array<Record<string, unknown>>
  status?: string
}

export interface LiveResponsesTransportProbeResult {
  completed: boolean
  error?: LiveResponsesWebSocketErrorDetails
  eventTypes: Array<string>
  frames: Array<Record<string, unknown>>
  outputItems: Array<Record<string, unknown>>
  outputItemTypes: Array<string>
  outputText: string
  response?: LiveResponsesWebSocketResponse
  terminalEvent: Record<string, unknown>
  terminalType: string
  toolEventTypes: Array<string>
}

export interface DirectCopilotResponsesWebSocketProbeResult extends LiveResponsesTransportProbeResult {
  close: LiveResponsesWebSocketCloseDetails
}

export interface DirectCopilotResponsesSSEProbeResult extends LiveResponsesTransportProbeResult {}

export class DirectCopilotResponsesWebSocketProbeError extends Error {
  readonly close?: LiveResponsesWebSocketCloseDetails
  readonly details?: LiveResponsesWebSocketErrorDetails
  readonly httpStatus?: number
  readonly phase: LiveResponsesWebSocketProbePhase

  constructor(
    message: string,
    options: {
      cause?: unknown
      close?: LiveResponsesWebSocketCloseDetails
      details?: LiveResponsesWebSocketErrorDetails
      httpStatus?: number
      phase: LiveResponsesWebSocketProbePhase
    },
  ) {
    super(message, { cause: options.cause })
    this.name = 'DirectCopilotResponsesWebSocketProbeError'
    this.phase = options.phase
    this.close = options.close
    this.details = options.details
    this.httpStatus = options.httpStatus
  }
}

export class DirectCopilotResponsesSSEProbeError extends Error {
  readonly details?: LiveResponsesWebSocketErrorDetails
  readonly httpStatus?: number
  readonly phase: LiveResponsesSSEProbePhase

  constructor(
    message: string,
    options: {
      cause?: unknown
      details?: LiveResponsesWebSocketErrorDetails
      httpStatus?: number
      phase: LiveResponsesSSEProbePhase
    },
  ) {
    super(message, { cause: options.cause })
    this.name = 'DirectCopilotResponsesSSEProbeError'
    this.phase = options.phase
    this.details = options.details
    this.httpStatus = options.httpStatus
  }
}

/**
 * Sends one direct `response.create` to the current Copilot account endpoint.
 * The caller is responsible for installing the live token/account/version in
 * the shared state (the live capability harness does this via
 * `withLiveCopilotState`). No credential is included in the returned result or
 * in errors produced by this helper.
 */
export async function runDirectCopilotResponsesWebSocketProbe(
  options: DirectCopilotResponsesWebSocketProbeOptions,
): Promise<DirectCopilotResponsesWebSocketProbeResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const createEvent: Record<string, unknown> = {
    ...options.payload,
    type: 'response.create',
  }
  delete createEvent.stream

  if (createEvent.background === true) {
    throw new DirectCopilotResponsesWebSocketProbeError(
      'Responses WebSocket live probes cannot use background=true',
      { phase: 'protocol' },
    )
  }
  delete createEvent.background

  const abortController = new AbortController()
  const handshakeTimer = setTimeout(() => abortController.abort(), timeoutMs)
  const url = `${copilotBaseUrl(state).replace(/^http/, 'ws')}/responses`

  try {
    const attempt = await openCopilotResponsesWebSocketAttempt(url, {
      ...copilotHeaders(state, options.hasVision ?? false),
      'X-Initiator': options.initiator ?? 'user',
    }, abortController.signal)

    clearTimeout(handshakeTimer)

    if (!attempt.ok) {
      const details = await readHandshakeError(attempt.response)
      throw new DirectCopilotResponsesWebSocketProbeError(
        details.message ?? `Copilot Responses WebSocket handshake failed with HTTP ${attempt.response.status}`,
        {
          details,
          httpStatus: attempt.response.status,
          phase: 'handshake',
        },
      )
    }

    return await exchangeResponseCreate(
      attempt.socket,
      createEvent,
      timeoutMs,
      attempt.handoff,
    )
  }
  catch (error) {
    clearTimeout(handshakeTimer)
    if (error instanceof DirectCopilotResponsesWebSocketProbeError)
      throw error

    const phase = abortController.signal.aborted ? 'timeout' : 'handshake'
    throw new DirectCopilotResponsesWebSocketProbeError(
      phase === 'timeout'
        ? `Copilot Responses WebSocket handshake timed out after ${timeoutMs}ms`
        : `Copilot Responses WebSocket handshake failed: ${safeErrorMessage(error)}`,
      { cause: error, phase },
    )
  }
}

/**
 * Sends one direct streaming HTTP `/responses` request through the same
 * authenticated Copilot service used by the existing live capability runner.
 * It returns the same semantic summary as the WebSocket helper so paired
 * transport probes can validate event and final-response parity.
 */
export async function runDirectCopilotResponsesSSEProbe(
  options: DirectCopilotResponsesSSEProbeOptions,
): Promise<DirectCopilotResponsesSSEProbeResult> {
  const timeoutMs = normalizeTimeout(options.timeoutMs)
  const abortController = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    abortController.abort()
  }, timeoutMs)

  let result: Awaited<ReturnType<typeof createResponses>>
  try {
    result = await createResponses({
      ...options.payload,
      stream: true,
    }, { signal: abortController.signal })
  }
  catch (error) {
    clearTimeout(timeout)
    throw await normalizeSSERequestError(error, timedOut, timeoutMs)
  }

  if (!isAsyncIterable(result.body)) {
    clearTimeout(timeout)
    throw new DirectCopilotResponsesSSEProbeError(
      'Copilot /responses returned a non-streaming body for stream=true',
      { phase: 'protocol' },
    )
  }

  const frames: Array<Record<string, unknown>> = []
  let terminalEvent: Record<string, unknown> | undefined

  try {
    for await (const message of result.body) {
      const frame = parseSSEFrame(message)
      if (!frame)
        continue

      frames.push(frame)
      const eventType = stringProperty(frame, 'type')
      if (!eventType || !TERMINAL_EVENT_TYPES.has(eventType))
        continue

      terminalEvent = frame
      clearTimeout(timeout)
      await result.cancel?.('direct Responses SSE live probe reached a terminal event').catch(() => {})
      break
    }
  }
  catch (error) {
    await result.cancel?.('direct Responses SSE live probe failed').catch(() => {})
    if (error instanceof DirectCopilotResponsesSSEProbeError)
      throw error
    throw new DirectCopilotResponsesSSEProbeError(
      timedOut
        ? `Copilot Responses SSE probe timed out after ${timeoutMs}ms`
        : `Copilot Responses SSE transport failed: ${safeErrorMessage(error)}`,
      { cause: error, phase: timedOut ? 'timeout' : 'transport' },
    )
  }
  finally {
    clearTimeout(timeout)
  }

  if (!terminalEvent) {
    await result.cancel?.('direct Responses SSE live probe ended before a terminal event').catch(() => {})
    throw new DirectCopilotResponsesSSEProbeError(
      'Copilot Responses SSE stream ended before a terminal event',
      { phase: timedOut ? 'timeout' : 'protocol' },
    )
  }

  return summarizeResponsesTransportFrames(frames, terminalEvent)
}

export function summarizeResponsesWebSocketFrames(
  frames: Array<Record<string, unknown>>,
  terminalEvent: Record<string, unknown>,
  close: LiveResponsesWebSocketCloseDetails,
): DirectCopilotResponsesWebSocketProbeResult {
  return {
    ...summarizeResponsesTransportFrames(frames, terminalEvent),
    close,
  }
}

export function summarizeResponsesTransportFrames(
  frames: Array<Record<string, unknown>>,
  terminalEvent: Record<string, unknown>,
): LiveResponsesTransportProbeResult {
  const terminalType = stringProperty(terminalEvent, 'type') ?? 'unknown'
  const response = recordProperty(terminalEvent, 'response') as LiveResponsesWebSocketResponse | undefined
  const outputItems = collectOutputItems(frames, response)
  const eventTypes = frames
    .map(frame => stringProperty(frame, 'type'))
    .filter((type): type is string => type !== undefined)
  const outputItemTypes = uniqueStrings(outputItems
    .map(item => stringProperty(item, 'type'))
    .filter((type): type is string => type !== undefined))
  const toolEventTypes = uniqueStrings(eventTypes.filter(isToolEventType))
  const deltaText = frames
    .filter(frame => frame.type === 'response.output_text.delta')
    .map(frame => stringProperty(frame, 'delta') ?? '')
    .join('')

  return {
    completed: terminalType === 'response.completed' && response?.status === 'completed',
    error: terminalType === 'error'
      ? extractResponsesWebSocketError(terminalEvent)
      : normalizeErrorDetails(response?.error),
    eventTypes,
    frames,
    outputItems,
    outputItemTypes,
    outputText: deltaText || extractOutputText(outputItems),
    response,
    terminalEvent,
    terminalType,
    toolEventTypes,
  }
}

export function extractResponsesWebSocketError(
  frame: Record<string, unknown>,
): LiveResponsesWebSocketErrorDetails | undefined {
  const nested = recordProperty(frame, 'error')
  const source = nested ?? frame
  const details: LiveResponsesWebSocketErrorDetails = {
    code: stringProperty(source, 'code') ?? stringProperty(frame, 'code'),
    message: stringProperty(source, 'message') ?? stringProperty(frame, 'message'),
    param: nullableStringProperty(source, 'param') ?? nullableStringProperty(frame, 'param'),
    status: numberProperty(frame, 'status') ?? numberProperty(source, 'status'),
    type: stringProperty(source, 'type') ?? stringProperty(frame, 'type'),
  }

  return Object.values(details).some(value => value !== undefined)
    ? details
    : undefined
}

export async function exchangeResponseCreate(
  socket: WebSocket,
  createEvent: Record<string, unknown>,
  timeoutMs: number,
  handoff?: () => Error | undefined,
): Promise<DirectCopilotResponsesWebSocketProbeResult> {
  return await new Promise((resolve, reject) => {
    const frames: Array<Record<string, unknown>> = []
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let terminalEvent: Record<string, unknown> | undefined
    const safetyErrorGuard = () => {}
    const removeSafetyErrorGuard = () => socket.off('error', safetyErrorGuard)

    // Node's `ws` can emit one more asynchronous error after terminate(). The
    // active handler is removed when the promise settles, so retain this no-op
    // guard until the socket actually closes to avoid an unhandled EventEmitter
    // error during live-probe cleanup.
    socket.on('error', safetyErrorGuard)
    socket.once('close', removeSafetyErrorGuard)

    const responseTimer = setTimeout(() => {
      fail(new DirectCopilotResponsesWebSocketProbeError(
        `Copilot Responses WebSocket response timed out after ${timeoutMs}ms`,
        { phase: 'timeout' },
      ))
      socket.terminate()
    }, timeoutMs)

    function cleanup() {
      clearTimeout(responseTimer)
      if (closeTimer)
        clearTimeout(closeTimer)
      socket.off('close', onClose)
      socket.off('error', onError)
      socket.off('message', onMessage)
    }
    function fail(error: DirectCopilotResponsesWebSocketProbeError) {
      if (settled)
        return
      settled = true
      cleanup()
      reject(error)
    }
    function onClose(code: number, rawReason: Buffer) {
      const close = { code, reason: rawReason.toString('utf8') }
      if (!terminalEvent) {
        fail(new DirectCopilotResponsesWebSocketProbeError(
          `Copilot Responses WebSocket closed before a terminal event (code=${code})`,
          { close, phase: 'transport' },
        ))
        return
      }

      if (settled)
        return
      settled = true
      cleanup()
      resolve(summarizeResponsesWebSocketFrames(frames, terminalEvent, close))
    }
    function onError(error: Error) {
      if (terminalEvent)
        return
      fail(new DirectCopilotResponsesWebSocketProbeError(
        `Copilot Responses WebSocket transport failed: ${safeErrorMessage(error)}`,
        { cause: error, phase: 'transport' },
      ))
      socket.terminate()
    }
    function onMessage(rawData: RawData) {
      let frame: Record<string, unknown>
      try {
        frame = parseFrame(rawData)
      }
      catch (error) {
        fail(new DirectCopilotResponsesWebSocketProbeError(
          `Copilot Responses WebSocket returned an invalid JSON frame: ${safeErrorMessage(error)}`,
          { cause: error, phase: 'protocol' },
        ))
        socket.terminate()
        return
      }

      frames.push(frame)
      const eventType = stringProperty(frame, 'type')
      if (!eventType || !TERMINAL_EVENT_TYPES.has(eventType))
        return

      terminalEvent = frame
      clearTimeout(responseTimer)
      closeTimer = setTimeout(() => socket.terminate(), CLOSE_HANDSHAKE_TIMEOUT_MS)
      socket.close(1000, 'live probe complete')
    }

    socket.on('close', onClose)
    socket.on('error', onError)
    socket.on('message', onMessage)

    const earlyError = handoff?.()
    if (earlyError) {
      onError(earlyError)
      return
    }

    try {
      socket.send(JSON.stringify(createEvent))
    }
    catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function readHandshakeError(response: Response): Promise<LiveResponsesWebSocketErrorDetails> {
  const bodyText = await response.text().catch(() => '')
  return parseErrorDetails(bodyText, response.statusText)
}

async function normalizeSSERequestError(
  error: unknown,
  timedOut: boolean,
  timeoutMs: number,
): Promise<DirectCopilotResponsesSSEProbeError> {
  if (timedOut) {
    return new DirectCopilotResponsesSSEProbeError(
      `Copilot Responses SSE probe timed out after ${timeoutMs}ms`,
      { cause: error, phase: 'timeout' },
    )
  }

  if (error instanceof HTTPError) {
    const details = parseErrorDetails(await error.text(), error.response.statusText)
    return new DirectCopilotResponsesSSEProbeError(
      details.message ?? `Copilot Responses SSE request failed with HTTP ${error.response.status}`,
      {
        cause: error,
        details,
        httpStatus: error.response.status,
        phase: 'request',
      },
    )
  }

  if (error instanceof JSONResponseError) {
    const details = errorDetailsFromValue(error.payload) ?? { message: error.message }
    return new DirectCopilotResponsesSSEProbeError(
      details.message ?? error.message,
      {
        cause: error,
        details,
        httpStatus: error.status,
        phase: 'request',
      },
    )
  }

  if (error instanceof UpstreamTimeoutError) {
    return new DirectCopilotResponsesSSEProbeError(
      error.message,
      {
        cause: error,
        details: {
          code: 'upstream_timeout',
          message: error.message,
          status: error.status,
          type: 'timeout_error',
        },
        httpStatus: error.status,
        phase: 'timeout',
      },
    )
  }

  return new DirectCopilotResponsesSSEProbeError(
    `Copilot Responses SSE request failed: ${safeErrorMessage(error)}`,
    { cause: error, phase: 'request' },
  )
}

function parseErrorDetails(
  bodyText: string,
  statusText: string,
): LiveResponsesWebSocketErrorDetails {
  try {
    const body = JSON.parse(bodyText) as unknown
    const details = errorDetailsFromValue(body)
    if (details)
      return details
  }
  catch {
    // Preserve only a bounded, credential-free server message below.
  }

  return {
    message: truncate(bodyText || statusText, 512) || undefined,
  }
}

function errorDetailsFromValue(value: unknown): LiveResponsesWebSocketErrorDetails | undefined {
  return isRecord(value) ? extractResponsesWebSocketError(value) : undefined
}

function parseSSEFrame(message: ServerSentEventMessage): Record<string, unknown> | undefined {
  if (typeof message.data !== 'string' || message.data.length === 0 || message.data === '[DONE]')
    return undefined

  let frame: Record<string, unknown>
  try {
    const parsed = JSON.parse(message.data) as unknown
    if (!isRecord(parsed))
      throw new TypeError('Expected a JSON object')
    frame = parsed
  }
  catch (error) {
    throw new DirectCopilotResponsesSSEProbeError(
      `Copilot Responses SSE returned an invalid JSON event: ${safeErrorMessage(error)}`,
      { cause: error, phase: 'protocol' },
    )
  }

  const frameType = stringProperty(frame, 'type')
  if (message.event && frameType && message.event !== frameType) {
    throw new DirectCopilotResponsesSSEProbeError(
      `Copilot Responses SSE event mismatch: event=${message.event} data.type=${frameType}`,
      { phase: 'protocol' },
    )
  }

  if (!frameType && message.event)
    return { ...frame, type: message.event }

  return frame
}

function parseFrame(rawData: RawData): Record<string, unknown> {
  const text = Array.isArray(rawData)
    ? Buffer.concat(rawData).toString('utf8')
    : rawData instanceof ArrayBuffer
      ? Buffer.from(rawData).toString('utf8')
      : rawData.toString()
  const parsed = JSON.parse(text) as unknown
  if (!isRecord(parsed))
    throw new TypeError('Expected a JSON object')
  return parsed
}

function collectOutputItems(
  frames: Array<Record<string, unknown>>,
  response: LiveResponsesWebSocketResponse | undefined,
): Array<Record<string, unknown>> {
  if (Array.isArray(response?.output))
    return response.output.filter(isRecord)

  return frames
    .filter(frame => frame.type === 'response.output_item.done')
    .map(frame => recordProperty(frame, 'item'))
    .filter((item): item is Record<string, unknown> => item !== undefined)
}

function extractOutputText(outputItems: Array<Record<string, unknown>>): string {
  const parts: Array<string> = []
  for (const item of outputItems) {
    const content = item.content
    if (!Array.isArray(content))
      continue
    for (const part of content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string')
        parts.push(part.text)
    }
  }
  return parts.join('')
}

function isToolEventType(eventType: string): boolean {
  return [
    'code_interpreter',
    'computer',
    'custom_tool',
    'file_search',
    'function_call',
    'image_generation',
    'mcp_',
    'shell',
    'tool_',
    'web_search',
  ].some(marker => eventType.includes(marker))
}

function normalizeErrorDetails(value: unknown): LiveResponsesWebSocketErrorDetails | undefined {
  return isRecord(value) ? extractResponsesWebSocketError(value) : undefined
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : DEFAULT_PROBE_TIMEOUT_MS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ServerSentEventMessage> {
  return typeof (value as { [Symbol.asyncIterator]?: unknown } | null)?.[Symbol.asyncIterator] === 'function'
}

function recordProperty(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const property = value[key]
  return isRecord(property) ? property : undefined
}

function stringProperty(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const property = value[key]
  return typeof property === 'string' ? property : undefined
}

function nullableStringProperty(
  value: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const property = value[key]
  return property === null || typeof property === 'string' ? property : undefined
}

function numberProperty(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  const property = value[key]
  return typeof property === 'number' && Number.isFinite(property) ? property : undefined
}

function uniqueStrings(values: Array<string>): Array<string> {
  return [...new Set(values)]
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
}
