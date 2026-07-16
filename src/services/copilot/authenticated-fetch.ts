import type { ConcurrencyLease } from '~/lib/concurrency-limiter'
import type { CopilotTokenSnapshot, ReactiveTokenRefreshResult } from '~/lib/token'

import consola from 'consola'

import { ConcurrencyLimitError } from '~/lib/concurrency-limiter'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import {
  getCopilotTokenLifecycleStatus,
  getCopilotTokenSnapshot,
  refreshCopilotTokenAfterFailure,
} from '~/lib/token'

const OPAQUE_FORBIDDEN_FAILURE_WINDOW_MS = 10_000
const OPAQUE_FORBIDDEN_FAILURE_THRESHOLD = 3
const INITIAL_CIRCUIT_COOLDOWN_MS = 60_000
const MAX_CIRCUIT_COOLDOWN_MS = 5 * 60_000
const MAX_TRACKED_SCOPES = 128
const CONCURRENCY_RETRY_AFTER_SECONDS = 1
const FAILED_REACTIVE_REFRESH_COOLDOWN_MS = 60_000

type AuthFailureKind = 'unauthorized' | 'opaque_forbidden' | 'token_error'
type CircuitPhase = 'closed' | 'open' | 'half_open'

interface ScopeCircuit {
  activeRequests: number
  phase: CircuitPhase
  cooldownMs: number
  openedAt?: number
  openUntil?: number
  probeInFlight: boolean
  opaqueFailureTimestamps: number[]
  lastFailureAt?: number
  lastSuccessAt?: number
}

interface CircuitReservation {
  globalProbe: boolean
  settled: boolean
  scope: ScopeCircuit
  scopeProbe: boolean
}

interface RecoveryResult {
  recovered: boolean
}

interface RecoveryDeferred extends RecoveryResult {
  promise: Promise<RecoveryResult>
  resolve: (value: RecoveryResult) => void
}

export interface AuthenticatedCopilotFetchOptions {
  endpoint: string
  model?: string
  request: (attempt: 0 | 1) => Promise<Response>
  signal?: AbortSignal
}

export interface AuthenticatedCopilotFetchDeps {
  now?: () => number
  refreshToken?: (
    failedSnapshot: CopilotTokenSnapshot,
  ) => Promise<ReactiveTokenRefreshResult>
}

export interface CopilotRequestPermit {
  cancel: () => void
  fail: () => void
  succeed: () => void
}

export interface CopilotRecoveryMetrics {
  upstreamAttempts: number
  upstreamTransportErrors: number
  responseStatusCounts: Record<string, number>
  recoverableAuthFailures: number
  reactiveRefreshAttempts: number
  reactiveRefreshSuccesses: number
  reactiveRefreshFailures: number
  reactiveRefreshSuppressions: number
  replayAttempts: number
  replaySuccesses: number
  replayFailures: number
  circuitOpenRejections: number
  scopeCircuitOpens: number
  globalCircuitOpens: number
  concurrencyQueueFullRejections: number
  concurrencyQueueTimeoutRejections: number
}

export interface CopilotRecoveryStatus {
  reactiveRefreshSuppressedUntil?: number
  globalCircuit: {
    phase: CircuitPhase
    openUntil?: number
    retryAfterSeconds?: number
  }
  scopes: {
    tracked: number
    open: number
    halfOpen: number
    earliestOpenUntil?: number
  }
  metrics: CopilotRecoveryMetrics
}

const scopeCircuits = new Map<string, ScopeCircuit>()
const scopeRecoveries = new Map<ScopeCircuit, RecoveryDeferred>()
const globalCircuit = createCircuit()
let reactiveRefreshSuppressedUntil: number | undefined
let reactiveRefreshSuppressedGeneration: number | undefined

const metrics: CopilotRecoveryMetrics = {
  upstreamAttempts: 0,
  upstreamTransportErrors: 0,
  responseStatusCounts: {},
  recoverableAuthFailures: 0,
  reactiveRefreshAttempts: 0,
  reactiveRefreshSuccesses: 0,
  reactiveRefreshFailures: 0,
  reactiveRefreshSuppressions: 0,
  replayAttempts: 0,
  replaySuccesses: 0,
  replayFailures: 0,
  circuitOpenRejections: 0,
  scopeCircuitOpens: 0,
  globalCircuitOpens: 0,
  concurrencyQueueFullRejections: 0,
  concurrencyQueueTimeoutRejections: 0,
}

export async function fetchAuthenticatedCopilot(
  options: AuthenticatedCopilotFetchOptions,
  deps: AuthenticatedCopilotFetchDeps = {},
): Promise<Response> {
  const now = deps.now ?? Date.now
  const scopeKey = createScopeKey(options.endpoint, options.model)
  const scope = getScopeCircuit(scopeKey)
  scope.activeRequests++
  try {
    return await fetchAuthenticatedCopilotWithinScope(options, deps, now, scope)
  }
  finally {
    scope.activeRequests--
  }
}

/**
 * Admit one unit of work that will use an already-authenticated persistent
 * Copilot transport. The caller must settle the permit exactly once when the
 * corresponding response reaches a terminal event, fails, or is cancelled.
 */
export async function acquireCopilotRequestPermit(
  options: Pick<AuthenticatedCopilotFetchOptions, 'endpoint' | 'model' | 'signal'>,
  deps: Pick<AuthenticatedCopilotFetchDeps, 'now'> = {},
): Promise<CopilotRequestPermit> {
  const now = deps.now ?? Date.now
  const scope = getScopeCircuit(createScopeKey(options.endpoint, options.model))
  scope.activeRequests++

  let lease: ConcurrencyLease | undefined
  let reservation: CircuitReservation | undefined
  let settled = false

  const settle = (outcome: 'cancel' | 'failure' | 'success') => {
    if (settled)
      return
    settled = true

    if (reservation) {
      if (outcome === 'success')
        recordCircuitSuccess(reservation, now())
      else if (outcome === 'failure')
        recordCircuitFailure(reservation, now())
      else
        releaseCircuitReservation(reservation)
    }
    lease?.release()
    scope.activeRequests--
  }

  try {
    if (!state.concurrencyLimiter)
      throwIfPermitAborted(options.signal)
    assertCircuitAllowsRequest(scope, now())
    lease = await acquireConcurrencyLease(options.signal)
    throwIfPermitAborted(options.signal)
    reservation = reserveCircuitProbe(scope, now())
  }
  catch (error) {
    settle('cancel')
    throw error
  }

  return {
    cancel: () => settle('cancel'),
    fail: () => settle('failure'),
    succeed: () => settle('success'),
  }
}

function throwIfPermitAborted(signal?: AbortSignal): void {
  if (!signal?.aborted)
    return
  const error = new Error('Copilot persistent-transport request was cancelled before admission')
  error.name = 'AbortError'
  throw error
}

async function fetchAuthenticatedCopilotWithinScope(
  options: AuthenticatedCopilotFetchOptions,
  deps: AuthenticatedCopilotFetchDeps,
  now: () => number,
  scope: ScopeCircuit,
): Promise<Response> {
  assertCircuitAllowsRequest(scope, now())

  const lease = await acquireConcurrencyLease(options.signal)
  let releaseWithResponse = false
  let reservation: CircuitReservation | undefined

  try {
    reservation = reserveCircuitProbe(scope, now())
    const failedTokenSnapshot = getCopilotTokenSnapshot()
    const firstResponse = await sendAttempt(options, 0)
    const firstFailure = await classifyRecoverableAuthFailure(firstResponse)

    if (!firstFailure) {
      recordCircuitSuccess(reservation, now())
      const leasedResponse = attachLeaseToResponse(firstResponse, lease, options.signal)
      releaseWithResponse = true
      return leasedResponse
    }

    metrics.recoverableAuthFailures++
    if (firstFailure === 'opaque_forbidden') {
      const failureAt = now()
      if (recordOpaqueForbidden(scope, failureAt))
        maybeOpenGlobalCircuit(failureAt)
    }

    const existingRecovery = scopeRecoveries.get(scope)
    if (existingRecovery) {
      consola.debug('Joining in-flight Copilot authentication recovery:', {
        endpoint: options.endpoint,
        model: options.model,
      })
      const recovery = await existingRecovery.promise
      if (!recovery.recovered) {
        recordCircuitFailure(reservation, now())
        const leasedResponse = attachLeaseToResponse(firstResponse, lease, options.signal)
        releaseWithResponse = true
        return leasedResponse
      }

      await discardResponse(firstResponse)
      metrics.replayAttempts++
      const replayResponse = await sendAttempt(options, 1)
      const replayFailure = await classifyRecoverableAuthFailure(replayResponse)
      if (replayFailure) {
        metrics.replayFailures++
        consola.warn('A follower request remained rejected after Copilot token recovery; opening scoped cooldown:', {
          endpoint: options.endpoint,
          model: options.model,
          status: replayResponse.status,
          githubRequestId: replayResponse.headers.get('x-github-request-id') ?? undefined,
          copilotServiceRequestId: replayResponse.headers.get('x-copilot-service-request-id') ?? undefined,
        })
        openScopeCircuit(scope, now())
        maybeOpenGlobalCircuit(now())
        recordCircuitFailure(reservation, now())
      }
      else {
        metrics.replaySuccesses++
        recordCircuitSuccess(reservation, now())
      }
      const leasedResponse = attachLeaseToResponse(replayResponse, lease, options.signal)
      releaseWithResponse = true
      return leasedResponse
    }

    const recoveryCheckAt = now()
    if (
      (!reservation.scopeProbe && resolveCircuitPhase(scope, recoveryCheckAt) !== 'closed')
      || (!reservation.globalProbe && resolveCircuitPhase(globalCircuit, recoveryCheckAt) !== 'closed')
    ) {
      consola.debug('Suppressing a late Copilot authentication replay because its recovery circuit already changed state:', {
        endpoint: options.endpoint,
        model: options.model,
      })
      recordCircuitFailure(reservation, recoveryCheckAt)
      const leasedResponse = attachLeaseToResponse(firstResponse, lease, options.signal)
      releaseWithResponse = true
      return leasedResponse
    }

    const recoveryDeferred = createRecoveryDeferred()
    scopeRecoveries.set(scope, recoveryDeferred)
    logRecoverableFailure(options, firstResponse, firstFailure)
    let recoveryResolved = false
    try {
      const refreshToken = deps.refreshToken ?? refreshCopilotTokenAfterFailure
      const lifecycle = getCopilotTokenLifecycleStatus()
      const refreshSuppressed = reactiveRefreshSuppressedUntil !== undefined
        && reactiveRefreshSuppressedGeneration === lifecycle.generation
        && failedTokenSnapshot.generation === lifecycle.generation
        && now() < reactiveRefreshSuppressedUntil
      const refreshResult = refreshSuppressed
        ? { outcome: 'failed' as const, generation: lifecycle.generation }
        : await (async () => {
            metrics.reactiveRefreshAttempts++
            return refreshToken(failedTokenSnapshot)
          })()
      if (refreshSuppressed)
        metrics.reactiveRefreshSuppressions++
      if (refreshResult.outcome === 'failed') {
        if (refreshSuppressed) {
          consola.debug('Copilot reactive token refresh is in cooldown; returning the current upstream rejection:', {
            endpoint: options.endpoint,
            model: options.model,
            suppressedUntil: reactiveRefreshSuppressedUntil,
          })
        }
        else {
          metrics.reactiveRefreshFailures++
          reactiveRefreshSuppressedGeneration = getCopilotTokenLifecycleStatus().generation
          reactiveRefreshSuppressedUntil = now() + FAILED_REACTIVE_REFRESH_COOLDOWN_MS
          consola.warn('Copilot authentication recovery could not refresh the short-lived token:', {
            endpoint: options.endpoint,
            model: options.model,
          })
        }
        recoveryDeferred.resolve({ recovered: false })
        recoveryResolved = true
        if (scope.opaqueFailureTimestamps.length >= OPAQUE_FORBIDDEN_FAILURE_THRESHOLD) {
          openScopeCircuit(scope, now())
          maybeOpenGlobalCircuit(now())
        }
        recordCircuitFailure(reservation, now())
        const leasedResponse = attachLeaseToResponse(firstResponse, lease, options.signal)
        releaseWithResponse = true
        return leasedResponse
      }

      metrics.reactiveRefreshSuccesses++
      reactiveRefreshSuppressedGeneration = undefined
      reactiveRefreshSuppressedUntil = undefined
      await discardResponse(firstResponse)
      metrics.replayAttempts++
      const replayResponse = await sendAttempt(options, 1)
      const replayFailure = await classifyRecoverableAuthFailure(replayResponse)
      if (replayFailure) {
        metrics.replayFailures++
        consola.warn('Copilot authentication recovery replay remained rejected; opening scoped cooldown:', {
          endpoint: options.endpoint,
          model: options.model,
          status: replayResponse.status,
          githubRequestId: replayResponse.headers.get('x-github-request-id') ?? undefined,
          copilotServiceRequestId: replayResponse.headers.get('x-copilot-service-request-id') ?? undefined,
        })
        openScopeCircuit(scope, now())
        maybeOpenGlobalCircuit(now())
        recoveryDeferred.resolve({ recovered: false })
        recoveryResolved = true
        recordCircuitFailure(reservation, now())
      }
      else {
        metrics.replaySuccesses++
        consola.info('Copilot authentication recovery succeeded:', {
          endpoint: options.endpoint,
          model: options.model,
          refreshOutcome: refreshResult.outcome,
          status: replayResponse.status,
          tokenGeneration: getCopilotTokenLifecycleStatus().generation,
        })
        closeCircuit(scope, now())
        recoveryDeferred.resolve({ recovered: true })
        recoveryResolved = true
        recordCircuitSuccess(reservation, now())
      }

      const leasedResponse = attachLeaseToResponse(replayResponse, lease, options.signal)
      releaseWithResponse = true
      return leasedResponse
    }
    finally {
      if (!recoveryResolved)
        recoveryDeferred.resolve({ recovered: false })
      scopeRecoveries.delete(scope)
    }
  }
  catch (error) {
    if (reservation)
      recordCircuitFailure(reservation, now())
    throw error
  }
  finally {
    if (!releaseWithResponse)
      lease?.release()
  }
}

export function getCopilotRecoveryStatus(now = Date.now()): CopilotRecoveryStatus {
  const circuits = [...scopeCircuits.values()]
  const openUntilValues = circuits
    .map(circuit => circuit.openUntil)
    .filter((value): value is number => value !== undefined)
  return {
    reactiveRefreshSuppressedUntil: reactiveRefreshSuppressedUntil !== undefined
      && now < reactiveRefreshSuppressedUntil
      ? reactiveRefreshSuppressedUntil
      : undefined,
    globalCircuit: {
      phase: resolveCircuitPhase(globalCircuit, now),
      openUntil: globalCircuit.openUntil,
      retryAfterSeconds: getRetryAfterSeconds(globalCircuit, now),
    },
    scopes: {
      tracked: circuits.length,
      open: circuits.filter(circuit => resolveCircuitPhase(circuit, now) === 'open').length,
      halfOpen: circuits.filter(circuit => resolveCircuitPhase(circuit, now) === 'half_open').length,
      earliestOpenUntil: openUntilValues.length > 0 ? Math.min(...openUntilValues) : undefined,
    },
    metrics: {
      ...metrics,
      responseStatusCounts: { ...metrics.responseStatusCounts },
    },
  }
}

export function resetCopilotRecoveryStateForTests(): void {
  scopeCircuits.clear()
  scopeRecoveries.clear()
  reactiveRefreshSuppressedGeneration = undefined
  reactiveRefreshSuppressedUntil = undefined
  Object.assign(globalCircuit, createCircuit())
  Object.assign(metrics, {
    upstreamAttempts: 0,
    upstreamTransportErrors: 0,
    responseStatusCounts: {},
    recoverableAuthFailures: 0,
    reactiveRefreshAttempts: 0,
    reactiveRefreshSuccesses: 0,
    reactiveRefreshFailures: 0,
    reactiveRefreshSuppressions: 0,
    replayAttempts: 0,
    replaySuccesses: 0,
    replayFailures: 0,
    circuitOpenRejections: 0,
    scopeCircuitOpens: 0,
    globalCircuitOpens: 0,
    concurrencyQueueFullRejections: 0,
    concurrencyQueueTimeoutRejections: 0,
  } satisfies CopilotRecoveryMetrics)
}

async function sendAttempt(
  options: AuthenticatedCopilotFetchOptions,
  attempt: 0 | 1,
): Promise<Response> {
  metrics.upstreamAttempts++
  try {
    const response = await options.request(attempt)
    const statusKey = String(response.status)
    metrics.responseStatusCounts[statusKey] = (metrics.responseStatusCounts[statusKey] ?? 0) + 1
    return response
  }
  catch (error) {
    metrics.upstreamTransportErrors++
    throw error
  }
}

async function classifyRecoverableAuthFailure(response: Response): Promise<AuthFailureKind | undefined> {
  if (response.status === 401)
    return 'unauthorized'
  if (response.status !== 403 || response.headers.has('retry-after'))
    return undefined

  const text = await response.clone().text().catch(() => '')
  const normalized = text.trim().toLowerCase()
  const mediaType = response.headers.get('content-type')
    ?.toLowerCase()
    .split(';', 1)[0]
    ?.trim()
  if (
    normalized === 'forbidden'
    && mediaType === 'text/plain'
    && (
      response.headers.has('x-copilot-service-request-id')
      || response.headers.has('x-github-request-id')
    )
  ) {
    return 'opaque_forbidden'
  }

  try {
    const payload = JSON.parse(text) as Record<string, unknown>
    const error = payload.error && typeof payload.error === 'object'
      ? payload.error as Record<string, unknown>
      : payload
    const code = typeof error.code === 'string' ? error.code.toLowerCase() : ''
    if (['expired_token', 'invalid_token', 'token_expired'].includes(code))
      return 'token_error'
  }
  catch {
    // Non-JSON 403 responses other than the known opaque GitHub response are not replayed.
  }
  return undefined
}

async function acquireConcurrencyLease(signal?: AbortSignal): Promise<ConcurrencyLease | undefined> {
  const limiter = state.concurrencyLimiter
  if (!limiter)
    return undefined

  try {
    return await limiter.acquire({ signal })
  }
  catch (error) {
    if (!(error instanceof ConcurrencyLimitError))
      throw error
    if (error.code === 'concurrency_acquire_aborted')
      throw error

    const isQueueFull = error.code === 'concurrency_queue_full'
    if (isQueueFull)
      metrics.concurrencyQueueFullRejections++
    else
      metrics.concurrencyQueueTimeoutRejections++
    consola.warn('Copilot upstream concurrency control rejected a request locally:', {
      code: error.code,
      snapshot: limiter.snapshot(),
    })
    throw createControlError(
      isQueueFull ? 429 : 503,
      error.code,
      error.message,
      CONCURRENCY_RETRY_AFTER_SECONDS,
      'concurrency_limited',
    )
  }
}

function attachLeaseToResponse(
  response: Response,
  lease?: ConcurrencyLease,
  signal?: AbortSignal,
): Response {
  if (!lease)
    return response
  if (!response.body) {
    lease.release()
    return response
  }

  const reader = response.body.getReader()
  let onAbort: (() => void) | undefined
  const release = () => {
    if (onAbort)
      signal?.removeEventListener('abort', onAbort)
    lease.release()
  }
  const cancelReader = async (reason?: unknown) => {
    release()
    await reader.cancel(reason)
  }
  onAbort = () => {
    void cancelReader(signal?.reason).catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(result.value)
      }
      catch (error) {
        release()
        controller.error(error)
      }
    },
    cancel: cancelReader,
  })

  if (signal?.aborted)
    void cancelReader(signal.reason).catch(() => {})

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel('discarded before Copilot authentication replay').catch(() => {})
}

function assertCircuitAllowsRequest(scope: ScopeCircuit, now: number): void {
  for (const [circuit, label] of [[globalCircuit, 'global'], [scope, 'scope']] as const) {
    const phase = resolveCircuitPhase(circuit, now)
    if (phase === 'open' || (phase === 'half_open' && circuit.probeInFlight)) {
      metrics.circuitOpenRejections++
      const retryAfterSeconds = getRetryAfterSeconds(circuit, now) ?? 1
      throw createControlError(
        503,
        'copilot_upstream_circuit_open',
        `Copilot upstream recovery circuit is ${phase} for this ${label}.`,
        retryAfterSeconds,
        phase,
      )
    }
  }
}

function reserveCircuitProbe(scope: ScopeCircuit, now: number): CircuitReservation {
  assertCircuitAllowsRequest(scope, now)
  const globalProbe = resolveCircuitPhase(globalCircuit, now) === 'half_open'
  const scopeProbe = resolveCircuitPhase(scope, now) === 'half_open'
  if (globalProbe)
    globalCircuit.probeInFlight = true
  if (scopeProbe)
    scope.probeInFlight = true
  return { globalProbe, settled: false, scope, scopeProbe }
}

function recordCircuitSuccess(reservation: CircuitReservation, now: number): void {
  if (reservation.settled)
    return
  if (reservation.scopeProbe)
    closeCircuit(reservation.scope, now)
  else
    reservation.scope.lastSuccessAt = now
  if (reservation.globalProbe)
    closeCircuit(globalCircuit, now)
  releaseCircuitReservation(reservation)
}

function recordCircuitFailure(reservation: CircuitReservation, now: number): void {
  if (reservation.settled)
    return
  if (reservation.scopeProbe)
    reopenCircuit(reservation.scope, now)
  if (reservation.globalProbe)
    reopenCircuit(globalCircuit, now)
  releaseCircuitReservation(reservation)
}

function releaseCircuitReservation(reservation: CircuitReservation): void {
  if (reservation.settled)
    return
  if (reservation.scopeProbe)
    reservation.scope.probeInFlight = false
  if (reservation.globalProbe)
    globalCircuit.probeInFlight = false
  reservation.settled = true
}

function recordOpaqueForbidden(scope: ScopeCircuit, now: number): boolean {
  scope.lastFailureAt = now
  scope.opaqueFailureTimestamps = scope.opaqueFailureTimestamps
    .filter(timestamp => now - timestamp <= OPAQUE_FORBIDDEN_FAILURE_WINDOW_MS)
    .slice(-(OPAQUE_FORBIDDEN_FAILURE_THRESHOLD - 1))
  scope.opaqueFailureTimestamps.push(now)
  if (scope.opaqueFailureTimestamps.length >= OPAQUE_FORBIDDEN_FAILURE_THRESHOLD) {
    openScopeCircuit(scope, now)
    return true
  }
  return false
}

function openScopeCircuit(scope: ScopeCircuit, now: number): void {
  const wasOpen = scope.phase !== 'closed'
  openCircuit(scope, now)
  if (!wasOpen)
    metrics.scopeCircuitOpens++
}

function maybeOpenGlobalCircuit(now: number): void {
  const recentlyOpenedScopes = [...scopeCircuits.values()].filter(scope =>
    scope.openedAt !== undefined
    && now - scope.openedAt <= OPAQUE_FORBIDDEN_FAILURE_WINDOW_MS,
  )
  if (recentlyOpenedScopes.length < 2)
    return
  const wasOpen = globalCircuit.phase !== 'closed'
  openCircuit(globalCircuit, now)
  if (!wasOpen) {
    metrics.globalCircuitOpens++
    consola.warn('Copilot global recovery circuit opened after persistent rejection across multiple scopes:', {
      openUntil: globalCircuit.openUntil,
      affectedScopes: recentlyOpenedScopes.length,
    })
  }
}

function openCircuit(circuit: ScopeCircuit, now: number): void {
  circuit.phase = 'open'
  circuit.openedAt = now
  circuit.openUntil = now + circuit.cooldownMs
  circuit.probeInFlight = false
  circuit.lastFailureAt = now
}

function reopenCircuit(circuit: ScopeCircuit, now: number): void {
  circuit.cooldownMs = Math.min(circuit.cooldownMs * 2, MAX_CIRCUIT_COOLDOWN_MS)
  openCircuit(circuit, now)
}

function closeCircuit(circuit: ScopeCircuit, now: number): void {
  circuit.phase = 'closed'
  circuit.cooldownMs = INITIAL_CIRCUIT_COOLDOWN_MS
  circuit.openedAt = undefined
  circuit.openUntil = undefined
  circuit.probeInFlight = false
  circuit.opaqueFailureTimestamps = []
  circuit.lastSuccessAt = now
}

function resolveCircuitPhase(circuit: ScopeCircuit, now: number): CircuitPhase {
  if (circuit.phase === 'open' && circuit.openUntil !== undefined && now >= circuit.openUntil)
    circuit.phase = 'half_open'
  return circuit.phase
}

function getRetryAfterSeconds(circuit: ScopeCircuit, now: number): number | undefined {
  if (circuit.openUntil === undefined)
    return undefined
  return Math.max(1, Math.ceil((circuit.openUntil - now) / 1000))
}

function getScopeCircuit(key: string): ScopeCircuit {
  const existing = scopeCircuits.get(key)
  if (existing)
    return existing
  if (scopeCircuits.size >= MAX_TRACKED_SCOPES) {
    const oldestClosedKey = [...scopeCircuits.entries()]
      .find(([, circuit]) => circuit.phase === 'closed' && circuit.activeRequests === 0)?.[0]
    if (oldestClosedKey) {
      scopeCircuits.delete(oldestClosedKey)
    }
    else {
      const circuits = [...scopeCircuits.values()]
      const overflowCircuit = circuits.find(circuit => circuit.phase === 'closed') ?? circuits[0]
      if (!overflowCircuit)
        throw new Error('Copilot recovery scope registry is unexpectedly empty')
      consola.debug('Sharing a non-global Copilot recovery circuit slot because the bounded scope registry is saturated:', {
        trackedScopes: scopeCircuits.size,
      })
      return overflowCircuit
    }
  }
  const circuit = createCircuit()
  scopeCircuits.set(key, circuit)
  return circuit
}

function createCircuit(): ScopeCircuit {
  return {
    activeRequests: 0,
    phase: 'closed',
    cooldownMs: INITIAL_CIRCUIT_COOLDOWN_MS,
    probeInFlight: false,
    opaqueFailureTimestamps: [],
  }
}

function createScopeKey(endpoint: string, model?: string): string {
  return `${endpoint.slice(0, 128)}\u0000${(model ?? '*').slice(0, 128)}`
}

function createRecoveryDeferred(): RecoveryDeferred {
  let resolvePromise!: (value: RecoveryResult) => void
  const promise = new Promise<RecoveryResult>((resolve) => {
    resolvePromise = resolve
  })
  return {
    recovered: false,
    promise,
    resolve: resolvePromise,
  }
}

function createControlError(
  status: 429 | 503,
  code: string,
  message: string,
  retryAfterSeconds: number,
  recoveryState: string,
): HTTPError {
  return new HTTPError(message, Response.json({
    error: {
      message,
      type: status === 429 ? 'rate_limit_error' : 'api_error',
      code,
    },
  }, {
    status,
    headers: {
      'Retry-After': String(retryAfterSeconds),
      'X-Copilot-Proxy-Recovery-State': recoveryState,
    },
  }))
}

function logRecoverableFailure(
  options: AuthenticatedCopilotFetchOptions,
  response: Response,
  kind: AuthFailureKind,
): void {
  consola.warn('Copilot upstream authentication recovery candidate:', {
    endpoint: options.endpoint,
    model: options.model,
    kind,
    status: response.status,
    githubRequestId: response.headers.get('x-github-request-id') ?? undefined,
    copilotServiceRequestId: response.headers.get('x-copilot-service-request-id') ?? undefined,
    tokenGeneration: getCopilotTokenLifecycleStatus().generation,
  })
}
