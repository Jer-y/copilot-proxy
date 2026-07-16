import type { Message, Peer, WSOptions } from 'crossws'
import type WebSocket from 'ws'
import type { CopilotRequestPermit } from '~/services/copilot/authenticated-fetch'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import type { CopilotResponsesWebSocketConnection } from '~/services/copilot/responses-websocket'

import { Buffer } from 'node:buffer'
import consola from 'consola'

import { setApprovalRequestModel, withApprovalRequestContext } from '~/lib/approval'
import { HTTPError, JSONResponseError, UpstreamTimeoutError } from '~/lib/error'
import {
  OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE,
  responsesHasExternalImageUrls,
} from '~/lib/openai-compat'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { modelSupportsResponsesWebSocket } from '~/lib/routing-policy'
import { isRequestHostAllowed, isRequestOriginAllowed } from '~/lib/security'
import { state } from '~/lib/state'
import { getCopilotWebSocketInactivityTimeoutMs } from '~/lib/upstream-fetch'
import {
  acquireCopilotRequestPermit,
} from '~/services/copilot/authenticated-fetch'
import { analyzeResponsesPayloadForCopilot } from '~/services/copilot/create-responses'
import {
  connectAuthenticatedCopilotResponsesWebSocket,
  MAX_RESPONSES_WEBSOCKET_FRAME_BYTES,
} from '~/services/copilot/responses-websocket'
import { normalizeAnthropicModelName } from '../messages/model-normalization'

const RESPONSES_WEBSOCKET_PATHS = new Set(['/responses', '/v1/responses'])
const RESPONSES_WEBSOCKET_CONNECTION_LIMIT = 64
const RESPONSES_WEBSOCKET_UPGRADE_RESERVATION_MS = 10_000
const RESPONSES_WEBSOCKET_QUEUE_LIMIT = 8
const RESPONSES_WEBSOCKET_QUEUE_BYTES_LIMIT = 32 * 1024 * 1024
const RESPONSES_WEBSOCKET_GLOBAL_BUFFER_BYTES_LIMIT = 64 * 1024 * 1024
const RESPONSES_WEBSOCKET_MAX_DURATION_MS = 60 * 60 * 1000
const RESPONSES_WEBSOCKET_HIGH_WATERMARK_BYTES = 1024 * 1024
const RESPONSES_WEBSOCKET_LOW_WATERMARK_BYTES = 256 * 1024
const RESPONSES_WEBSOCKET_CLOSE_REASON = 'Copilot proxy shutting down'
const TERMINAL_RESPONSE_EVENTS = new Set([
  'error',
  'response.completed',
  'response.failed',
  'response.incomplete',
])

type TurnOutcome = 'cancel' | 'failure' | 'success'
type QueueRejectionKind = 'connection' | 'global'

interface ResponsesWebSocketCreateEvent extends Record<string, unknown> {
  background?: boolean | null
  generate?: boolean
  input?: ResponsesPayload['input']
  model?: string
  stream?: boolean | null
  type: 'response.create'
}

interface ResponsesWebSocketContext extends Record<string, unknown> {
  origin?: string
  path: string
  releaseConnectionReservation?: () => void
  session?: ResponsesWebSocketSession
  userAgent?: string
}

interface ActiveTurn {
  abortController: AbortController
  clientPreviousResponseId?: string
  firstEventSeen: boolean
  lastSequenceNumber?: number
  model: string
  publicResponseId?: string
  sent: boolean
  settle: (outcome: TurnOutcome) => Promise<void> | void
}

export interface ResponsesWebSocketSessionDeps {
  acquirePermit?: typeof acquireCopilotRequestPermit
  canPauseUpstream?: boolean
  connect?: typeof connectAuthenticatedCopilotResponsesWebSocket
  enforceApproval?: typeof enforceManualApproval
  enforceRateLimit?: typeof enforceRateLimit
  maxDurationMs?: number
  maxQueuedBytes?: number
  maxQueuedTurns?: number
  requestBufferBudget?: ResponsesWebSocketRequestBufferBudget
}

export class ResponsesWebSocketRequestBufferBudget {
  readonly maxBytes: number
  private reservedBytes = 0

  constructor(maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new TypeError('Responses WebSocket request-buffer budget must be a positive safe integer')
    this.maxBytes = maxBytes
  }

  get usedBytes(): number {
    return this.reservedBytes
  }

  release(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.reservedBytes)
      throw new RangeError('Invalid Responses WebSocket request-buffer release')
    this.reservedBytes -= bytes
  }

  tryReserve(bytes: number): boolean {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      return false
    if (this.reservedBytes + bytes > this.maxBytes)
      return false
    this.reservedBytes += bytes
    return true
  }
}

const sessions = new Map<string, ResponsesWebSocketSession>()
const requestBufferBudget = new ResponsesWebSocketRequestBufferBudget(
  RESPONSES_WEBSOCKET_GLOBAL_BUFFER_BYTES_LIMIT,
)
let acceptingConnections = true
let pendingConnections = 0

export const responsesWebSocketOptions: WSOptions = {
  upgrade(request) {
    if (!acceptingConnections) {
      return Response.json({
        error: {
          code: 'websocket_server_shutting_down',
          message: 'Responses WebSocket server is shutting down.',
          type: 'api_error',
        },
      }, { status: 503 })
    }

    const url = new URL(request.url)
    if (request.method !== 'GET' || !RESPONSES_WEBSOCKET_PATHS.has(url.pathname))
      return new Response('Not Found', { status: 404 })

    if (!isRequestHostAllowed(request)) {
      return Response.json({
        error: {
          code: 'host_not_allowed',
          message: 'Request Host is not allowed',
          type: 'invalid_request_error',
        },
      }, { status: 403 })
    }

    if (!isRequestOriginAllowed(request, url.pathname)) {
      return Response.json({
        error: {
          code: 'origin_not_allowed',
          message: 'Request Origin is not allowed',
          type: 'invalid_request_error',
        },
      }, { status: 403 })
    }

    if (sessions.size + pendingConnections >= RESPONSES_WEBSOCKET_CONNECTION_LIMIT) {
      return Response.json({
        error: {
          code: 'websocket_connection_limit_reached',
          message: 'Responses WebSocket connection limit reached.',
          type: 'rate_limit_error',
        },
      }, { status: 429 })
    }

    const releaseConnectionReservation = reservePendingConnection()
    return {
      context: {
        origin: request.headers.get('origin') ?? undefined,
        path: url.pathname,
        releaseConnectionReservation,
        userAgent: request.headers.get('user-agent') ?? undefined,
      } satisfies ResponsesWebSocketContext,
    }
  },
  open(peer) {
    const context = peer.context as ResponsesWebSocketContext
    context.releaseConnectionReservation?.()
    context.releaseConnectionReservation = undefined
    if (!acceptingConnections) {
      peer.close(1012, RESPONSES_WEBSOCKET_CLOSE_REASON)
      return
    }
    const session = new ResponsesWebSocketSession(peer)
    context.session = session
    sessions.set(peer.id, session)
    consola.debug('Responses WebSocket downstream upgrade completed:', {
      connectionId: peer.id,
      path: context.path,
      status: 101,
    })
  },
  message(peer, message) {
    const session = getSession(peer)
    if (!session)
      return
    session.receive(message)
  },
  close(peer, details) {
    const session = getSession(peer)
    sessions.delete(peer.id)
    session?.handleDownstreamClose(details.code, details.reason)
  },
  error(peer, error) {
    consola.warn('Responses WebSocket downstream error:', {
      connectionId: peer.id,
      message: error.message,
    })
    getSession(peer)?.handleDownstreamError(error)
  },
  options: {
    bun: {
      idleTimeout: 30,
    },
    node: {
      idleTimeout: 30,
      serverOptions: {
        maxPayload: MAX_RESPONSES_WEBSOCKET_FRAME_BYTES,
        perMessageDeflate: false,
      },
    },
  },
}

export function prepareResponsesWebSocketServer(): void {
  if (sessions.size > 0)
    throw new Error('Cannot prepare Responses WebSocket server while connections remain active')
  if (pendingConnections > 0)
    throw new Error('Cannot prepare Responses WebSocket server while upgrades remain pending')
  acceptingConnections = true
}

export async function closeResponsesWebSocketsGracefully(): Promise<void> {
  acceptingConnections = false
  const activeSessions = [...sessions.values()]
  await Promise.all(activeSessions.map(session => session.closeGracefully()))
}

export function forceCloseResponsesWebSockets(): void {
  acceptingConnections = false
  for (const session of sessions.values())
    session.forceClose()
}

export class ResponsesWebSocketSession {
  private activeTurn?: ActiveTurn
  private closed = false
  private readonly closedPromise: Promise<void>
  private closingUpstream?: WebSocket
  private connectPromise?: Promise<CopilotResponsesWebSocketConnection>
  private readonly deps: Required<ResponsesWebSocketSessionDeps>
  private draining = false
  private durationTimer?: ReturnType<typeof setTimeout>
  private lastModel?: string
  private lastPublicResponseId?: string
  private lastTerminalUpstreamResponseId?: string
  private lastUpstreamEventWasTerminal = false
  private readonly peer: Peer
  private pausedUpstream?: WebSocket
  private pendingTurnAbortController?: AbortController
  private processingSetup = false
  private readonly queue: string[] = []
  private queueRejectionPending?: QueueRejectionKind
  private queuedBytes = 0
  private resolveClosed!: () => void
  private resolveTransportClosed!: () => void
  private releaseSetupReservation?: () => void
  private transportTerminated = false
  private readonly transportClosedPromise: Promise<void>
  private turnInactivityTimer?: ReturnType<typeof setTimeout>
  private upstream?: WebSocket
  private waitingForDownstreamDrain = false

  constructor(peer: Peer, deps: ResponsesWebSocketSessionDeps = {}) {
    this.peer = peer
    this.deps = {
      acquirePermit: deps.acquirePermit ?? acquireCopilotRequestPermit,
      canPauseUpstream: deps.canPauseUpstream ?? typeof Bun === 'undefined',
      connect: deps.connect ?? connectAuthenticatedCopilotResponsesWebSocket,
      enforceApproval: deps.enforceApproval ?? enforceManualApproval,
      enforceRateLimit: deps.enforceRateLimit ?? enforceRateLimit,
      maxDurationMs: deps.maxDurationMs ?? RESPONSES_WEBSOCKET_MAX_DURATION_MS,
      maxQueuedBytes: deps.maxQueuedBytes ?? RESPONSES_WEBSOCKET_QUEUE_BYTES_LIMIT,
      maxQueuedTurns: deps.maxQueuedTurns ?? RESPONSES_WEBSOCKET_QUEUE_LIMIT,
      requestBufferBudget: deps.requestBufferBudget ?? requestBufferBudget,
    }
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve
    })
    this.transportClosedPromise = new Promise((resolve) => {
      this.resolveTransportClosed = resolve
    })
    this.durationTimer = setTimeout(() => {
      this.sendConnectionLimitError()
      this.closeBoth(1000, 'WebSocket connection duration limit reached')
    }, this.deps.maxDurationMs)
    this.durationTimer.unref?.()
  }

  receive(message: Message): void {
    if (this.closed)
      return

    // Graceful shutdown drains only the already active/setup turn. New frames
    // are ignored and the eventual close communicates that they were not
    // accepted without interleaving an uncorrelated error into the active turn.
    if (this.draining)
      return

    // Once the bounded queue has rejected a turn, the connection is destined
    // to close when that rejection reaches its FIFO position. Ignore later
    // frames so they cannot introduce another uncorrelated error ahead of it.
    if (this.queueRejectionPending)
      return

    if (typeof message.rawData !== 'string') {
      this.sendLocalError(400, 'invalid_websocket_frame', 'Responses WebSocket accepts text JSON frames only.')
      this.closeBoth(1003, 'Binary frames are not supported')
      return
    }

    const size = Buffer.byteLength(message.rawData)
    if (size > MAX_RESPONSES_WEBSOCKET_FRAME_BYTES) {
      this.sendLocalError(413, 'websocket_frame_too_large', `Responses WebSocket frame exceeds ${MAX_RESPONSES_WEBSOCKET_FRAME_BYTES} bytes.`)
      this.closeBoth(1009, 'WebSocket frame too large')
      return
    }

    if (
      this.queue.length >= this.deps.maxQueuedTurns
      || this.queuedBytes + size > this.deps.maxQueuedBytes
    ) {
      this.queueRejectionPending = 'connection'
      this.processQueue()
      return
    }

    if (!this.deps.requestBufferBudget.tryReserve(size)) {
      this.queueRejectionPending = 'global'
      this.processQueue()
      return
    }

    this.queue.push(message.rawData)
    this.queuedBytes += size
    this.processQueue()
  }

  handleDownstreamClose(code?: number, reason?: string): void {
    consola.debug('Responses WebSocket client disconnected:', {
      code,
      connectionId: this.peer.id,
      reason,
    })
    this.resolveTransportClosed()
    this.finish('cancel')
    this.closeUpstream(code, reason)
  }

  handleDownstreamError(_error: unknown): void {
    this.finish('cancel')
    this.closeUpstream(1011, 'Downstream WebSocket error')
  }

  async closeGracefully(): Promise<void> {
    if (this.closed) {
      await this.waitForDownstreamTransportClose()
      if (sessions.get(this.peer.id) === this)
        sessions.delete(this.peer.id)
      return
    }
    this.draining = true
    this.discardQueuedTurns()
    this.queueRejectionPending = undefined
    this.pendingTurnAbortController?.abort(RESPONSES_WEBSOCKET_CLOSE_REASON)
    if (!this.activeTurn && !this.processingSetup)
      this.closeBoth(1001, RESPONSES_WEBSOCKET_CLOSE_REASON)
    await this.closedPromise
    await this.waitForDownstreamTransportClose()
    if (sessions.get(this.peer.id) === this)
      sessions.delete(this.peer.id)
  }

  forceClose(): void {
    if (this.transportTerminated)
      return
    if (!this.closed)
      this.finish('cancel')
    this.transportTerminated = true
    this.clearDurationTimer()
    this.upstream?.terminate()
    this.closingUpstream?.terminate()
    this.closingUpstream = undefined
    this.peer.terminate()
    this.resolveClosed()
    this.resolveTransportClosed()
    if (sessions.get(this.peer.id) === this)
      sessions.delete(this.peer.id)
  }

  private processQueue(): void {
    if (this.closed || this.activeTurn || this.processingSetup || this.waitingForDownstreamDrain)
      return
    const raw = this.queue.shift()
    if (raw === undefined) {
      if (this.draining) {
        this.closeBoth(1001, RESPONSES_WEBSOCKET_CLOSE_REASON)
      }
      else if (this.queueRejectionPending) {
        const rejection = this.queueRejectionPending
        this.queueRejectionPending = undefined
        const isGlobal = rejection === 'global'
        const reason = isGlobal
          ? 'Responses WebSocket global request-buffer budget is full'
          : 'Responses WebSocket request queue is full'
        this.sendLocalError(429, isGlobal ? 'websocket_global_queue_full' : 'websocket_queue_full', `${reason}.`)
        this.closeBoth(1013, reason)
      }
      return
    }
    const rawBytes = Buffer.byteLength(raw)
    this.queuedBytes -= rawBytes

    let reservationReleased = false
    const releaseSetupReservation = () => {
      if (reservationReleased)
        return
      reservationReleased = true
      this.deps.requestBufferBudget.release(rawBytes)
      if (this.releaseSetupReservation === releaseSetupReservation)
        this.releaseSetupReservation = undefined
    }
    this.releaseSetupReservation = releaseSetupReservation

    this.processingSetup = true
    void this.startTurn(raw).catch(async (error) => {
      if (!this.closed && !this.draining)
        await this.sendErrorFromUnknown(error)
    }).finally(() => {
      releaseSetupReservation()
      this.processingSetup = false
      if (!this.activeTurn)
        this.processQueue()
    })
  }

  private async startTurn(raw: string): Promise<void> {
    const event = this.parseCreateEvent(raw)
    const requestedModel = event.model ?? this.lastModel
    if (!requestedModel) {
      throw new JSONResponseError('model is required for the first Responses WebSocket request.', 400, {
        error: {
          code: 'model_required',
          message: 'model is required for the first Responses WebSocket request.',
          param: 'model',
          type: 'invalid_request_error',
        },
      })
    }

    const effectiveModel = normalizeAnthropicModelName(requestedModel)
    const liveModel = state.models?.data.find(model => model.id === effectiveModel)
    if (!modelSupportsResponsesWebSocket(liveModel)) {
      throw new JSONResponseError(`Model ${requestedModel} does not advertise Responses WebSocket support on the current Copilot upstream.`, 400, {
        error: {
          code: 'unsupported_websocket_model',
          message: `Model ${requestedModel} does not advertise Responses WebSocket support on the current Copilot upstream.`,
          param: 'model',
          type: 'invalid_request_error',
        },
      })
    }

    const clientPreviousResponseId = typeof event.previous_response_id === 'string'
      ? event.previous_response_id
      : undefined
    const upstreamEvent = this.prepareUpstreamEvent(event, effectiveModel)
    if (responsesHasExternalImageUrls(upstreamEvent)) {
      throw new JSONResponseError(OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE, 400, {
        error: {
          code: 'external_image_url_unsupported',
          message: OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE,
          param: 'input',
          type: 'invalid_request_error',
        },
      })
    }

    const abortController = new AbortController()
    this.pendingTurnAbortController = abortController
    const analysis = analyzeResponsesPayloadForCopilot({ input: upstreamEvent.input })
    let settle: ActiveTurn['settle']

    try {
      const context = this.peer.context as ResponsesWebSocketContext
      await withApprovalRequestContext({
        method: 'WS response.create',
        path: context.path,
        clientAddress: this.peer.remoteAddress,
        origin: context.origin,
        userAgent: context.userAgent,
        model: requestedModel,
      }, async () => {
        setApprovalRequestModel(requestedModel)
        await this.deps.enforceRateLimit(state, { signal: abortController.signal })
        await this.deps.enforceApproval(state, { signal: abortController.signal })
      })

      if (this.draining)
        throw createSessionAbortError('Responses WebSocket server is shutting down')
      if (this.closed || abortController.signal.aborted) {
        throw createSessionAbortError('Downstream Responses WebSocket closed before the upstream turn started')
      }

      if (!this.upstream) {
        const connection = await this.ensureUpstream({
          hasVision: analysis.hasVision,
          initiator: analysis.initiator,
          model: effectiveModel,
          signal: abortController.signal,
        })
        settle = async () => await connection.releaseInitialTurn()
      }
      else {
        const permit = await this.deps.acquirePermit({
          endpoint: 'ws:/responses',
          model: effectiveModel,
          signal: abortController.signal,
        })
        settle = outcome => settlePermit(permit, outcome)
      }
    }
    finally {
      this.pendingTurnAbortController = undefined
    }

    if (this.closed || this.draining || abortController.signal.aborted) {
      await settle('cancel')
      throw createSessionAbortError(
        this.draining
          ? 'Responses WebSocket server is shutting down'
          : 'Downstream Responses WebSocket closed before the upstream turn started',
      )
    }

    const turn: ActiveTurn = {
      abortController,
      clientPreviousResponseId,
      firstEventSeen: false,
      model: effectiveModel,
      sent: false,
      settle,
    }
    this.activeTurn = turn
    this.lastUpstreamEventWasTerminal = false

    try {
      await sendWebSocketText(this.upstream!, JSON.stringify(upstreamEvent))
      turn.sent = true
      this.lastModel = effectiveModel
      this.armTurnInactivityTimeout()
      const previousResponseId = typeof upstreamEvent.previous_response_id === 'string'
        ? upstreamEvent.previous_response_id
        : undefined
      consola.debug('Forwarded Responses WebSocket request:', {
        connectionId: this.peer.id,
        hasPreviousResponseId: previousResponseId !== undefined,
        model: effectiveModel,
        previousResponseIdMapped: clientPreviousResponseId !== undefined
          && clientPreviousResponseId !== previousResponseId,
        previousResponseIdMatchesLast: clientPreviousResponseId !== undefined
          && clientPreviousResponseId === this.lastPublicResponseId,
        previousResponseIdMatchesLastUpstream: previousResponseId !== undefined
          && previousResponseId === this.lastTerminalUpstreamResponseId,
        queued: this.queue.length,
        storeFalse: upstreamEvent.store === false,
      })
    }
    catch (error) {
      await this.settleActiveTurn('failure')
      throw error
    }
  }

  private parseCreateEvent(raw: string): ResponsesWebSocketCreateEvent {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      throw new JSONResponseError('WebSocket message must be valid JSON.', 400, {
        error: {
          code: 'invalid_json',
          message: 'WebSocket message must be valid JSON.',
          type: 'invalid_request_error',
        },
      })
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new JSONResponseError('WebSocket message must be a JSON object.', 400, {
        error: {
          code: 'invalid_websocket_event',
          message: 'WebSocket message must be a JSON object.',
          type: 'invalid_request_error',
        },
      })
    }

    const event = parsed as Record<string, unknown>
    if (event.type !== 'response.create') {
      throw new JSONResponseError('Unsupported WebSocket event type. Expected response.create.', 400, {
        error: {
          code: 'unsupported_websocket_event',
          message: 'Unsupported WebSocket event type. Expected response.create.',
          param: 'type',
          type: 'invalid_request_error',
        },
      })
    }
    if (event.model !== undefined && (typeof event.model !== 'string' || event.model.trim() === '')) {
      throw new JSONResponseError('model must be a non-empty string.', 400, {
        error: {
          code: 'invalid_model',
          message: 'model must be a non-empty string.',
          param: 'model',
          type: 'invalid_request_error',
        },
      })
    }
    if (
      Object.hasOwn(event, 'background')
      && event.background !== null
      && typeof event.background !== 'boolean'
    ) {
      throw new JSONResponseError('background must be a boolean or null.', 400, {
        error: {
          code: 'invalid_websocket_parameter',
          message: 'background must be a boolean or null.',
          param: 'background',
          type: 'invalid_request_error',
        },
      })
    }
    if (event.background === true) {
      throw new JSONResponseError('background mode is not supported over WebSocket.', 400, {
        error: {
          code: 'invalid_websocket_parameter',
          message: 'background mode is not supported over WebSocket.',
          param: 'background',
          type: 'invalid_request_error',
        },
      })
    }
    if (
      Object.hasOwn(event, 'stream')
      && event.stream !== null
      && typeof event.stream !== 'boolean'
    ) {
      throw new JSONResponseError('stream must be a boolean or null.', 400, {
        error: {
          code: 'invalid_websocket_parameter',
          message: 'stream must be a boolean or null.',
          param: 'stream',
          type: 'invalid_request_error',
        },
      })
    }
    if (event.stream === false) {
      throw new JSONResponseError('stream:false is not supported over WebSocket because streaming is implicit.', 400, {
        error: {
          code: 'unsupported_value',
          message: 'stream:false is not supported over WebSocket because streaming is implicit.',
          param: 'stream',
          type: 'invalid_request_error',
        },
      })
    }
    if (event.generate === false) {
      consola.debug('Rejected Responses WebSocket generate:false locally:', {
        connectionId: this.peer.id,
        status: 400,
        upstreamAttempted: false,
      })
      throw new JSONResponseError('generate:false WebSocket warmup is not supported by the GitHub Copilot Responses backend.', 400, {
        error: {
          code: 'unsupported_value',
          message: 'generate:false WebSocket warmup is not supported by the GitHub Copilot Responses backend.',
          param: 'generate',
          type: 'invalid_request_error',
        },
      })
    }

    validateResponsesWebSocketInput(event.input)

    return event as ResponsesWebSocketCreateEvent
  }

  private prepareUpstreamEvent(
    event: ResponsesWebSocketCreateEvent,
    effectiveModel: string,
  ): ResponsesWebSocketCreateEvent {
    const upstreamEvent: ResponsesWebSocketCreateEvent = { ...event, model: effectiveModel }
    if (
      typeof upstreamEvent.previous_response_id === 'string'
      && upstreamEvent.previous_response_id === this.lastPublicResponseId
      && this.lastTerminalUpstreamResponseId
    ) {
      upstreamEvent.previous_response_id = this.lastTerminalUpstreamResponseId
    }
    delete upstreamEvent.background
    delete upstreamEvent.stream
    if (Object.hasOwn(upstreamEvent, 'service_tier')) {
      consola.debug('Stripping service_tier (unsupported by Copilot Responses WebSocket backend)')
      delete upstreamEvent.service_tier
    }
    return upstreamEvent
  }

  private async ensureUpstream(
    options: Parameters<typeof connectAuthenticatedCopilotResponsesWebSocket>[0],
  ): Promise<CopilotResponsesWebSocketConnection> {
    if (!this.connectPromise) {
      consola.debug('Opening Copilot Responses WebSocket connection:', {
        connectionId: this.peer.id,
        model: options.model,
      })
      this.connectPromise = this.deps.connect(options).then((connection) => {
        if (this.closed) {
          connection.socket.terminate()
          void connection.releaseInitialTurn()
          throw new Error('Downstream Responses WebSocket closed during upstream handshake')
        }
        this.upstream = connection.socket
        this.installUpstreamListeners(connection.socket)
        const handoffError = connection.handoff?.()
        if (handoffError || connection.socket.readyState !== connection.socket.OPEN) {
          this.upstream = undefined
          connection.socket.terminate()
          void connection.releaseInitialTurn()
          throw handoffError ?? new Error('Copilot Responses WebSocket closed during connection setup')
        }
        return connection
      }).catch((error) => {
        this.connectPromise = undefined
        throw error
      })
    }
    return await this.connectPromise
  }

  private installUpstreamListeners(socket: WebSocket): void {
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.sendLocalError(502, 'invalid_upstream_websocket_frame', 'Copilot Responses WebSocket returned a binary frame.')
        this.closeBoth(1011, 'Invalid upstream WebSocket frame')
        return
      }
      const text = data.toString()
      this.handleUpstreamMessage(text)
    })
    socket.on('error', (error) => {
      consola.warn('Copilot Responses WebSocket transport error:', {
        connectionId: this.peer.id,
        message: error.message,
      })
    })
    socket.on('close', (code, reason) => {
      if (this.pausedUpstream === socket)
        this.pausedUpstream = undefined
      if (this.closingUpstream === socket)
        this.closingUpstream = undefined
      this.upstream = undefined
      this.connectPromise = undefined
      if (this.closed)
        return
      const hasPendingClientWork = this.activeTurn !== undefined
        || this.processingSetup
        || this.queue.length > 0
        || this.queueRejectionPending !== undefined
      const cleanIdleClose = (code === 1000 || code === 1001)
        && this.lastUpstreamEventWasTerminal
        && !hasPendingClientWork
      if (cleanIdleClose) {
        this.closeDownstream(code, reason.toString() || 'Upstream WebSocket closed')
        this.finish('success')
        return
      }
      this.sendLocalError(502, 'upstream_websocket_closed', 'Copilot Responses WebSocket closed before the client connection ended.')
      this.closeDownstream(normalizeCloseCode(code), reason.toString() || 'Upstream WebSocket closed')
      this.finish('failure')
    })
  }

  private handleUpstreamMessage(raw: string): void {
    if (this.closed)
      return

    if (Buffer.byteLength(raw) > MAX_RESPONSES_WEBSOCKET_FRAME_BYTES) {
      this.sendLocalError(502, 'upstream_websocket_frame_too_large', 'Copilot Responses WebSocket returned an oversized frame.')
      this.closeBoth(1011, 'Upstream WebSocket frame too large')
      return
    }

    let event: Record<string, unknown> | undefined
    let eventType: string | undefined
    try {
      const parsed = JSON.parse(raw) as unknown
      event = isRecord(parsed) ? parsed : undefined
      eventType = typeof event?.type === 'string' ? event.type : undefined
    }
    catch {
      this.sendLocalError(502, 'invalid_upstream_websocket_event', 'Copilot Responses WebSocket returned invalid JSON.')
      this.closeBoth(1011, 'Invalid upstream WebSocket event')
      return
    }

    const activeTurn = this.activeTurn
    const response = event && isRecord(event.response) ? event.response : undefined
    const upstreamResponseId = typeof response?.id === 'string' ? response.id : undefined
    let downstreamRaw = raw
    if (eventType?.startsWith('response.') && activeTurn && response && upstreamResponseId) {
      activeTurn.publicResponseId ??= upstreamResponseId
      const upstreamPreviousResponseId = typeof response.previous_response_id === 'string'
        ? response.previous_response_id
        : undefined
      const normalizedPreviousResponseId = activeTurn.clientPreviousResponseId
        && upstreamPreviousResponseId !== undefined
        ? activeTurn.clientPreviousResponseId
        : upstreamPreviousResponseId
      if (
        upstreamResponseId !== activeTurn.publicResponseId
        || normalizedPreviousResponseId !== upstreamPreviousResponseId
      ) {
        downstreamRaw = JSON.stringify({
          ...event,
          response: {
            ...response,
            id: activeTurn.publicResponseId,
            ...(normalizedPreviousResponseId !== undefined && {
              previous_response_id: normalizedPreviousResponseId,
            }),
          },
        })
      }
    }
    if (
      activeTurn
      && typeof event?.sequence_number === 'number'
      && Number.isSafeInteger(event.sequence_number)
      && event.sequence_number >= 0
    ) {
      activeTurn.lastSequenceNumber = Math.max(
        activeTurn.lastSequenceNumber ?? 0,
        event.sequence_number,
      )
    }
    this.peer.send(downstreamRaw)
    if (eventType && activeTurn && !activeTurn.firstEventSeen) {
      activeTurn.firstEventSeen = true
      consola.debug('Copilot Responses WebSocket first event:', {
        connectionId: this.peer.id,
        event: eventType,
        model: activeTurn.model,
      })
    }
    const downstreamBackpressured = this.peer.bufferedAmount > RESPONSES_WEBSOCKET_HIGH_WATERMARK_BYTES

    if (eventType && TERMINAL_RESPONSE_EVENTS.has(eventType)) {
      this.lastUpstreamEventWasTerminal = true
      if (activeTurn?.publicResponseId && upstreamResponseId) {
        this.lastPublicResponseId = activeTurn.publicResponseId
        this.lastTerminalUpstreamResponseId = upstreamResponseId
      }
      consola.debug('Copilot Responses WebSocket terminal event:', {
        connectionId: this.peer.id,
        event: eventType,
        responseIdNormalized: activeTurn?.publicResponseId !== undefined
          && upstreamResponseId !== undefined
          && activeTurn.publicResponseId !== upstreamResponseId,
        model: this.activeTurn?.model,
      })
      this.waitingForDownstreamDrain = downstreamBackpressured
      void this.settleActiveTurn('success').then(async () => {
        if (this.draining) {
          this.waitingForDownstreamDrain = false
          this.closeBoth(1001, RESPONSES_WEBSOCKET_CLOSE_REASON)
          return
        }
        if (downstreamBackpressured) {
          try {
            await this.peer.waitForDrain({
              threshold: RESPONSES_WEBSOCKET_LOW_WATERMARK_BYTES,
            })
          }
          catch {
            this.waitingForDownstreamDrain = false
            if (!this.closed)
              this.closeBoth(1013, 'Downstream WebSocket backpressure')
            return
          }
        }
        this.waitingForDownstreamDrain = false
        if (!this.closed)
          this.processQueue()
      })
      return
    }

    if (downstreamBackpressured) {
      const pausedSocket = this.upstream
      if (!this.deps.canPauseUpstream) {
        this.sendLocalError(503, 'downstream_websocket_backpressure', 'Downstream Responses WebSocket is not draining quickly enough.')
        this.closeBoth(1013, 'Downstream WebSocket backpressure')
        return
      }
      pausedSocket?.pause()
      this.pausedUpstream = pausedSocket
      void this.peer.waitForDrain({
        threshold: RESPONSES_WEBSOCKET_LOW_WATERMARK_BYTES,
      }).finally(() => {
        if (pausedSocket && pausedSocket.readyState === pausedSocket.OPEN) {
          pausedSocket.resume()
          if (this.pausedUpstream === pausedSocket)
            this.pausedUpstream = undefined
        }
      }).catch(() => {
        if (!this.closed)
          this.closeBoth(1013, 'Downstream WebSocket backpressure')
      })
    }

    this.armTurnInactivityTimeout()
  }

  private async settleActiveTurn(outcome: TurnOutcome): Promise<void> {
    const turn = this.activeTurn
    if (!turn)
      return
    this.activeTurn = undefined
    this.clearTurnInactivityTimer()
    turn.abortController.abort(`Responses WebSocket turn ${outcome}`)
    await turn.settle(outcome)
  }

  private finish(outcome: TurnOutcome): void {
    if (this.closed)
      return
    this.closed = true
    this.discardQueuedTurns()
    this.queueRejectionPending = undefined
    this.clearDurationTimer()
    this.clearTurnInactivityTimer()
    this.pendingTurnAbortController?.abort(`Responses WebSocket session ${outcome}`)
    this.pendingTurnAbortController = undefined
    this.waitingForDownstreamDrain = false
    this.releaseSetupReservation?.()
    if (this.activeTurn)
      void this.settleActiveTurn(outcome)
    this.resolveClosed()
  }

  private discardQueuedTurns(): void {
    const releasedBytes = this.queuedBytes
    this.queue.length = 0
    this.queuedBytes = 0
    if (releasedBytes > 0)
      this.deps.requestBufferBudget.release(releasedBytes)
  }

  private async waitForDownstreamTransportClose(): Promise<void> {
    const websocket = this.peer.websocket
    if (typeof websocket?.readyState !== 'number')
      return
    if (websocket.readyState >= 3)
      return
    await this.transportClosedPromise
  }

  private closeBoth(code: number, reason: string): void {
    if (this.closed)
      return
    this.closeUpstream(code, reason)
    this.closeDownstream(code, reason)
    this.finish('cancel')
  }

  private closeUpstream(code?: number, reason?: string): void {
    const socket = this.upstream
    if (!socket)
      return
    this.upstream = undefined
    this.closingUpstream = socket
    if (socket.readyState === socket.OPEN) {
      if (this.pausedUpstream === socket) {
        this.pausedUpstream = undefined
        socket.resume()
      }
      socket.close(normalizeCloseCode(code), truncateCloseReason(reason))
    }
    else if (socket.readyState === socket.CONNECTING) {
      socket.close(normalizeCloseCode(code), truncateCloseReason(reason))
    }
  }

  private closeDownstream(code?: number, reason?: string): void {
    if (!this.closed)
      this.peer.close(normalizeCloseCode(code), truncateCloseReason(reason))
  }

  private async sendErrorFromUnknown(error: unknown): Promise<void> {
    const normalized = await normalizeWebSocketError(error)
    this.sendLocalError(normalized.status, normalized.code, normalized.message, normalized.param, normalized.type)
  }

  private sendLocalError(
    status: number,
    code: string,
    message: string,
    param: string | null = null,
    type = status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error',
  ): void {
    if (this.closed)
      return
    const lastSequenceNumber = this.activeTurn?.lastSequenceNumber
    const sequenceNumber = lastSequenceNumber === undefined
      ? 0
      : Math.min(lastSequenceNumber + 1, Number.MAX_SAFE_INTEGER)
    this.peer.send(JSON.stringify({
      type: 'error',
      code,
      message,
      param,
      sequence_number: sequenceNumber,
      status,
      error_type: type,
    }))
  }

  private sendConnectionLimitError(): void {
    this.sendLocalError(
      400,
      'websocket_connection_limit_reached',
      'Responses WebSocket connection limit reached (60 minutes). Create a new WebSocket connection to continue.',
    )
  }

  private clearDurationTimer(): void {
    if (this.durationTimer) {
      clearTimeout(this.durationTimer)
      this.durationTimer = undefined
    }
  }

  private armTurnInactivityTimeout(): void {
    this.clearTurnInactivityTimer()
    const timeoutMs = getCopilotWebSocketInactivityTimeoutMs()
    if (timeoutMs === 0 || !this.activeTurn)
      return

    this.turnInactivityTimer = setTimeout(() => {
      this.turnInactivityTimer = undefined
      if (!this.activeTurn || this.closed)
        return
      this.sendLocalError(504, 'upstream_websocket_timeout', `Copilot Responses WebSocket produced no events for ${timeoutMs}ms.`)
      void this.settleActiveTurn('failure').finally(() => {
        this.closeBoth(1011, 'Upstream WebSocket inactivity timeout')
      })
    }, timeoutMs)
    this.turnInactivityTimer.unref?.()
  }

  private clearTurnInactivityTimer(): void {
    if (this.turnInactivityTimer) {
      clearTimeout(this.turnInactivityTimer)
      this.turnInactivityTimer = undefined
    }
  }
}

function getSession(peer: Peer): ResponsesWebSocketSession | undefined {
  return (peer.context as ResponsesWebSocketContext).session
}

function reservePendingConnection(): () => void {
  pendingConnections++
  let released = false
  const timeout = setTimeout(release, RESPONSES_WEBSOCKET_UPGRADE_RESERVATION_MS)
  timeout.unref?.()

  function release() {
    if (released)
      return
    released = true
    clearTimeout(timeout)
    pendingConnections--
  }

  return release
}

function validateResponsesWebSocketInput(input: unknown): void {
  if (input === undefined || typeof input === 'string')
    return

  if (!Array.isArray(input)) {
    throwInvalidResponsesWebSocketInput(
      'input must be a string or an array of input items.',
      'input',
    )
  }

  for (let itemIndex = 0; itemIndex < input.length; itemIndex++) {
    const item = input[itemIndex]
    if (!isRecord(item)) {
      throwInvalidResponsesWebSocketInput(
        `input[${itemIndex}] must be an input item object.`,
        `input[${itemIndex}]`,
      )
    }

    const isMessage = typeof item.role === 'string'
      && (item.type === undefined || item.type === 'message')
    if (isMessage) {
      if (typeof item.content !== 'string' && !Array.isArray(item.content)) {
        throwInvalidResponsesWebSocketInput(
          `input[${itemIndex}].content must be a string or an array of content parts.`,
          `input[${itemIndex}].content`,
        )
      }
      if (Array.isArray(item.content)) {
        validateResponsesWebSocketContentParts(
          item.content,
          `input[${itemIndex}].content`,
        )
      }
    }

    if (item.type === 'function_call_output') {
      if (typeof item.output !== 'string' && !Array.isArray(item.output)) {
        throwInvalidResponsesWebSocketInput(
          `input[${itemIndex}].output must be a string or an array of content parts.`,
          `input[${itemIndex}].output`,
        )
      }
      if (Array.isArray(item.output)) {
        validateResponsesWebSocketContentParts(
          item.output,
          `input[${itemIndex}].output`,
        )
      }
    }
  }
}

function validateResponsesWebSocketContentParts(parts: unknown[], path: string): void {
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    if (isRecord(parts[partIndex]))
      continue

    throwInvalidResponsesWebSocketInput(
      `${path}[${partIndex}] must be a content part object.`,
      `${path}[${partIndex}]`,
    )
  }
}

function throwInvalidResponsesWebSocketInput(message: string, param: string): never {
  throw new JSONResponseError(message, 400, {
    error: {
      code: 'invalid_websocket_parameter',
      message,
      param,
      type: 'invalid_request_error',
    },
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createSessionAbortError(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

async function sendWebSocketText(socket: WebSocket, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.send(data, (error) => {
      if (error)
        reject(error)
      else
        resolve()
    })
  })
}

async function settlePermit(permit: CopilotRequestPermit, outcome: TurnOutcome): Promise<void> {
  if (outcome === 'success')
    permit.succeed()
  else if (outcome === 'failure')
    permit.fail()
  else
    permit.cancel()
}

async function normalizeWebSocketError(error: unknown): Promise<{
  code: string
  message: string
  param: string | null
  status: number
  type: string
}> {
  if (error instanceof JSONResponseError) {
    const details = extractErrorDetails(error.payload)
    return {
      code: details.code ?? 'invalid_request_error',
      message: details.message ?? error.message,
      param: details.param ?? null,
      status: error.status,
      type: details.type ?? 'invalid_request_error',
    }
  }

  if (error instanceof HTTPError) {
    const text = await error.text()
    let details: ReturnType<typeof extractErrorDetails> = {}
    try {
      details = extractErrorDetails(JSON.parse(text))
    }
    catch {}
    return {
      code: details.code ?? `upstream_http_${error.response.status}`,
      message: details.message ?? (text || error.message),
      param: details.param ?? null,
      status: error.response.status,
      type: details.type ?? (error.response.status === 401 ? 'authentication_error' : 'api_error'),
    }
  }

  if (error instanceof UpstreamTimeoutError) {
    return {
      code: 'upstream_timeout',
      message: error.message,
      param: null,
      status: error.status,
      type: 'timeout_error',
    }
  }

  return {
    code: 'websocket_proxy_error',
    message: error instanceof Error ? error.message : String(error),
    param: null,
    status: 500,
    type: 'api_error',
  }
}

function extractErrorDetails(payload: unknown): {
  code?: string
  message?: string
  param?: string | null
  type?: string
} {
  if (!payload || typeof payload !== 'object')
    return {}
  const envelope = payload as Record<string, unknown>
  const rawError = envelope.error && typeof envelope.error === 'object'
    ? envelope.error as Record<string, unknown>
    : envelope
  return {
    code: typeof rawError.code === 'string' ? rawError.code : undefined,
    message: typeof rawError.message === 'string' ? rawError.message : undefined,
    param: typeof rawError.param === 'string' || rawError.param === null ? rawError.param : undefined,
    type: typeof rawError.type === 'string' ? rawError.type : undefined,
  }
}

function normalizeCloseCode(code?: number): number {
  const isStandardSendableCode = code !== undefined
    && code >= 1000
    && code <= 1014
    && code !== 1004
    && code !== 1005
    && code !== 1006
  const isApplicationCode = code !== undefined && code >= 3000 && code <= 4999
  return isStandardSendableCode || isApplicationCode ? code : 1011
}

function truncateCloseReason(reason?: string): string | undefined {
  if (!reason)
    return undefined
  return Buffer.from(reason).subarray(0, 120).toString('utf8')
}
