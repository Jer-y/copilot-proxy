import type {
  AuthenticatedRequestContext,
  CircuitPhase,
  CircuitReservation,
  CopilotRecoveryStatus,
  RecoveryDeferred,
  RecoveryFollowerOutcome,
  RecoveryRegistry,
  RecoveryResult,
  ScopeCircuit,
} from '~/lib/account/recovery-registry'
import type { AccountContext } from '~/lib/account/types'
import type { ConcurrencyLease } from '~/lib/concurrency-limiter'
import type { CopilotTokenSnapshot, ReactiveTokenRefreshResult } from '~/lib/token'

import consola from 'consola'

import { createRecoveryCircuit, INITIAL_CIRCUIT_COOLDOWN_MS } from '~/lib/account/recovery-registry'
import { ConcurrencyLimitError } from '~/lib/concurrency-limiter'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'

const OPAQUE_FORBIDDEN_FAILURE_WINDOW_MS = 10_000
const OPAQUE_FORBIDDEN_FAILURE_THRESHOLD = 3
const MAX_CIRCUIT_COOLDOWN_MS = 5 * 60_000
const CONCURRENCY_RETRY_AFTER_SECONDS = 1
const FAILED_REACTIVE_REFRESH_COOLDOWN_MS = 60_000
const INPUT_ITEM_CONNECTION_ERRORS = new Set([
  'input item does not belong to this connection',
  'input item id does not belong to this connection',
])
const MAX_AUTH_FAILURE_BODY_BYTES = 64 * 1024
const AUTH_FAILURE_BODY_READ_INACTIVITY_TIMEOUT_MS = 1_000
const AUTH_FAILURE_BODY_READ_TOTAL_TIMEOUT_MS = 5_000
const AUTH_FAILURE_BODY_READ_DEADLINE = Symbol('auth-failure-body-read-deadline')

type AuthFailureKind = 'unauthorized' | 'opaque_forbidden' | 'token_error'

interface AuthFailureBodyReadResult {
  done: boolean
  value?: Uint8Array
}

interface AuthFailureBodyReader {
  read: () => Promise<AuthFailureBodyReadResult>
  cancel: () => Promise<void>
  releaseLock: () => void
}

interface AuthFailureClassification {
  failure?: AuthFailureKind
  normalizedResponse?: Response
}

export interface AuthenticatedCopilotFetchOptions {
  endpoint: string
  model?: string
  request: (attempt: 0 | 1) => Promise<Response>
  signal?: AbortSignal
}

interface ResolvedAuthenticatedCopilotFetchOptions extends AuthenticatedCopilotFetchOptions {
  ctx: AccountContext
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

export type { CopilotRecoveryMetrics, CopilotRecoveryStatus } from '~/lib/account/recovery-registry'

export function fetchAuthenticatedCopilot(
  options: AuthenticatedCopilotFetchOptions,
  deps?: AuthenticatedCopilotFetchDeps,
): Promise<Response>
export function fetchAuthenticatedCopilot(
  ctx: AccountContext,
  options: AuthenticatedCopilotFetchOptions,
  deps?: AuthenticatedCopilotFetchDeps,
): Promise<Response>
export async function fetchAuthenticatedCopilot(
  ctxOrOptions: AccountContext | AuthenticatedCopilotFetchOptions,
  optionsOrDeps: AuthenticatedCopilotFetchOptions | AuthenticatedCopilotFetchDeps = {},
  maybeDeps: AuthenticatedCopilotFetchDeps = {},
): Promise<Response> {
  const hasExplicitContext = isAccountContext(ctxOrOptions)
  const ctx: AccountContext = hasExplicitContext ? ctxOrOptions : state.defaultAccount
  const options = (hasExplicitContext ? optionsOrDeps : ctxOrOptions) as AuthenticatedCopilotFetchOptions
  const deps = (hasExplicitContext ? maybeDeps : optionsOrDeps) as AuthenticatedCopilotFetchDeps
  const resolvedOptions: ResolvedAuthenticatedCopilotFetchOptions = { ...options, ctx }
  const now = deps.now ?? Date.now
  const scopeKey = createScopeKey(ctx.id, options.endpoint, options.model)
  const scope = getScopeCircuit(ctx.recovery, scopeKey)
  const requestContext: AuthenticatedRequestContext = {}
  scope.activeRequests++
  try {
    return await fetchAuthenticatedCopilotWithinScope(resolvedOptions, deps, now, scope, requestContext)
  }
  finally {
    scope.pendingInitialAuthRequests.delete(requestContext)
    releaseLateRecoveryCandidate(requestContext)
    scope.activeRequests--
    pruneScopeCircuits(ctx.recovery)
  }
}

/**
 * Admit one unit of work that will use an already-authenticated persistent
 * Copilot transport. The caller must settle the permit exactly once when the
 * corresponding response reaches a terminal event, fails, or is cancelled.
 */
export function acquireCopilotRequestPermit(
  options: Pick<AuthenticatedCopilotFetchOptions, 'endpoint' | 'model' | 'signal'>,
  deps?: Pick<AuthenticatedCopilotFetchDeps, 'now'>,
): Promise<CopilotRequestPermit>
export function acquireCopilotRequestPermit(
  ctx: AccountContext,
  options: Pick<AuthenticatedCopilotFetchOptions, 'endpoint' | 'model' | 'signal'>,
  deps?: Pick<AuthenticatedCopilotFetchDeps, 'now'>,
): Promise<CopilotRequestPermit>
export async function acquireCopilotRequestPermit(
  ctxOrOptions: AccountContext | Pick<AuthenticatedCopilotFetchOptions, 'endpoint' | 'model' | 'signal'>,
  optionsOrDeps: Pick<AuthenticatedCopilotFetchOptions, 'endpoint' | 'model' | 'signal'> | Pick<AuthenticatedCopilotFetchDeps, 'now'> = {},
  maybeDeps: Pick<AuthenticatedCopilotFetchDeps, 'now'> = {},
): Promise<CopilotRequestPermit> {
  const hasExplicitContext = isAccountContext(ctxOrOptions)
  const ctx: AccountContext = hasExplicitContext ? ctxOrOptions : state.defaultAccount
  const options = (hasExplicitContext ? optionsOrDeps : ctxOrOptions) as Pick<AuthenticatedCopilotFetchOptions, 'endpoint' | 'model' | 'signal'>
  const deps = (hasExplicitContext ? maybeDeps : optionsOrDeps) as Pick<AuthenticatedCopilotFetchDeps, 'now'>
  const now = deps.now ?? Date.now
  const scope = getScopeCircuit(ctx.recovery, createScopeKey(ctx.id, options.endpoint, options.model))
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
    pruneScopeCircuits(ctx.recovery)
  }

  try {
    if (!ctx.concurrencyLimiter && !state.concurrencyLimiter)
      throwIfRequestAborted(options.signal)
    assertCircuitAllowsRequest(scope, now())
    lease = await acquireConcurrencyLease(ctx, options.signal)
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
  options: ResolvedAuthenticatedCopilotFetchOptions,
  deps: AuthenticatedCopilotFetchDeps,
  now: () => number,
  scope: ScopeCircuit,
  requestContext: AuthenticatedRequestContext,
): Promise<Response> {
  const registry = scope.registry
  const { globalCircuit, metrics, scopeRecoveries } = registry
  assertCircuitAllowsRequest(scope, now())
  throwIfRequestAborted(options.signal)

  const lease = await acquireConcurrencyLease(options.ctx, options.signal)
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
    const failedTokenSnapshot = options.ctx.tokens.getSnapshot()
    scope.pendingInitialAuthRequests.add(requestContext)
    const firstResponse = await sendAttempt(options, 0)
    responseToDiscard = firstResponse
    const firstClassification = await classifyRecoverableAuthFailure(firstResponse, options.endpoint, options.signal)
    const firstFailure = firstClassification.failure
    scope.pendingInitialAuthRequests.delete(requestContext)
    throwIfRequestAborted(options.signal)

    if (!firstFailure) {
      releaseLateRecoveryCandidate(requestContext)
      recordCircuitSuccess(reservation, now())
      const responseForClient = firstClassification.normalizedResponse ?? firstResponse
      if (firstClassification.normalizedResponse)
        await discardResponse(firstResponse)
      responseToDiscard = responseForClient
      const leasedResponse = attachLeaseToResponse(responseForClient, lease, options.signal)
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
        maybeOpenGlobalCircuit(scope, failureAt)
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
      // A cancelled caller must not hide a rejected fresh-token canary.
      const replayClassification = await classifyRecoverableAuthFailure(replayResponse, options.endpoint)
      const replayFailure = replayClassification.failure
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
      throwIfRequestAborted(options.signal)
      const responseForClient = replayClassification.normalizedResponse ?? replayResponse
      if (replayClassification.normalizedResponse)
        await discardResponse(replayResponse)
      responseToDiscard = responseForClient
      const leasedResponse = attachLeaseToResponse(responseForClient, lease, options.signal)
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
    const refreshToken = deps.refreshToken
      ?? (snapshot => options.ctx.tokens.refreshAfterFailure(snapshot))
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
        maybeOpenGlobalCircuit(scope, now())
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
    // A cancelled caller must not hide a rejected fresh-token canary.
    const replayClassification = await classifyRecoverableAuthFailure(replayResponse, options.endpoint)
    const replayFailure = replayClassification.failure
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
        tokenGeneration: options.ctx.tokens.getStatus().generation,
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

    throwIfRequestAborted(options.signal)
    const responseForClient = replayClassification.normalizedResponse ?? replayResponse
    if (replayClassification.normalizedResponse)
      await discardResponse(replayResponse)
    responseToDiscard = responseForClient
    const leasedResponse = attachLeaseToResponse(responseForClient, lease, options.signal)
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
  requestOptions: ResolvedAuthenticatedCopilotFetchOptions
  refreshToken: NonNullable<AuthenticatedCopilotFetchDeps['refreshToken']>
}): Promise<ReactiveTokenRefreshResult> {
  const registry = context.requestOptions.ctx.recovery
  const { metrics } = registry
  const lifecycle = context.requestOptions.ctx.tokens.getStatus()
  const refreshSuppressed = registry.reactiveRefreshSuppressedUntil !== undefined
    && registry.reactiveRefreshSuppressedGeneration === lifecycle.generation
    && context.failedTokenSnapshot.generation === lifecycle.generation
    && context.now() < registry.reactiveRefreshSuppressedUntil
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
        suppressedUntil: registry.reactiveRefreshSuppressedUntil,
      })
    }
    else {
      metrics.reactiveRefreshFailures++
      registry.reactiveRefreshSuppressedGeneration = context.requestOptions.ctx.tokens.getStatus().generation
      registry.reactiveRefreshSuppressedUntil = context.now() + FAILED_REACTIVE_REFRESH_COOLDOWN_MS
      consola.warn('Copilot authentication recovery could not refresh the short-lived token:', {
        endpoint: context.requestOptions.endpoint,
        model: context.requestOptions.model,
      })
    }
    return refreshResult
  }

  metrics.reactiveRefreshSuccesses++
  registry.reactiveRefreshSuppressedGeneration = undefined
  registry.reactiveRefreshSuppressedUntil = undefined
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
  requestOptions: ResolvedAuthenticatedCopilotFetchOptions
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
      maybeOpenGlobalCircuit(context.scope, context.now())
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
  requestOptions: ResolvedAuthenticatedCopilotFetchOptions
  scope: ScopeCircuit
}): void {
  const { successfulRecoveriesAwaitingFollowers } = context.scope.registry
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
      && closeGlobalCircuitAfterAllScopesRecover(context.scope.registry, recoveredAt, cohort.globalCircuitEpoch)
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
  const { successfulRecoveriesAwaitingFollowers } = scope.registry
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
        closeGlobalCircuitAfterAllScopesRecover(scope.registry, recoveredAt, cohort.globalCircuitEpoch)
    }
  })
}

function getAffectedGlobalCircuitEpoch(scope: ScopeCircuit): number | undefined {
  const {
    globalCircuit,
    globalCircuitAffectedScopeEpochs,
    globalCircuitAffectedScopesEpoch,
  } = scope.registry
  if (
    globalCircuit.phase === 'closed'
    || globalCircuitAffectedScopesEpoch !== globalCircuit.circuitEpoch
    || globalCircuitAffectedScopeEpochs.get(scope) !== scope.circuitEpoch
  ) {
    return undefined
  }
  return globalCircuit.circuitEpoch
}

function closeGlobalCircuitAfterAllScopesRecover(
  registry: RecoveryRegistry,
  now: number,
  expectedCircuitEpoch?: number,
): boolean {
  const {
    globalCircuit,
    globalCircuitAffectedScopeEpochs,
    globalCircuitAffectedScopesEpoch,
    successfulRecoveriesAwaitingFollowers,
  } = registry
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
  closeGlobalCircuit(registry, now)
  return true
}

function closeGlobalCircuit(registry: RecoveryRegistry, now: number): void {
  const { globalCircuit, globalCircuitAffectedScopeEpochs } = registry
  closeCircuit(globalCircuit, now)
  globalCircuitAffectedScopeEpochs.clear()
  registry.globalCircuitAffectedScopesEpoch = globalCircuit.circuitEpoch
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
  const { scopeRecoveries } = scope.registry
  if (scopeRecoveries.get(scope) === recovery) {
    scopeRecoveries.delete(scope)
    pruneScopeCircuits(scope.registry)
  }
}

export function getCopilotRecoveryStatus(
  now?: number,
): CopilotRecoveryStatus
export function getCopilotRecoveryStatus(
  ctx: AccountContext,
  now?: number,
): CopilotRecoveryStatus
export function getCopilotRecoveryStatus(
  ctxOrNow: AccountContext | number = state.defaultAccount,
  maybeNow = Date.now(),
): CopilotRecoveryStatus {
  const ctx = typeof ctxOrNow === 'number' ? state.defaultAccount : ctxOrNow
  const now = typeof ctxOrNow === 'number' ? ctxOrNow : maybeNow
  const registry = ctx.recovery
  const { globalCircuit, metrics, scopeCircuits } = registry
  const circuits = [...scopeCircuits.values()]
  const openUntilValues = circuits
    .map(circuit => circuit.openUntil)
    .filter((value): value is number => value !== undefined)
  return {
    reactiveRefreshSuppressedUntil: registry.reactiveRefreshSuppressedUntil !== undefined
      && now < registry.reactiveRefreshSuppressedUntil
      ? registry.reactiveRefreshSuppressedUntil
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
  state.defaultAccount.recovery.reset()
}

async function sendAttempt(
  options: ResolvedAuthenticatedCopilotFetchOptions,
  attempt: 0 | 1,
): Promise<Response> {
  const { metrics } = options.ctx.recovery
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

async function classifyRecoverableAuthFailure(
  response: Response,
  endpoint: string,
  signal?: AbortSignal,
): Promise<AuthFailureClassification> {
  if (response.status === 401) {
    if (endpoint === '/responses') {
      const text = await readResponseTextForClassification(response, signal)
      const message = getInputItemConnectionErrorMessage(text)
      if (message) {
        return {
          normalizedResponse: createInputItemConnectionErrorResponse(response, message),
        }
      }
    }
    return { failure: 'unauthorized' }
  }
  if (response.status !== 403)
    return {}

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
      return { failure: 'token_error' }
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
    return { failure: 'opaque_forbidden' }
  }
  return {}
}

async function readResponseTextForClassification(response: Response, signal?: AbortSignal): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > MAX_AUTH_FAILURE_BODY_BYTES)
    return ''

  let reader: AuthFailureBodyReader | undefined
  let pendingRead: Promise<AuthFailureBodyReadResult> | undefined
  let totalTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    const totalTimeoutResult = new Promise<typeof AUTH_FAILURE_BODY_READ_DEADLINE>((resolve) => {
      totalTimeout = setTimeout(
        resolve,
        AUTH_FAILURE_BODY_READ_TOTAL_TIMEOUT_MS,
        AUTH_FAILURE_BODY_READ_DEADLINE,
      )
      totalTimeout.unref?.()
    })
    const clone = response.clone()
    reader = clone.body?.getReader() as AuthFailureBodyReader | undefined
    if (!reader)
      return ''

    const decoder = new TextDecoder()
    let text = ''
    let totalBytes = 0
    while (true) {
      const currentRead = reader.read()
      pendingRead = currentRead
      const result = await readAuthFailureBodyChunk(currentRead, totalTimeoutResult, signal)
      pendingRead = undefined
      if (result === AUTH_FAILURE_BODY_READ_DEADLINE) {
        scheduleCloneReaderCleanup(reader, currentRead)
        reader = undefined
        return ''
      }
      if (!result) {
        scheduleCloneReaderCleanup(reader, currentRead)
        reader = undefined
        // The complete error envelope may already be buffered even when the
        // upstream branch never closes or the caller cancels.
        return text + decoder.decode()
      }

      if (result.done) {
        reader.releaseLock()
        reader = undefined
        return text + decoder.decode()
      }

      const value = result.value
      if (!value)
        return ''
      totalBytes += value.byteLength
      if (totalBytes > MAX_AUTH_FAILURE_BODY_BYTES) {
        scheduleCloneReaderCleanup(reader)
        reader = undefined
        return ''
      }
      text += decoder.decode(value, { stream: true })
    }
  }
  catch {
    return ''
  }
  finally {
    if (totalTimeout)
      clearTimeout(totalTimeout)
    if (reader) {
      if (pendingRead) {
        scheduleCloneReaderCleanup(reader, pendingRead)
      }
      else {
        try {
          reader.releaseLock()
        }
        catch {
          // The clone reader may already be closing after an upstream stream error.
        }
      }
    }
  }
}

async function readAuthFailureBodyChunk(
  pendingRead: Promise<AuthFailureBodyReadResult>,
  totalTimeoutResult: Promise<typeof AUTH_FAILURE_BODY_READ_DEADLINE>,
  signal?: AbortSignal,
): Promise<AuthFailureBodyReadResult | typeof AUTH_FAILURE_BODY_READ_DEADLINE | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    const timeoutResult = new Promise<undefined>((resolve) => {
      timeout = setTimeout(resolve, AUTH_FAILURE_BODY_READ_INACTIVITY_TIMEOUT_MS, undefined)
      timeout.unref?.()
    })
    const abortResult = signal
      ? new Promise<undefined>((resolve) => {
          onAbort = () => resolve(undefined)
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted)
            onAbort()
        })
      : undefined
    return await Promise.race(abortResult
      ? [pendingRead, timeoutResult, totalTimeoutResult, abortResult]
      : [pendingRead, timeoutResult, totalTimeoutResult])
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
    if (onAbort)
      signal?.removeEventListener('abort', onAbort)
  }
}

function scheduleCloneReaderCleanup(
  reader: AuthFailureBodyReader,
  pendingRead?: Promise<AuthFailureBodyReadResult>,
): void {
  void (async () => {
    let cancelPromise: Promise<void> | undefined
    try {
      // Cancel before waiting for a pending read. Waiting first can deadlock
      // with discardResponse(), which is cancelling the original tee branch.
      cancelPromise = reader.cancel()
    }
    catch {
      // Bun can throw synchronously when the tee controller is already closed.
    }

    try {
      if (pendingRead)
        await pendingRead
    }
    catch {
      // The clone may fail while the original response is being discarded.
    }

    try {
      await cancelPromise
    }
    catch {
      // Bun can close a tee branch before its reader cancellation settles.
    }

    try {
      reader.releaseLock()
    }
    catch {
      // The reader is already released or closed.
    }
  })()
}

function normalizeInputItemConnectionError(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const message = value.trim()
  return INPUT_ITEM_CONNECTION_ERRORS.has(message.toLowerCase()) ? message : undefined
}

function getInputItemConnectionErrorMessage(text: string): string | undefined {
  const directMessage = normalizeInputItemConnectionError(text)
  if (directMessage)
    return directMessage

  try {
    const payload = JSON.parse(text) as unknown
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      return undefined

    const envelope = payload as Record<string, unknown>
    const envelopeMessage = normalizeInputItemConnectionError(envelope.message)
      ?? normalizeInputItemConnectionError(envelope.error)
    if (envelopeMessage)
      return envelopeMessage

    if (!envelope.error || typeof envelope.error !== 'object' || Array.isArray(envelope.error))
      return undefined
    return normalizeInputItemConnectionError((envelope.error as Record<string, unknown>).message)
  }
  catch {
    return undefined
  }
}

function createInputItemConnectionErrorResponse(response: Response, message: string): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('transfer-encoding')
  headers.set('content-type', 'application/json')
  return Response.json({
    error: {
      message,
      type: 'invalid_request_error',
    },
  }, {
    status: 400,
    headers,
  })
}

async function acquireConcurrencyLease(
  ctx: AccountContext,
  signal?: AbortSignal,
): Promise<ConcurrencyLease | undefined> {
  const accountLease = await acquireSingleConcurrencyLease(
    ctx,
    ctx.concurrencyLimiter,
    'account',
    signal,
  )
  let globalLease: ConcurrencyLease | undefined
  try {
    globalLease = await acquireSingleConcurrencyLease(
      ctx,
      state.concurrencyLimiter,
      'global',
      signal,
    )
  }
  catch (error) {
    accountLease?.release()
    throw error
  }

  if (!accountLease && !globalLease)
    return undefined
  let released = false
  return {
    get released() {
      return released
    },
    release() {
      if (released)
        return
      released = true
      globalLease?.release()
      accountLease?.release()
    },
  }
}

async function acquireSingleConcurrencyLease(
  ctx: AccountContext,
  limiter: AccountContext['concurrencyLimiter'],
  scope: 'account' | 'global',
  signal?: AbortSignal,
): Promise<ConcurrencyLease | undefined> {
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
      ctx.recovery.metrics.concurrencyQueueFullRejections++
    else
      ctx.recovery.metrics.concurrencyQueueTimeoutRejections++
    consola.warn('Copilot upstream concurrency control rejected a request locally:', {
      account: ctx.id,
      code: error.code,
      scope,
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
  const { globalCircuit, metrics } = scope.registry
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
  const { globalCircuit } = scope.registry
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
  const registry = reservation.scope.registry
  const { globalCircuit } = registry
  if (reservation.settled)
    return
  if (reservation.scopeProbe && reservation.scopeCircuitEpoch === reservation.scope.circuitEpoch)
    closeCircuit(reservation.scope, now)
  else
    reservation.scope.lastSuccessAt = now
  if (reservation.globalProbe && reservation.globalCircuitEpoch === globalCircuit.circuitEpoch)
    closeGlobalCircuitAfterAllScopesRecover(registry, now, reservation.globalCircuitEpoch)
  releaseCircuitReservation(reservation)
}

function recordCircuitFailure(reservation: CircuitReservation, now: number): void {
  const registry = reservation.scope.registry
  const { globalCircuit } = registry
  if (reservation.settled)
    return
  if (reservation.scopeProbe && reservation.scopeCircuitEpoch === reservation.scope.circuitEpoch)
    reopenScopeCircuit(reservation.scope, now)
  if (reservation.globalProbe && reservation.globalCircuitEpoch === globalCircuit.circuitEpoch)
    reopenGlobalCircuit(registry, now)
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
  maybeOpenGlobalCircuit(scope, now)
}

function releaseCircuitReservation(reservation: CircuitReservation): void {
  const { globalCircuit } = reservation.scope.registry
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
  const { metrics, successfulRecoveriesAwaitingFollowers } = scope.registry
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
  const registry = scope.registry
  const { globalCircuit, globalCircuitAffectedScopeEpochs } = registry
  if (
    registry.globalCircuitAffectedScopesEpoch === globalCircuit.circuitEpoch
    && globalCircuitAffectedScopeEpochs.has(scope)
  ) {
    globalCircuitAffectedScopeEpochs.set(scope, scope.circuitEpoch)
  }
}

function maybeOpenGlobalCircuit(sourceScope: ScopeCircuit, now: number): void {
  const registry = sourceScope.registry
  const {
    globalCircuit,
    metrics,
    scopeCircuits,
    successfulRecoveriesAwaitingFollowers,
  } = registry
  const recentlyOpenedScopes = [...scopeCircuits.values()].filter(scope =>
    scope.openedAt !== undefined
    && now - scope.openedAt <= OPAQUE_FORBIDDEN_FAILURE_WINDOW_MS,
  )
  if (recentlyOpenedScopes.length < 2)
    return
  const wasOpen = globalCircuit.phase !== 'closed'
  openCircuitAfterFailure(globalCircuit, now)
  replaceGlobalCircuitAffectedScopes(registry, recentlyOpenedScopes)
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

function replaceGlobalCircuitAffectedScopes(
  registry: RecoveryRegistry,
  scopes: ScopeCircuit[],
): void {
  const { globalCircuit, globalCircuitAffectedScopeEpochs } = registry
  globalCircuitAffectedScopeEpochs.clear()
  for (const scope of scopes)
    globalCircuitAffectedScopeEpochs.set(scope, scope.circuitEpoch)
  registry.globalCircuitAffectedScopesEpoch = globalCircuit.circuitEpoch
}

function reopenGlobalCircuit(registry: RecoveryRegistry, now: number): void {
  const { globalCircuit, globalCircuitAffectedScopeEpochs } = registry
  reopenCircuit(globalCircuit, now)
  for (const scope of globalCircuitAffectedScopeEpochs.keys())
    globalCircuitAffectedScopeEpochs.set(scope, scope.circuitEpoch)
  registry.globalCircuitAffectedScopesEpoch = globalCircuit.circuitEpoch
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

function getScopeCircuit(registry: RecoveryRegistry, key: string): ScopeCircuit {
  const { scopeCircuits } = registry
  const existing = scopeCircuits.get(key)
  if (existing)
    return existing
  if (scopeCircuits.size >= registry.maxTrackedScopes) {
    if (!evictOneInactiveClosedScope(registry) && !evictOneExcessInactiveScope(registry)) {
      // Exact endpoint/model isolation is more important than a hard registry
      // ceiling while retained scopes carry active, recovery, or bounded
      // cooldown state. Temporary entries are pruned as work settles.
      consola.debug('Temporarily expanding the Copilot recovery scope registry while retained scopes still carry state:', {
        trackedScopes: scopeCircuits.size,
      })
    }
  }
  const circuit = createRecoveryCircuit(registry)
  scopeCircuits.set(key, circuit)
  return circuit
}

function pruneScopeCircuits(registry: RecoveryRegistry): void {
  while (registry.scopeCircuits.size > registry.maxTrackedScopes) {
    if (evictOneInactiveClosedScope(registry))
      continue
    if (!evictOneExcessInactiveScope(registry))
      return
  }
}

function evictOneInactiveClosedScope(registry: RecoveryRegistry): boolean {
  const oldestClosedEntry = [...registry.scopeCircuits.entries()]
    .find(([, circuit]) =>
      circuit.phase === 'closed'
      && circuit.activeRequests === 0
      && !registry.scopeRecoveries.has(circuit),
    )
  if (!oldestClosedEntry)
    return false
  deleteScopeCircuit(registry, oldestClosedEntry[0], oldestClosedEntry[1])
  return true
}

function evictOneExcessInactiveScope(registry: RecoveryRegistry): boolean {
  const inactiveEntries = [...registry.scopeCircuits.entries()]
    .filter(([, circuit]) => circuit.activeRequests === 0 && !registry.scopeRecoveries.has(circuit))
  if (inactiveEntries.length <= registry.maxTrackedScopes)
    return false
  const entry = inactiveEntries[0]!
  deleteScopeCircuit(registry, entry[0], entry[1])
  return true
}

function deleteScopeCircuit(
  registry: RecoveryRegistry,
  key: string,
  circuit: ScopeCircuit,
): void {
  if (registry.scopeCircuits.get(key) !== circuit)
    return
  registry.scopeCircuits.delete(key)
  registry.globalCircuitAffectedScopeEpochs.delete(circuit)
}

function createScopeKey(accountId: string, endpoint: string, model?: string): string {
  return `${accountId}\u0000${endpoint.slice(0, 128)}\u0000${(model ?? '*').slice(0, 128)}`
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
  options: ResolvedAuthenticatedCopilotFetchOptions,
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
    tokenGeneration: options.ctx.tokens.getStatus().generation,
  })
}

function isAccountContext(value: unknown): value is AccountContext {
  return typeof value === 'object'
    && value !== null
    && 'id' in value
    && 'tokens' in value
    && 'recovery' in value
}
