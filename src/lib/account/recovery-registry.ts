export type CircuitPhase = 'closed' | 'open' | 'half_open'
export type RecoveryFollowerOutcome = 'cancelled' | 'failed' | 'succeeded'

export interface AuthenticatedRequestContext {
  lateRecovery?: RecoveryDeferred
}

export interface ScopeCircuit {
  readonly registry: RecoveryRegistry
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

export interface CircuitReservation {
  globalCircuitEpoch: number
  globalProbe: boolean
  settled: boolean
  scope: ScopeCircuit
  scopeCircuitEpoch: number
  scopeProbe: boolean
}

export interface RecoveryResult {
  recovered: boolean
}

export interface RecoveryDeferred extends RecoveryResult {
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

export interface RecoveryFollowerCohort {
  globalCircuitEpoch: number | undefined
  scope: ScopeCircuit
  scopeCircuitEpoch: number
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

export const INITIAL_CIRCUIT_COOLDOWN_MS = 60_000

export class RecoveryRegistry {
  maxTrackedScopes: number
  readonly scopeCircuits = new Map<string, ScopeCircuit>()
  readonly scopeRecoveries = new Map<ScopeCircuit, RecoveryDeferred>()
  readonly successfulRecoveriesAwaitingFollowers = new Map<RecoveryDeferred, RecoveryFollowerCohort>()
  readonly globalCircuit: ScopeCircuit
  readonly globalCircuitAffectedScopeEpochs = new Map<ScopeCircuit, number>()
  readonly metrics = createRecoveryMetrics()
  globalCircuitAffectedScopesEpoch: number
  reactiveRefreshSuppressedUntil: number | undefined
  reactiveRefreshSuppressedGeneration: number | undefined

  constructor(maxTrackedScopes = 128) {
    this.maxTrackedScopes = maxTrackedScopes
    this.globalCircuit = createRecoveryCircuit(this)
    this.globalCircuitAffectedScopesEpoch = this.globalCircuit.circuitEpoch
  }

  reset(): void {
    this.scopeCircuits.clear()
    this.scopeRecoveries.clear()
    this.successfulRecoveriesAwaitingFollowers.clear()
    this.reactiveRefreshSuppressedGeneration = undefined
    this.reactiveRefreshSuppressedUntil = undefined
    Object.assign(this.globalCircuit, createRecoveryCircuit(this))
    this.globalCircuitAffectedScopeEpochs.clear()
    this.globalCircuitAffectedScopesEpoch = this.globalCircuit.circuitEpoch
    Object.assign(this.metrics, createRecoveryMetrics())
  }
}

export function createRecoveryCircuit(registry: RecoveryRegistry): ScopeCircuit {
  return {
    registry,
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

function createRecoveryMetrics(): CopilotRecoveryMetrics {
  return {
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
}
