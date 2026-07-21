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
type RecoveryFollowerOutcome = 'cancelled' | 'failed' | 'succeeded'

interface AuthenticatedRequestContext {
  lateRecovery?: RecoveryDeferred
}

interface ScopeCircuit {
  // Requests that sent attempt zero but have not selected a recovery yet.
  pendingInitialAuthRequests: Set<AuthenticatedRequestContext>
  activeRequests: number
  phase: CircuitPhase
  cooldownMs: number
  openedAt?: number
  openUntil?: number
  probeInFlight: boolean
  opaqueFailureTimestamps: number[]
  lastFailureAt?: number
  lastSuccessAt?: number
  circuitEpoch: number
  recoveryEpoch: number
}

interface CircuitReservation {
  globalCircuitEpoch: number
  globalProbe: boolean
  settled: boolean
  scope: ScopeCircuit
  scopeCircuitEpoch: number
  scopeProbe: boolean
}

interface RecoveryResult {
  recovered: boolean
}

interface RecoveryDeferred extends RecoveryResult {
  acceptingFollowers: boolean
  followerReplayFailed: boolean
  followerReplaysPending: number
  followerReplaysRegistered: number
  followerReplaySuccesses: number
  followersSettled: Promise<void>
  followersSettledResolved: boolean
  lateFollowerCandidates: number
  promise: Promise<RecoveryResult>
  resolve: (value: RecoveryResult) => void
  resolveFollowersSettled: () => void
  scopeRecoveryEpoch: number
}

interface RecoveryFollowerCohort {
  globalCircuitEpoch: number | undefined
  scope: ScopeCircuit
  scopeCircuitEpoch: number
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
const successfulRecoveriesAwaitingFollowers = new Map<RecoveryDeferred, RecoveryFollowerCohort>()
const globalCircuit = createCircuit()
const globalCircuitAffectedScopeEpochs = new Map<ScopeCircuit, number>()
let globalCircuitAffectedScopesEpoch = globalCircuit.circuitEpoch
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
  const requestContext: AuthenticatedRequestContext = {}
  scope.activeRequests++
  try {
    return await fetchAuthenticatedCopilotWithinScope(options, deps, now, scope, requestContext)
  }
  finally {
    scope.pendingInitialAuthRequests.delete(requestContext)
    releaseLateRecoveryCandidate(requestContext)
    scope.activeRequests--
    pruneScopeCircuits()
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
    pruneScopeCircuits()
  }

  try {
    if (!state.concurrencyLimiter)
      throwIfRequestAborted(options.signal)
    assertCircuitAllowsRequest(scope, now())
    lease = await acquireConcurrencyLease(options.signal)
    throwIfRequestAborted(options.signal)
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

function throwIfRequestAborted(signal?: AbortSignal): void {
  if (!signal?.aborted)
    return
  if (signal.reason instanceof Error)
    throw signal.reason
  const error = new Error('Copilot request was cancelled before upstream admission')
  error.name = 'AbortError'
  throw error
}

async function fetchAuthenticatedCopilotWithinScope(
  options: AuthenticatedCopilotFetchOptions,
  deps: AuthenticatedCopilotFetchDeps,
  now: () => number,
  scope: ScopeCircuit,
  requestContext: AuthenticatedRequestContext,
): Promise<Response> {
  assertCircuitAllowsRequest(scope, now())
  throwIfRequestAborted(options.signal)

  const lease = await acquireConcurrencyLease(options.signal)
  let releaseWithResponse = false
  let ownedRecovery: RecoveryDeferred | undefined
  let ownedRefresh: Promise<ReactiveTokenRefreshResult> | undefined
  let recoveryResolved = false
  let reservation: CircuitReservation | undefined
  let responseToDiscard: Response | undefined
  let settleJoinedRecovery: ((outcome: RecoveryFollowerOutcome) => void) | undefined

  try {
    throwIfRequestAborted(options.signal)
    reservation = reserveCircuitProbe(scope, now())
    const failedTokenSnapshot = getCopilotTokenSnapshot()
    scope.pendingInitialAuthRequests.add(requestContext)
    const firstResponse = await sendAttempt(options, 0)
    responseToDiscard = firstResponse
    const firstFailure = await classifyRecoverableAuthFailure(firstResponse)
    scope.pendingInitialAuthRequests.delete(requestContext)

    if (!firstFailure) {
      releaseLateRecoveryCandidate(requestContext)
      recordCircuitSuccess(reservation, now())
      const leasedResponse = attachLeaseToResponse(firstResponse, lease, options.signal)
      responseToDiscard = undefined
      releaseWithResponse = true
      return leasedResponse
    }

    const existingRecovery = scopeRecoveries.get(scope) ?? requestContext.lateRecovery
    const requestRecoveryEpoch = existingRecovery?.scopeRecoveryEpoch ?? ++scope.recoveryEpoch

    metrics.recoverableAuthFailures++
    if (firstFailure === 'opaque_forbidden') {
      const failureAt = now()
      if (recordOpaqueForbidden(scope, failureAt))
        maybeOpenGlobalCircuit(failureAt)
    }

    if (existingRecovery) {
      settleJoinedRecovery = registerRecoveryFollower(existingRecovery)
      releaseLateRecoveryCandidate(requestContext)
      consola.debug('Joining in-flight Copilot authentication recovery:', {
        endpoint: options.endpoint,
        model: options.model,
      })
      const recovery = await waitForSharedRecovery(existingRecovery.promise, options.signal)
      if (!recovery.recovered) {
        settleJoinedRecovery('failed')
        settleJoinedRecovery = undefined
        recordCircuitFailure(reservation, now())
        const leasedResponse = attachLeaseToResponse(firstResponse, lease, options.signal)
        responseToDiscard = undefined
        releaseWithResponse = true
        return leasedResponse
      }

      await discardResponse(firstResponse)
      responseToDiscard = undefined
      metrics.replayAttempts++
      const replayResponse = await sendAttempt(options, 1)
      responseToDiscard = replayResponse
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
        recordReplayAuthFailure(scope, reservation, now())
      }
      else {
        metrics.replaySuccesses++
        recordCircuitSuccess(reservation, now())
      }
      settleJoinedRecovery(replayFailure ? 'failed' : 'succeeded')
      settleJoinedRecovery = undefined
      const leasedResponse = attachLeaseToResponse(replayResponse, lease, options.signal)
      responseToDiscard = undefined
      releaseWithResponse = true
      return leasedResponse
    }

    releaseLateRecoveryCandidate(requestContext)

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
      responseToDiscard = undefined
      releaseWithResponse = true
      return leasedResponse
    }

    const recoveryDeferred = createRecoveryDeferred(requestRecoveryEpoch)
    ownedRecovery = recoveryDeferred
    scopeRecoveries.set(scope, recoveryDeferred)
    logRecoverableFailure(options, firstResponse, firstFailure)
    const refreshToken = deps.refreshToken ?? refreshCopilotTokenAfterFailure
    ownedRefresh = performReactiveRefresh({
      failedTokenSnapshot,
      now,
      requestOptions: options,
      refreshToken,
    })
    const refreshResult = await waitForSharedRecovery(ownedRefresh, options.signal)
    if (!isSuccessfulReactiveRefresh(refreshResult)) {
      recoveryDeferred.resolve({ recovered: false })
      recoveryResolved = true
      if (
        refreshResult.outcome === 'failed'
        && scope.opaqueFailureTimestamps.length >= OPAQUE_FORBIDDEN_FAILURE_THRESHOLD
      ) {
        openScopeCircuit(scope, now())
        maybeOpenGlobalCircuit(now())
      }
      if (refreshResult.outcome === 'cancelled')
        releaseCircuitReservation(reservation)
      else
        recordCircuitFailure(reservation, now())
      const leasedResponse = attachLeaseToResponse(firstResponse, lease, options.signal)
      responseToDiscard = undefined
      releaseWithResponse = true
      return leasedResponse
    }

    await discardResponse(firstResponse)
    responseToDiscard = undefined
    metrics.replayAttempts++
    const replayResponse = await sendAttempt(options, 1)
    responseToDiscard = replayResponse
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
      recordReplayAuthFailure(scope, reservation, now())
      recoveryDeferred.resolve({ recovered: false })
      recoveryResolved = true
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
      retainSuccessfulRecoveryForPendingInitialRequests(scope, recoveryDeferred)
      // Delayed attempt-zero responses can still open this scope after the
      // owner succeeds, even when the global circuit never opened.
      trackSuccessfulRecoveryFollowers(scope, recoveryDeferred, now)
      recoveryDeferred.resolve({ recovered: true })
      recoveryResolved = true
      recordCircuitSuccess(reservation, now())
    }

    const leasedResponse = attachLeaseToResponse(replayResponse, lease, options.signal)
    responseToDiscard = undefined
    releaseWithResponse = true
    return leasedResponse
  }
  catch (error) {
    if (settleJoinedRecovery) {
      settleJoinedRecovery(options.signal?.aborted ? 'cancelled' : 'failed')
      settleJoinedRecovery = undefined
    }
    if (responseToDiscard) {
      if (options.signal?.aborted)
        void discardResponse(responseToDiscard)
      else
        await discardResponse(responseToDiscard)
    }
    if (reservation) {
      if (options.signal?.aborted)
        releaseCircuitReservation(reservation)
      else
        recordCircuitFailure(reservation, now())
    }
    throw error
  }
  finally {
    settleJoinedRecovery?.('failed')
    if (ownedRecovery) {
      if (!recoveryResolved && options.signal?.aborted && ownedRefresh) {
        continueRecoveryAfterCallerAbort({
          deferred: ownedRecovery,
          now,
          requestOptions: options,
          refresh: ownedRefresh,
          scope,
        })
      }
      else {
        if (!recoveryResolved)
          ownedRecovery.resolve({ recovered: false })
        deleteScopeRecovery(scope, ownedRecovery)
        if (ownedRecovery.lateFollowerCandidates === 0)
          closeRecoveryFollowerRegistration(ownedRecovery)
      }
    }
    if (!releaseWithResponse)
      lease?.release()
  }
}

async function performReactiveRefresh(context: {
  failedTokenSnapshot: CopilotTokenSnapshot
  now: () => number
  requestOptions: AuthenticatedCopilotFetchOptions
  refreshToken: NonNullable<AuthenticatedCopilotFetchDeps['refreshToken']>
}): Promise<ReactiveTokenRefreshResult> {
  const lifecycle = getCopilotTokenLifecycleStatus()
  const refreshSuppressed = reactiveRefreshSuppressedUntil !== undefined
    && reactiveRefreshSuppressedGeneration === lifecycle.generation
    && context.failedTokenSnapshot.generation === lifecycle.generation
    && context.now() < reactiveRefreshSuppressedUntil
  const refreshResult = refreshSuppressed
    ? { outcome: 'failed' as const, generation: lifecycle.generation }
    : await (async () => {
        metrics.reactiveRefreshAttempts++
        return context.refreshToken(context.failedTokenSnapshot)
      })()

  if (refreshSuppressed)
    metrics.reactiveRefreshSuppressions++
  if (refreshResult.outcome === 'cancelled')
    return refreshResult
  if (refreshResult.outcome === 'failed') {
    if (refreshSuppressed) {
      consola.debug('Copilot reactive token refresh is in cooldown; returning the current upstream rejection:', {
        endpoint: context.requestOptions.endpoint,
        model: context.requestOptions.model,
        suppressedUntil: reactiveRefreshSuppressedUntil,
      })
    }
    else {
      metrics.reactiveRefreshFailures++
      reactiveRefreshSuppressedGeneration = getCopilotTokenLifecycleStatus().generation
      reactiveRefreshSuppressedUntil = context.now() + FAILED_REACTIVE_REFRESH_COOLDOWN_MS
      consola.warn('Copilot authentication recovery could not refresh the short-lived token:', {
        endpoint: context.requestOptions.endpoint,
        model: context.requestOptions.model,
      })
    }
    return refreshResult
  }

  metrics.reactiveRefreshSuccesses++
  reactiveRefreshSuppressedGeneration = undefined
  reactiveRefreshSuppressedUntil = undefined
  return refreshResult
}

function isSuccessfulReactiveRefresh(result: ReactiveTokenRefreshResult): boolean {
  return result.outcome === 'refreshed' || result.outcome === 'already_refreshed'
}

function waitForSharedRecovery<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal)
    return promise

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let onAbort = () => {}
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const settle = (callback: () => void) => {
      if (settled)
        return
      settled = true
      cleanup()
      callback()
    }
    onAbort = () => settle(() => reject(callerAbortReason(signal)))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => settle(() => resolve(value)),
      error => settle(() => reject(error)),
    )
    if (signal.aborted) {
      onAbort()
    }
  })
}

function callerAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error)
    return signal.reason
  const error = new Error('Copilot request was cancelled while waiting for authentication recovery')
  error.name = 'AbortError'
  return error
}

function continueRecoveryAfterCallerAbort(context: {
  deferred: RecoveryDeferred
  now: () => number
  requestOptions: AuthenticatedCopilotFetchOptions
  refresh: Promise<ReactiveTokenRefreshResult>
  scope: ScopeCircuit
}): void {
  void context.refresh.then((refreshResult) => {
    const recovered = isSuccessfulReactiveRefresh(refreshResult)
    context.deferred.recovered = recovered
    if (recovered) {
      consola.debug('Copilot authentication refresh completed after its initiating caller cancelled; joined callers may replay:', {
        endpoint: context.requestOptions.endpoint,
        model: context.requestOptions.model,
        refreshOutcome: refreshResult.outcome,
      })
    }
    else if (
      refreshResult.outcome === 'failed'
      && context.scope.opaqueFailureTimestamps.length >= OPAQUE_FORBIDDEN_FAILURE_THRESHOLD
    ) {
      openScopeCircuit(context.scope, context.now())
      maybeOpenGlobalCircuit(context.now())
    }
    if (recovered) {
      retainSuccessfulRecoveryForPendingInitialRequests(
        context.scope,
        context.deferred,
      )
    }
    else {
      deleteScopeRecovery(context.scope, context.deferred)
      closeRecoveryFollowerRegistration(context.deferred)
    }
    context.deferred.resolve({ recovered })
    if (recovered)
      clearOpaqueFailuresAfterSuccessfulFollowers(context)
  }).catch((error) => {
    consola.warn('Copilot authentication refresh failed after its initiating caller cancelled:', {
      endpoint: context.requestOptions.endpoint,
      model: context.requestOptions.model,
      error: error instanceof Error ? error.message : String(error),
    })
    context.deferred.recovered = false
    deleteScopeRecovery(context.scope, context.deferred)
    closeRecoveryFollowerRegistration(context.deferred)
    context.deferred.resolve({ recovered: false })
  })
}

function retainSuccessfulRecoveryForPendingInitialRequests(
  scope: ScopeCircuit,
  recovery: RecoveryDeferred,
): void {
  deleteScopeRecovery(scope, recovery)
  for (const requestContext of scope.pendingInitialAuthRequests) {
    releaseLateRecoveryCandidate(requestContext)
    requestContext.lateRecovery = recovery
    recovery.lateFollowerCandidates++
  }
  if (recovery.lateFollowerCandidates === 0)
    closeRecoveryFollowerRegistration(recovery)
}

function releaseLateRecoveryCandidate(requestContext: AuthenticatedRequestContext): void {
  const recovery = requestContext.lateRecovery
  if (!recovery)
    return
  requestContext.lateRecovery = undefined
  recovery.lateFollowerCandidates--
  if (recovery.lateFollowerCandidates === 0)
    closeRecoveryFollowerRegistration(recovery)
}

function clearOpaqueFailuresAfterSuccessfulFollowers(context: {
  deferred: RecoveryDeferred
  now: () => number
  requestOptions: AuthenticatedCopilotFetchOptions
  scope: ScopeCircuit
}): void {
  successfulRecoveriesAwaitingFollowers.set(context.deferred, {
    globalCircuitEpoch: getAffectedGlobalCircuitEpoch(context.scope),
    scope: context.scope,
    scopeCircuitEpoch: context.scope.circuitEpoch,
  })
  void context.deferred.followersSettled.then(() => {
    const cohort = successfulRecoveriesAwaitingFollowers.get(context.deferred)
    successfulRecoveriesAwaitingFollowers.delete(context.deferred)
    if (
      !cohort
      || cohort.scope !== context.scope
      || cohort.scopeCircuitEpoch !== context.scope.circuitEpoch
      || context.deferred.scopeRecoveryEpoch !== context.scope.recoveryEpoch
      || context.deferred.followerReplaysRegistered === 0
      || context.deferred.followerReplayFailed
      || context.deferred.followerReplaySuccesses !== context.deferred.followerReplaysRegistered
    ) {
      return
    }

    const recoveredAt = context.now()
    const hadOpaqueFailures = context.scope.opaqueFailureTimestamps.length > 0
    let closedScopedCircuit = false
    if (hadOpaqueFailures) {
      closedScopedCircuit = context.scope.phase !== 'closed'
      if (closedScopedCircuit) {
        closeCircuit(context.scope, recoveredAt)
      }
      else {
        context.scope.opaqueFailureTimestamps = []
        context.scope.lastSuccessAt = recoveredAt
      }
    }
    const closedGlobalCircuit = cohort.globalCircuitEpoch !== undefined
      && closeGlobalCircuitAfterAllScopesRecover(recoveredAt, cohort.globalCircuitEpoch)
    if (hadOpaqueFailures) {
      consola.info('Copilot authentication recovery followers cleared stale opaque failure evidence after the initiating caller cancelled:', {
        endpoint: context.requestOptions.endpoint,
        model: context.requestOptions.model,
        followerReplays: context.deferred.followerReplaySuccesses,
        closedGlobalCircuit,
        closedScopedCircuit,
      })
    }
  })
}

function trackSuccessfulRecoveryFollowers(
  scope: ScopeCircuit,
  recovery: RecoveryDeferred,
  now: () => number,
): void {
  successfulRecoveriesAwaitingFollowers.set(recovery, {
    globalCircuitEpoch: getAffectedGlobalCircuitEpoch(scope),
    scope,
    scopeCircuitEpoch: scope.circuitEpoch,
  })
  void recovery.followersSettled.then(() => {
    const followersSucceeded = !recovery.followerReplayFailed
      && recovery.followerReplaySuccesses === recovery.followerReplaysRegistered
    const cohort = successfulRecoveriesAwaitingFollowers.get(recovery)
    if (!cohort)
      return
    successfulRecoveriesAwaitingFollowers.delete(recovery)
    if (
      followersSucceeded
      && cohort.scope === scope
      && cohort.scopeCircuitEpoch === scope.circuitEpoch
      && recovery.scopeRecoveryEpoch === scope.recoveryEpoch
    ) {
      const recoveredAt = now()
      if (scope.phase !== 'closed') {
        closeCircuit(scope, recoveredAt)
      }
      else {
        scope.opaqueFailureTimestamps = []
        scope.lastSuccessAt = recoveredAt
      }
      if (cohort.globalCircuitEpoch !== undefined)
        closeGlobalCircuitAfterAllScopesRecover(recoveredAt, cohort.globalCircuitEpoch)
    }
  })
}

function getAffectedGlobalCircuitEpoch(scope: ScopeCircuit): number | undefined {
  if (
    globalCircuit.phase === 'closed'
    || globalCircuitAffectedScopesEpoch !== globalCircuit.circuitEpoch
    || globalCircuitAffectedScopeEpochs.get(scope) !== scope.circuitEpoch
  ) {
    return undefined
  }
  return globalCircuit.circuitEpoch
}

function closeGlobalCircuitAfterAllScopesRecover(now: number, expectedCircuitEpoch?: number): boolean {
  if (
    (expectedCircuitEpoch !== undefined && expectedCircuitEpoch !== globalCircuit.circuitEpoch)
    || globalCircuit.phase === 'closed'
    || globalCircuitAffectedScopesEpoch !== globalCircuit.circuitEpoch
    || [...successfulRecoveriesAwaitingFollowers.entries()].some(([recovery, cohort]) =>
      cohort.globalCircuitEpoch === globalCircuit.circuitEpoch
      && globalCircuitAffectedScopeEpochs.get(cohort.scope) === cohort.scopeCircuitEpoch
      && cohort.scopeCircuitEpoch === cohort.scope.circuitEpoch
      && recovery.scopeRecoveryEpoch === cohort.scope.recoveryEpoch,
    )
    || [...globalCircuitAffectedScopeEpochs.entries()].some(([scope, scopeCircuitEpoch]) =>
      scopeCircuitEpoch !== scope.circuitEpoch || scope.phase !== 'closed',
    )
  ) {
    return false
  }
  closeGlobalCircuit(now)
  return true
}

function closeGlobalCircuit(now: number): void {
  closeCircuit(globalCircuit, now)
  globalCircuitAffectedScopeEpochs.clear()
  globalCircuitAffectedScopesEpoch = globalCircuit.circuitEpoch
}

function registerRecoveryFollower(recovery: RecoveryDeferred): (outcome: RecoveryFollowerOutcome) => void {
  if (!recovery.acceptingFollowers)
    throw new Error('Copilot authentication recovery stopped accepting followers before registration')

  recovery.followerReplaysPending++
  recovery.followerReplaysRegistered++
  let settled = false
  return (outcome) => {
    if (settled)
      return
    settled = true
    recovery.followerReplaysPending--
    if (outcome === 'cancelled')
      recovery.followerReplaysRegistered--
    else if (outcome === 'succeeded')
      recovery.followerReplaySuccesses++
    else
      recovery.followerReplayFailed = true
    resolveRecoveryFollowersIfSettled(recovery)
  }
}

function closeRecoveryFollowerRegistration(recovery: RecoveryDeferred): void {
  recovery.acceptingFollowers = false
  resolveRecoveryFollowersIfSettled(recovery)
}

function resolveRecoveryFollowersIfSettled(recovery: RecoveryDeferred): void {
  if (
    recovery.followersSettledResolved
    || recovery.acceptingFollowers
    || recovery.followerReplaysPending > 0
  ) {
    return
  }
  recovery.followersSettledResolved = true
  recovery.resolveFollowersSettled()
}

function deleteScopeRecovery(scope: ScopeCircuit, recovery: RecoveryDeferred): void {
  if (scopeRecoveries.get(scope) === recovery) {
    scopeRecoveries.delete(scope)
    pruneScopeCircuits()
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
  successfulRecoveriesAwaitingFollowers.clear()
  reactiveRefreshSuppressedGeneration = undefined
  reactiveRefreshSuppressedUntil = undefined
  Object.assign(globalCircuit, createCircuit())
  globalCircuitAffectedScopeEpochs.clear()
  globalCircuitAffectedScopesEpoch = globalCircuit.circuitEpoch
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
  if (response.status !== 403)
    return undefined

  const text = await response.clone().text().catch(() => '')
  const normalized = text.trim().toLowerCase()
  const mediaType = response.headers.get('content-type')
    ?.toLowerCase()
    .split(';', 1)[0]
    ?.trim()

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

  if (
    !response.headers.has('retry-after')
    && normalized === 'forbidden'
    && mediaType === 'text/plain'
    && (
      response.headers.has('x-copilot-service-request-id')
      || response.headers.has('x-github-request-id')
    )
  ) {
    return 'opaque_forbidden'
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
  return {
    globalCircuitEpoch: globalCircuit.circuitEpoch,
    globalProbe,
    settled: false,
    scope,
    scopeCircuitEpoch: scope.circuitEpoch,
    scopeProbe,
  }
}

function recordCircuitSuccess(reservation: CircuitReservation, now: number): void {
  if (reservation.settled)
    return
  if (reservation.scopeProbe && reservation.scopeCircuitEpoch === reservation.scope.circuitEpoch)
    closeCircuit(reservation.scope, now)
  else
    reservation.scope.lastSuccessAt = now
  if (reservation.globalProbe && reservation.globalCircuitEpoch === globalCircuit.circuitEpoch)
    closeGlobalCircuitAfterAllScopesRecover(now, reservation.globalCircuitEpoch)
  releaseCircuitReservation(reservation)
}

function recordCircuitFailure(reservation: CircuitReservation, now: number): void {
  if (reservation.settled)
    return
  if (reservation.scopeProbe && reservation.scopeCircuitEpoch === reservation.scope.circuitEpoch)
    reopenScopeCircuit(reservation.scope, now)
  if (reservation.globalProbe && reservation.globalCircuitEpoch === globalCircuit.circuitEpoch)
    reopenGlobalCircuit(now)
  releaseCircuitReservation(reservation)
}

function recordReplayAuthFailure(
  scope: ScopeCircuit,
  reservation: CircuitReservation,
  now: number,
): void {
  if (reservation.scopeProbe && reservation.scopeCircuitEpoch === scope.circuitEpoch)
    reopenScopeCircuit(scope, now)
  else
    openScopeCircuit(scope, now)
  recordCircuitFailure(reservation, now)
  maybeOpenGlobalCircuit(now)
}

function releaseCircuitReservation(reservation: CircuitReservation): void {
  if (reservation.settled)
    return
  if (reservation.scopeProbe && reservation.scopeCircuitEpoch === reservation.scope.circuitEpoch)
    reservation.scope.probeInFlight = false
  if (reservation.globalProbe && reservation.globalCircuitEpoch === globalCircuit.circuitEpoch)
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
  openCircuitAfterFailure(scope, now)
  updateGlobalCircuitAffectedScopeEpoch(scope)
  for (const cohort of successfulRecoveriesAwaitingFollowers.values()) {
    if (cohort.scope === scope)
      cohort.scopeCircuitEpoch = scope.circuitEpoch
  }
  if (!wasOpen)
    metrics.scopeCircuitOpens++
}

function reopenScopeCircuit(scope: ScopeCircuit, now: number): void {
  reopenCircuit(scope, now)
  updateGlobalCircuitAffectedScopeEpoch(scope)
}

function updateGlobalCircuitAffectedScopeEpoch(scope: ScopeCircuit): void {
  if (
    globalCircuitAffectedScopesEpoch === globalCircuit.circuitEpoch
    && globalCircuitAffectedScopeEpochs.has(scope)
  ) {
    globalCircuitAffectedScopeEpochs.set(scope, scope.circuitEpoch)
  }
}

function maybeOpenGlobalCircuit(now: number): void {
  const recentlyOpenedScopes = [...scopeCircuits.values()].filter(scope =>
    scope.openedAt !== undefined
    && now - scope.openedAt <= OPAQUE_FORBIDDEN_FAILURE_WINDOW_MS,
  )
  if (recentlyOpenedScopes.length < 2)
    return
  const wasOpen = globalCircuit.phase !== 'closed'
  openCircuitAfterFailure(globalCircuit, now)
  replaceGlobalCircuitAffectedScopes(recentlyOpenedScopes)
  const recentlyOpenedScopeSet = new Set(recentlyOpenedScopes)
  for (const cohort of successfulRecoveriesAwaitingFollowers.values()) {
    if (recentlyOpenedScopeSet.has(cohort.scope))
      cohort.globalCircuitEpoch = globalCircuit.circuitEpoch
  }
  if (!wasOpen) {
    metrics.globalCircuitOpens++
    consola.warn('Copilot global recovery circuit opened after persistent rejection across multiple scopes:', {
      openUntil: globalCircuit.openUntil,
      affectedScopes: recentlyOpenedScopes.length,
    })
  }
}

function replaceGlobalCircuitAffectedScopes(scopes: ScopeCircuit[]): void {
  globalCircuitAffectedScopeEpochs.clear()
  for (const scope of scopes)
    globalCircuitAffectedScopeEpochs.set(scope, scope.circuitEpoch)
  globalCircuitAffectedScopesEpoch = globalCircuit.circuitEpoch
}

function reopenGlobalCircuit(now: number): void {
  reopenCircuit(globalCircuit, now)
  for (const scope of globalCircuitAffectedScopeEpochs.keys())
    globalCircuitAffectedScopeEpochs.set(scope, scope.circuitEpoch)
  globalCircuitAffectedScopesEpoch = globalCircuit.circuitEpoch
}

function openCircuitAfterFailure(circuit: ScopeCircuit, now: number): void {
  // Delayed failure evidence can reach an open path while a half-open probe is
  // still settling. Consume that probe's backoff before advancing its epoch;
  // the reservation then becomes stale and cannot apply the backoff twice.
  if (circuit.phase === 'half_open' && circuit.probeInFlight)
    reopenCircuit(circuit, now)
  else
    openCircuit(circuit, now)
}

function openCircuit(circuit: ScopeCircuit, now: number): void {
  circuit.circuitEpoch++
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
    if (!evictOneInactiveClosedScope() && !evictOneExcessInactiveScope()) {
      // Exact endpoint/model isolation is more important than a hard registry
      // ceiling while retained scopes carry active, recovery, or bounded
      // cooldown state. Temporary entries are pruned as work settles.
      consola.debug('Temporarily expanding the Copilot recovery scope registry while retained scopes still carry state:', {
        trackedScopes: scopeCircuits.size,
      })
    }
  }
  const circuit = createCircuit()
  scopeCircuits.set(key, circuit)
  return circuit
}

function pruneScopeCircuits(): void {
  while (scopeCircuits.size > MAX_TRACKED_SCOPES) {
    if (evictOneInactiveClosedScope())
      continue
    if (!evictOneExcessInactiveScope())
      return
  }
}

function evictOneInactiveClosedScope(): boolean {
  const oldestClosedEntry = [...scopeCircuits.entries()]
    .find(([, circuit]) =>
      circuit.phase === 'closed'
      && circuit.activeRequests === 0
      && !scopeRecoveries.has(circuit),
    )
  if (!oldestClosedEntry)
    return false
  deleteScopeCircuit(...oldestClosedEntry)
  return true
}

function evictOneExcessInactiveScope(): boolean {
  const inactiveEntries = [...scopeCircuits.entries()]
    .filter(([, circuit]) => circuit.activeRequests === 0 && !scopeRecoveries.has(circuit))
  if (inactiveEntries.length <= MAX_TRACKED_SCOPES)
    return false
  deleteScopeCircuit(...inactiveEntries[0]!)
  return true
}

function deleteScopeCircuit(key: string, circuit: ScopeCircuit): void {
  if (scopeCircuits.get(key) !== circuit)
    return
  scopeCircuits.delete(key)
  globalCircuitAffectedScopeEpochs.delete(circuit)
}

function createCircuit(): ScopeCircuit {
  return {
    pendingInitialAuthRequests: new Set(),
    activeRequests: 0,
    circuitEpoch: 0,
    phase: 'closed',
    cooldownMs: INITIAL_CIRCUIT_COOLDOWN_MS,
    probeInFlight: false,
    opaqueFailureTimestamps: [],
    recoveryEpoch: 0,
  }
}

function createScopeKey(endpoint: string, model?: string): string {
  return `${endpoint.slice(0, 128)}\u0000${(model ?? '*').slice(0, 128)}`
}

function createRecoveryDeferred(scopeRecoveryEpoch: number): RecoveryDeferred {
  let resolvePromise!: (value: RecoveryResult) => void
  let resolveFollowersSettled!: () => void
  const promise = new Promise<RecoveryResult>((resolve) => {
    resolvePromise = resolve
  })
  const followersSettled = new Promise<void>((resolve) => {
    resolveFollowersSettled = resolve
  })
  return {
    acceptingFollowers: true,
    followerReplayFailed: false,
    followerReplaysPending: 0,
    followerReplaysRegistered: 0,
    followerReplaySuccesses: 0,
    followersSettled,
    followersSettledResolved: false,
    lateFollowerCandidates: 0,
    recovered: false,
    promise,
    resolve: resolvePromise,
    resolveFollowersSettled,
    scopeRecoveryEpoch,
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
