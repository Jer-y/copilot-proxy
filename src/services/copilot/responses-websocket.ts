import type { IncomingMessage } from 'node:http'

import { Buffer } from 'node:buffer'
import consola from 'consola'
import { HttpsProxyAgent } from 'https-proxy-agent'
import WebSocket from 'ws'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError, UpstreamTimeoutError } from '~/lib/error'
import { state } from '~/lib/state'
import {
  fetchCopilot,
  getCopilotWebSocketHandshakeTimeoutMs,
  resolveRuntimeProxyForUrl,
} from '~/lib/upstream-fetch'
import { fetchAuthenticatedCopilot } from './authenticated-fetch'

const MAX_HANDSHAKE_ERROR_BODY_BYTES = 64 * 1024
export const MAX_RESPONSES_WEBSOCKET_FRAME_BYTES = 16 * 1024 * 1024

interface OpenWebSocketSuccess {
  handoff?: () => Error | undefined
  headers: Headers
  ok: true
  socket: WebSocket
}

interface OpenWebSocketFailure {
  ok: false
  response: Response
}

type OpenWebSocketResult = OpenWebSocketFailure | OpenWebSocketSuccess

export interface ConnectCopilotResponsesWebSocketOptions {
  hasVision: boolean
  initiator: 'agent' | 'user'
  model: string
  signal?: AbortSignal
}

export interface CopilotResponsesWebSocketConnection {
  handoff?: () => Error | undefined
  releaseInitialTurn: () => Promise<void>
  socket: WebSocket
}

export interface ConnectCopilotResponsesWebSocketDeps {
  fetchAuthenticated?: typeof fetchAuthenticatedCopilot
  openAttempt?: (
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<OpenWebSocketResult>
}

export async function connectAuthenticatedCopilotResponsesWebSocket(
  options: ConnectCopilotResponsesWebSocketOptions,
  deps: ConnectCopilotResponsesWebSocketDeps = {},
): Promise<CopilotResponsesWebSocketConnection> {
  if (!state.copilotToken)
    throw new Error('Copilot token not found')

  // Bun's native WebSocket client does not expose the non-101 handshake
  // response status, headers, or body. Perform a same-scope authenticated
  // preflight before the real handshake so an invalid short-lived token still
  // goes through the normal single-flight refresh/circuit path. A later
  // opaque handshake failure is then treated conservatively as transport or
  // endpoint rejection and is never refreshed blindly.
  if (typeof Bun !== 'undefined' && deps.openAttempt === undefined)
    await preflightCopilotResponsesWebSocketAuth(options)

  const url = `${copilotBaseUrl(state).replace(/^http/, 'ws')}/responses`
  const openAttempt = deps.openAttempt ?? openCopilotResponsesWebSocketAttempt
  const fetchAuthenticated = deps.fetchAuthenticated ?? fetchAuthenticatedCopilot
  let connectedSocket: WebSocket | undefined
  let handoff: (() => Error | undefined) | undefined

  const permitResponse = await fetchAuthenticated({
    endpoint: 'ws:/responses',
    model: options.model,
    signal: options.signal,
    request: async () => {
      const result = await openAttempt(url, {
        ...copilotHeaders(state, options.hasVision),
        'X-Initiator': options.initiator,
      }, options.signal)

      if (!result.ok)
        return normalizeRejectedWebSocketHandshakeResponse(result.response)

      connectedSocket = result.socket
      handoff = result.handoff
      return new Response(createPermitHoldStream(), {
        headers: result.headers,
        status: 200,
        statusText: 'WebSocket Switching Protocols',
      })
    },
  })

  if (!permitResponse.ok || !connectedSocket) {
    const body = await permitResponse.text().catch(() => permitResponse.statusText)
    const response = new Response(body, {
      headers: permitResponse.headers,
      status: permitResponse.status,
      statusText: permitResponse.statusText,
    })
    throw new HTTPError('Failed to connect Copilot Responses WebSocket', response)
  }

  consola.debug('Copilot Responses WebSocket handshake completed:', {
    endpoint: '/responses',
    githubRequestId: permitResponse.headers.get('x-github-request-id') ?? undefined,
    model: options.model,
    status: 101,
  })

  let released = false
  return {
    handoff,
    socket: connectedSocket,
    releaseInitialTurn: async () => {
      if (released)
        return
      released = true
      await permitResponse.body?.cancel('Responses WebSocket turn completed').catch(() => {})
    },
  }
}

async function preflightCopilotResponsesWebSocketAuth(
  options: ConnectCopilotResponsesWebSocketOptions,
): Promise<void> {
  const response = await fetchAuthenticatedCopilot({
    endpoint: 'ws:/responses',
    model: options.model,
    signal: options.signal,
    request: () => fetchCopilot(`${copilotBaseUrl(state)}/models`, {
      headers: copilotHeaders(state),
      signal: options.signal,
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText)
    throw new HTTPError('Failed to authenticate Copilot Responses WebSocket', new Response(body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }))
  }

  await response.body?.cancel('Responses WebSocket authentication preflight completed').catch(() => {})
}

export async function openCopilotResponsesWebSocketAttempt(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<OpenWebSocketResult> {
  const proxyUrl = resolveRuntimeProxyForUrl(url)
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined
  const handshakeTimeout = getCopilotWebSocketHandshakeTimeoutMs()

  return await new Promise<OpenWebSocketResult>((resolve, reject) => {
    let settled = false
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    let upgradeHeaders = new Headers()
    const supportsHandshakeResponseEvents = typeof Bun === 'undefined'
    let socket: WebSocket
    try {
      socket = new WebSocket(url, [], {
        ...(proxyAgent && { agent: proxyAgent }),
        headers,
        maxPayload: MAX_RESPONSES_WEBSOCKET_FRAME_BYTES,
        perMessageDeflate: false,
      })
    }
    catch (error) {
      proxyAgent?.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    // Node's ws client emits an asynchronous error after terminate() while a
    // handshake is still CONNECTING. Keep this guard until either the socket
    // closes or the established connection is handed to the session, so
    // abort/non-101 cleanup can never become an unhandled EventEmitter error.
    const safetyErrorGuard = () => {}
    socket.on('error', safetyErrorGuard)
    socket.once('close', () => socket.off('error', safetyErrorGuard))

    function cleanupConnectingListeners() {
      if (handshakeTimer !== undefined) {
        clearTimeout(handshakeTimer)
        handshakeTimer = undefined
      }
      socket.off('error', onError)
      socket.off('open', onOpen)
      if (supportsHandshakeResponseEvents) {
        socket.off('upgrade', onUpgrade)
        socket.off('unexpected-response', onUnexpectedResponse)
      }
      signal?.removeEventListener('abort', onAbort)
    }
    function settle(result: OpenWebSocketResult) {
      if (settled)
        return
      settled = true
      cleanupConnectingListeners()
      resolve(result)
    }
    function fail(error: unknown) {
      if (settled)
        return
      settled = true
      cleanupConnectingListeners()
      proxyAgent?.destroy()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    function terminateConnectingSocket() {
      try {
        socket.terminate()
      }
      catch {
        // Some WebSocket runtimes can already have torn down the native
        // socket before their JavaScript close/error event is delivered.
      }
    }
    function onAbort() {
      const error = new Error('Copilot Responses WebSocket handshake was cancelled')
      error.name = 'AbortError'
      fail(error)
      terminateConnectingSocket()
    }
    function onHandshakeTimeout() {
      fail(new UpstreamTimeoutError(
        `Upstream WebSocket handshake timed out after ${handshakeTimeout}ms: ${url}`,
        handshakeTimeout,
        url,
      ))
      terminateConnectingSocket()
    }
    function onError(error: Error) {
      fail(error)
    }
    function onOpen() {
      let postOpenError: Error | undefined
      const guardError = (error: Error) => {
        postOpenError ??= error
      }
      socket.on('error', guardError)
      socket.once('close', () => proxyAgent?.destroy())
      settle({
        handoff: () => {
          socket.off('error', guardError)
          socket.off('error', safetyErrorGuard)
          return postOpenError
        },
        headers: upgradeHeaders,
        ok: true,
        socket,
      })
    }
    function onUpgrade(response: IncomingMessage) {
      upgradeHeaders = incomingHeadersToHeaders(response)
    }
    function onUnexpectedResponse(_request: unknown, response: IncomingMessage) {
      void readUnexpectedResponse(response).then((failureResponse) => {
        proxyAgent?.destroy()
        settle({ ok: false, response: failureResponse })
        terminateConnectingSocket()
      }, (error: unknown) => {
        fail(error)
        terminateConnectingSocket()
      })
    }

    if (supportsHandshakeResponseEvents) {
      socket.once('upgrade', onUpgrade)
      socket.once('unexpected-response', onUnexpectedResponse)
    }
    socket.once('open', onOpen)
    socket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
    else if (handshakeTimeout > 0) {
      // Bun 1.3.x ignores ws' handshakeTimeout option, while Node's ws
      // implementation reports its own timeout as a generic Error. Use one
      // explicit runtime-independent timer so both paths expose the same 504
      // UpstreamTimeoutError and have one authoritative cleanup path.
      handshakeTimer = setTimeout(onHandshakeTimeout, handshakeTimeout)
      handshakeTimer.unref?.()
    }
  })
}

function createPermitHoldStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    // The authenticated wrapper owns the stream and releases its concurrency
    // lease when the caller cancels it at the terminal WebSocket event.
  })
}

async function readUnexpectedResponse(response: IncomingMessage): Promise<Response> {
  const chunks: Buffer[] = []
  let totalBytes = 0

  for await (const rawChunk of response) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const remaining = MAX_HANDSHAKE_ERROR_BODY_BYTES - totalBytes
    if (remaining <= 0)
      break
    chunks.push(chunk.subarray(0, remaining))
    totalBytes += Math.min(chunk.length, remaining)
  }

  return new Response(Buffer.concat(chunks).toString('utf8'), {
    headers: incomingHeadersToHeaders(response),
    status: normalizeRejectedWebSocketHandshakeStatus(response.statusCode),
    statusText: isHttpFailureStatus(response.statusCode)
      ? response.statusMessage
      : 'Bad Gateway',
  })
}

function normalizeRejectedWebSocketHandshakeResponse(response: Response): Response {
  if (isHttpFailureStatus(response.status))
    return response

  // A successful WebSocket opening handshake is always 101. The Fetch
  // Response constructor cannot represent 101, so any Response reaching this
  // failure branch with a 2xx/3xx (or opaque status 0) is an invalid upstream
  // handshake, not an HTTP success. Moving its body stream preserves the
  // original diagnostic payload and headers while also safely handling
  // null-body statuses such as 204, 205, and 304.
  return new Response(response.body, {
    headers: response.headers,
    status: 502,
    statusText: 'Bad Gateway',
  })
}

function normalizeRejectedWebSocketHandshakeStatus(status: number | undefined): number {
  return isHttpFailureStatus(status) ? status : 502
}

function isHttpFailureStatus(status: number | undefined): status is number {
  return status !== undefined && status >= 400 && status <= 599
}

function incomingHeadersToHeaders(response: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value)
        headers.append(name, item)
    }
    else if (value !== undefined) {
      headers.set(name, value)
    }
  }
  return headers
}
