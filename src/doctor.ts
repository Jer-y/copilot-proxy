import process from 'node:process'

import { defineCommand } from 'citty'
import consola from 'consola'

import { assertProxyEndpointAvailable } from '~/daemon/service-env'
import { MAX_TIMER_DELAY_MS } from '~/lib/http-timeouts'
import { getBundledModelConfig } from '~/lib/model-config'
import { initializeNodeHttpClient } from '~/lib/proxy'

export const DEFAULT_DOCTOR_ENDPOINT = 'http://127.0.0.1:4399'
export const DEFAULT_DOCTOR_TIMEOUT_MS = 10_000

export type DoctorClient = 'all' | 'claude' | 'codex' | 'openai-sdk'
export type DoctorCheckStatus = 'pass' | 'warn' | 'fail'

export interface DoctorOptions {
  endpoint: string
  client: DoctorClient
  json: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

export interface DoctorCheck {
  id: string
  label: string
  status: DoctorCheckStatus
  message: string
}

export interface DoctorReport {
  status: DoctorCheckStatus
  mode: 'full' | 'legacy-partial'
  endpoint: string
  client: DoctorClient
  checks: DoctorCheck[]
  summary: {
    pass: number
    warn: number
    fail: number
  }
}

export interface DoctorDependencies {
  fetch?: (input: string, init?: RequestInit) => Promise<Response>
  write?: (output: string) => void
  setExitCode?: (exitCode: number) => void
}

export interface DoctorNetworkDependencies {
  assertProxy: (env: NodeJS.ProcessEnv, targets: string[]) => void
  initialize: (proxyEnv: boolean) => void
}

interface JsonProbe {
  response?: Response
  body?: unknown
  failure?: 'timeout' | 'unavailable'
  timeoutMs?: number
}

interface JsonProbeOptions {
  timeoutMs: number
  signal?: AbortSignal
}

const CLIENTS: Array<Exclude<DoctorClient, 'all'>> = [
  'claude',
  'codex',
  'openai-sdk',
]

const TOKEN_LIFECYCLE_REQUIRED_BOOLEAN_FIELDS = [
  'reactiveRefreshInFlight',
  'refreshInFlight',
  'refreshScheduled',
  'tokenAvailable',
] as const

const TOKEN_LIFECYCLE_REQUIRED_COUNTER_FIELDS = [
  'consecutiveRefreshFailures',
  'generation',
] as const

const TOKEN_LIFECYCLE_OPTIONAL_NON_NEGATIVE_NUMBER_FIELDS = [
  'expiresInMs',
  'lastReactiveRefreshAt',
  'lastRefreshAttemptAt',
  'lastRefreshFailureAt',
  'lastRefreshSuccessAt',
  'nextRefreshAt',
] as const

const TOKEN_REFRESH_FAILURE_KINDS = new Set([
  'permanent_auth',
  'transient',
])

const REACTIVE_TOKEN_REFRESH_OUTCOMES = new Set([
  'already_refreshed',
  'cancelled',
  'failed',
  'refreshed',
])

export async function runDoctor(
  options: DoctorOptions,
  dependencies: DoctorDependencies = {},
): Promise<DoctorReport> {
  const endpoint = normalizeEndpoint(options.endpoint)
  const timeoutMs = normalizeDoctorTimeoutMs(options.timeoutMs)
  const probeOptions = { timeoutMs, signal: options.signal }
  const fetchImpl = dependencies.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const probe = await getJson(
    fetchImpl,
    endpointUrl(endpoint, '/diagnostics'),
    probeOptions,
  )

  let report: DoctorReport
  if (!probe.response) {
    const message = probe.failure === 'timeout'
      ? `Diagnostics request timed out after ${timeoutMs}ms.`
      : 'Cannot reach the proxy service.'
    report = buildUnavailableReport(endpoint, options.client, message)
  }
  else if (probe.response.status === 404) {
    report = await buildLegacyReport(
      endpoint,
      options.client,
      fetchImpl,
      probeOptions,
    )
  }
  else if (!probe.response.ok) {
    report = buildUnavailableReport(
      endpoint,
      options.client,
      `Diagnostics request failed with HTTP ${probe.response.status}.`,
    )
  }
  else if (!isRecord(probe.body)) {
    report = buildUnavailableReport(
      endpoint,
      options.client,
      'Diagnostics returned an invalid JSON document.',
    )
  }
  else {
    report = buildFullReport(endpoint, options.client, probe.body)
  }

  const output = options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderPlainReport(report)
  const write = dependencies.write ?? (value => process.stdout.write(value))
  const setExitCode = dependencies.setExitCode ?? ((exitCode) => {
    process.exitCode = exitCode
  })
  write(output)
  setExitCode(report.status === 'fail' ? 1 : 0)

  return report
}

export function configureDoctorNetwork(
  endpoint: string,
  proxyEnv: boolean,
  dependencies: DoctorNetworkDependencies = {
    assertProxy: assertProxyEndpointAvailable,
    initialize: enabled => initializeNodeHttpClient({ proxyEnv: enabled }),
  },
): string {
  const normalizedEndpoint = normalizeEndpoint(endpoint)
  if (proxyEnv)
    dependencies.assertProxy(process.env, [normalizedEndpoint])
  dependencies.initialize(proxyEnv)
  return normalizedEndpoint
}

function buildFullReport(
  endpoint: string,
  client: DoctorClient,
  diagnostics: Record<string, unknown>,
): DoctorReport {
  const readiness = getRecord(diagnostics, 'readiness')
  const profiles = extractModelProfiles(diagnostics.models)
  const checks: DoctorCheck[] = [
    check('service', 'Service', 'pass', 'Diagnostics endpoint is reachable.'),
    buildReadinessCheck(readiness, diagnostics.status),
    buildAuthCheck(readiness?.token),
    buildRecoveryCheck(readiness?.recovery),
    buildConcurrencyCheck(readiness?.concurrency),
    profiles.length > 0
      ? check('models', 'Model availability', 'pass', `${profiles.length} model profile(s) are available. Catalog metadata is routing evidence, not semantic proof.`)
      : check('models', 'Model availability', 'fail', 'No model profiles are available.'),
    ...buildClientChecks(client, profiles, false),
    buildUsageCheck(diagnostics.usage),
  ]

  return createReport(endpoint, client, 'full', checks)
}

async function buildLegacyReport(
  endpoint: string,
  client: DoctorClient,
  fetchImpl: NonNullable<DoctorDependencies['fetch']>,
  probeOptions: JsonProbeOptions,
): Promise<DoctorReport> {
  const [liveness, readinessProbe, modelsProbe, usageProbe] = await Promise.all([
    getJson(fetchImpl, endpointUrl(endpoint, '/livez'), probeOptions),
    getJson(fetchImpl, endpointUrl(endpoint, '/readyz'), probeOptions),
    getJson(fetchImpl, endpointUrl(endpoint, '/v1/models'), probeOptions),
    getJson(fetchImpl, endpointUrl(endpoint, '/usage'), probeOptions),
  ])
  const readiness = isRecord(readinessProbe.body) ? readinessProbe.body : undefined
  const models = extractModelProfiles(
    isRecord(modelsProbe.body) ? modelsProbe.body.data : undefined,
  )
  const checks: DoctorCheck[] = [
    check(
      'diagnostics',
      'Diagnostics mode',
      'warn',
      'The server has no /diagnostics endpoint; results use legacy partial probes.',
    ),
    liveness.response?.ok
      ? check('service', 'Service', 'pass', 'Legacy liveness endpoint is reachable.')
      : check(
          'service',
          'Service',
          'fail',
          legacyProbeFailureMessage(liveness, 'liveness', 'Legacy liveness probe failed.'),
        ),
    buildLegacyReadinessCheck(readinessProbe, readiness),
    buildAuthCheck(readiness?.token),
    buildRecoveryCheck(readiness?.recovery),
    buildConcurrencyCheck(readiness?.concurrency),
    modelsProbe.response?.ok && models.length > 0
      ? check('models', 'Model availability', 'pass', `${models.length} model(s) are listed by the legacy catalog.`)
      : check(
          'models',
          'Model availability',
          'fail',
          legacyProbeFailureMessage(modelsProbe, 'model catalog', 'The legacy model catalog is unavailable or empty.'),
        ),
    ...buildClientChecks(client, models, true),
    usageProbe.response?.ok
      ? check('usage', 'Usage', 'pass', 'The legacy usage endpoint is available.')
      : check(
          'usage',
          'Usage',
          'warn',
          legacyProbeFailureMessage(usageProbe, 'usage', 'Usage information is unavailable.'),
        ),
  ]

  return createReport(endpoint, client, 'legacy-partial', checks)
}

function buildUnavailableReport(
  endpoint: string,
  client: DoctorClient,
  serviceMessage: string,
): DoctorReport {
  const checks: DoctorCheck[] = [
    check('service', 'Service', 'fail', serviceMessage),
    check('readiness', 'Readiness', 'fail', 'Readiness cannot be verified.'),
    check('auth', 'Authentication and token', 'warn', 'Token state was not checked.'),
    check('recovery', 'Recovery', 'warn', 'Recovery state was not checked.'),
    check('concurrency', 'Concurrency', 'warn', 'Concurrency state was not checked.'),
    check('models', 'Model availability', 'fail', 'Model availability cannot be verified.'),
    ...selectedClients(client).map(selected => check(
      `client.${selected}`,
      `Client: ${selected}`,
      'fail',
      'Client model availability cannot be verified.',
    )),
    check('usage', 'Usage', 'warn', 'Usage information was not checked.'),
  ]

  return createReport(endpoint, client, 'full', checks)
}

function buildReadinessCheck(
  readiness: Record<string, unknown> | undefined,
  diagnosticStatus: unknown,
): DoctorCheck {
  const status = typeof readiness?.status === 'string'
    ? readiness.status
    : typeof diagnosticStatus === 'string'
      ? diagnosticStatus
      : undefined

  const warnings = safeReasonCodes(readiness?.warnings)

  if (status === 'ready' && warnings.length > 0)
    return check('readiness', 'Readiness', 'warn', `The proxy is ready with warnings: ${warnings.join(', ')}.`)
  if (status === 'ready')
    return check('readiness', 'Readiness', 'pass', 'The proxy is ready to serve requests.')

  if (status === 'degraded') {
    const reasons = safeReasonCodes(readiness?.reasons)
    const suffix = reasons.length > 0 ? ` Reasons: ${reasons.join(', ')}.` : ''
    return check('readiness', 'Readiness', 'fail', `The proxy is degraded.${suffix}`)
  }

  return check('readiness', 'Readiness', 'warn', 'The diagnostics response did not include readiness status.')
}

function buildLegacyReadinessCheck(
  probe: JsonProbe,
  readiness: Record<string, unknown> | undefined,
): DoctorCheck {
  if (!probe.response) {
    return check(
      'readiness',
      'Readiness',
      'fail',
      legacyProbeFailureMessage(probe, 'readiness', 'The legacy readiness endpoint is unreachable.'),
    )
  }
  if (!probe.response.ok)
    return buildReadinessCheck(readiness, 'degraded')
  if (readiness?.status === 'degraded')
    return buildReadinessCheck(readiness, 'degraded')
  if (readiness?.status === 'ready')
    return buildReadinessCheck(readiness, 'ready')
  return check('readiness', 'Readiness', 'pass', 'The legacy readiness endpoint responded successfully.')
}

function buildAuthCheck(value: unknown): DoctorCheck {
  const token = isRecord(value) ? value : undefined
  if (!token) {
    return check(
      'auth',
      'Authentication and token',
      'fail',
      'Token lifecycle information is missing or incompatible.',
    )
  }

  const invalidFields = invalidTokenLifecycleFields(token)
  if (invalidFields.length > 0) {
    return check(
      'auth',
      'Authentication and token',
      'fail',
      `Token lifecycle information is invalid or incompatible (fields: ${invalidFields.join(', ')}).`,
    )
  }

  if (!token.tokenAvailable) {
    return check(
      'auth',
      'Authentication and token',
      'fail',
      'No Copilot access token is available.',
    )
  }
  if (typeof token.expiresInMs === 'number' && token.expiresInMs <= 0) {
    return check(
      'auth',
      'Authentication and token',
      'fail',
      'The Copilot access token is expired.',
    )
  }

  const refreshActive = token.refreshScheduled === true
    || token.refreshInFlight === true
    || token.reactiveRefreshInFlight === true
  if (!refreshActive) {
    return check(
      'auth',
      'Authentication and token',
      'warn',
      'A token is available, but no refresh lifecycle is active.',
    )
  }

  return check(
    'auth',
    'Authentication and token',
    'pass',
    'A Copilot token is available and its refresh lifecycle is active.',
  )
}

function invalidTokenLifecycleFields(token: Record<string, unknown>): string[] {
  const invalid = new Set<string>()

  for (const field of TOKEN_LIFECYCLE_REQUIRED_BOOLEAN_FIELDS) {
    if (typeof token[field] !== 'boolean')
      invalid.add(field)
  }
  for (const field of TOKEN_LIFECYCLE_REQUIRED_COUNTER_FIELDS) {
    if (safeNonNegativeInteger(token[field]) === undefined)
      invalid.add(field)
  }
  for (const field of TOKEN_LIFECYCLE_OPTIONAL_NON_NEGATIVE_NUMBER_FIELDS) {
    if (Object.hasOwn(token, field) && !isFiniteNonNegativeNumber(token[field]))
      invalid.add(field)
  }

  if (Object.hasOwn(token, 'expiresAt') && !isFinitePositiveNumber(token.expiresAt))
    invalid.add('expiresAt')
  if (
    Object.hasOwn(token, 'lastReactiveRefreshOutcome')
    && (typeof token.lastReactiveRefreshOutcome !== 'string'
      || !REACTIVE_TOKEN_REFRESH_OUTCOMES.has(token.lastReactiveRefreshOutcome))
  ) {
    invalid.add('lastReactiveRefreshOutcome')
  }
  if (
    Object.hasOwn(token, 'lastRefreshFailureKind')
    && (typeof token.lastRefreshFailureKind !== 'string'
      || !TOKEN_REFRESH_FAILURE_KINDS.has(token.lastRefreshFailureKind))
  ) {
    invalid.add('lastRefreshFailureKind')
  }
  if (
    Object.hasOwn(token, 'lastRefreshFailureStatus')
    && (typeof token.lastRefreshFailureStatus !== 'number'
      || !Number.isSafeInteger(token.lastRefreshFailureStatus)
      || token.lastRefreshFailureStatus < 300
      || token.lastRefreshFailureStatus > 599)
  ) {
    invalid.add('lastRefreshFailureStatus')
  }

  const hasExpiresAt = Object.hasOwn(token, 'expiresAt')
  const hasExpiresInMs = Object.hasOwn(token, 'expiresInMs')
  if (hasExpiresAt !== hasExpiresInMs)
    invalid.add('expiresAt/expiresInMs')

  const hasNextRefreshAt = Object.hasOwn(token, 'nextRefreshAt')
  if (
    typeof token.refreshScheduled === 'boolean'
    && token.refreshScheduled !== hasNextRefreshAt
  ) {
    invalid.add('refreshScheduled/nextRefreshAt')
  }

  const generation = safeNonNegativeInteger(token.generation)
  if (
    generation === 0
    && (token.tokenAvailable === true
      || hasExpiresAt
      || Object.hasOwn(token, 'lastRefreshSuccessAt'))
  ) {
    invalid.add('generation')
  }

  const consecutiveFailures = safeNonNegativeInteger(token.consecutiveRefreshFailures)
  const hasFailureAt = Object.hasOwn(token, 'lastRefreshFailureAt')
  const hasFailureKind = Object.hasOwn(token, 'lastRefreshFailureKind')
  if (hasFailureAt !== hasFailureKind)
    invalid.add('lastRefreshFailureAt/lastRefreshFailureKind')
  if ((consecutiveFailures ?? 0) > 0 && (!hasFailureAt || !hasFailureKind))
    invalid.add('consecutiveRefreshFailures')
  if (Object.hasOwn(token, 'lastRefreshFailureStatus') && (!hasFailureAt || !hasFailureKind))
    invalid.add('lastRefreshFailureStatus')

  const failureStatus = token.lastRefreshFailureStatus
  const failureKind = token.lastRefreshFailureKind
  if (
    typeof failureStatus === 'number'
    && Number.isSafeInteger(failureStatus)
    && failureStatus >= 300
    && failureStatus <= 599
    && typeof failureKind === 'string'
  ) {
    if (failureKind === 'permanent_auth' && failureStatus !== 401 && failureStatus !== 403)
      invalid.add('lastRefreshFailureKind/lastRefreshFailureStatus')
    if (failureKind === 'transient' && (failureStatus === 401 || failureStatus === 403))
      invalid.add('lastRefreshFailureKind/lastRefreshFailureStatus')
  }
  if (
    failureKind === 'permanent_auth'
    && failureStatus !== 401
    && failureStatus !== 403
  ) {
    invalid.add('lastRefreshFailureKind/lastRefreshFailureStatus')
  }

  if (token.reactiveRefreshInFlight === true && !Object.hasOwn(token, 'lastReactiveRefreshAt'))
    invalid.add('reactiveRefreshInFlight/lastReactiveRefreshAt')

  return [...invalid]
}

function buildRecoveryCheck(value: unknown): DoctorCheck {
  const recovery = isRecord(value) ? value : undefined
  const circuit = getRecord(recovery, 'globalCircuit')
  const phase = typeof circuit?.phase === 'string' ? circuit.phase : undefined

  switch (phase) {
    case 'closed': {
      const scopes = getRecord(recovery, 'scopes')
      const open = safeNonNegativeInteger(scopes?.open)
      const halfOpen = safeNonNegativeInteger(scopes?.halfOpen)
      const activeScopes: string[] = []
      if (open !== undefined && open > 0)
        activeScopes.push(`${open} open awaiting retry`)
      if (halfOpen !== undefined && halfOpen > 0)
        activeScopes.push(`${halfOpen} half-open probing recovery`)
      if (activeScopes.length > 0) {
        return check(
          'recovery',
          'Recovery',
          'warn',
          `The global upstream recovery circuit is closed, but scoped recovery circuits remain active: ${activeScopes.join(', ')}.`,
        )
      }
      return check('recovery', 'Recovery', 'pass', 'The global upstream recovery circuit is closed.')
    }
    case 'half_open':
      return check('recovery', 'Recovery', 'warn', 'The global upstream recovery circuit is probing recovery.')
    case 'open':
      return check('recovery', 'Recovery', 'fail', 'The global upstream recovery circuit is open.')
    default:
      return check('recovery', 'Recovery', 'warn', 'Recovery circuit information is unavailable.')
  }
}

function buildConcurrencyCheck(value: unknown): DoctorCheck {
  const concurrency = isRecord(value) ? value : undefined
  if (!concurrency) {
    return check('concurrency', 'Concurrency', 'warn', 'Concurrency information is unavailable.')
  }
  if (concurrency.enabled !== undefined && typeof concurrency.enabled !== 'boolean') {
    return check('concurrency', 'Concurrency', 'warn', 'Concurrency information is invalid.')
  }
  if (concurrency.enabled === false) {
    return check('concurrency', 'Concurrency', 'warn', 'The optional upstream concurrency limiter is disabled.')
  }

  const maxConcurrency = safeNonNegativeInteger(concurrency.maxConcurrency)
  const maxQueue = safeNonNegativeInteger(concurrency.maxQueue)
  const active = safeNonNegativeInteger(concurrency.active)
  const queued = safeNonNegativeInteger(concurrency.queued)
  if (
    maxConcurrency === undefined
    || maxConcurrency === 0
    || maxQueue === undefined
    || active === undefined
    || queued === undefined
  ) {
    return check('concurrency', 'Concurrency', 'warn', 'Concurrency information is incomplete.')
  }
  if (active > maxConcurrency || queued > maxQueue) {
    return check('concurrency', 'Concurrency', 'warn', 'Concurrency information is inconsistent.')
  }

  return check(
    'concurrency',
    'Concurrency',
    'pass',
    `The upstream concurrency limiter is ${active}/${maxConcurrency} active; ${queued}/${maxQueue} queued.`,
  )
}

function buildClientChecks(
  client: DoctorClient,
  profiles: Array<Record<string, unknown>>,
  legacy: boolean,
): DoctorCheck[] {
  return selectedClients(client).map((selected) => {
    if (legacy) {
      const count = countLegacyClientCandidates(profiles, selected)
      if (profiles.length === 0) {
        return check(
          `client.${selected}`,
          `Client: ${selected}`,
          'fail',
          `The legacy catalog is empty, so model availability for ${selected} cannot be verified.`,
        )
      }
      if (count === 0) {
        return check(
          `client.${selected}`,
          `Client: ${selected}`,
          'warn',
          `The legacy catalog lists ${profiles.length} model(s), but has no route metadata and bundled policy does not identify a ${selected} candidate; compatibility is unknown.`,
        )
      }
      return check(
        `client.${selected}`,
        `Client: ${selected}`,
        'warn',
        `${count} candidate model(s) were found, but the legacy catalog cannot verify route mode or maturity.`,
      )
    }

    const summary = summarizeClientModels(profiles, selected)
    if (summary.stableDirect.length > 0) {
      return check(
        `client.${selected}`,
        `Client: ${selected}`,
        'pass',
        `${summary.stableDirect.length} catalog-advertised direct model(s): ${formatModelList(summary.stableDirect)}.`,
      )
    }
    const conditional = [...summary.conditional, ...summary.experimental]
    if (conditional.length > 0) {
      return check(
        `client.${selected}`,
        `Client: ${selected}`,
        'warn',
        `Only conditional/translated or experimental model(s) are available: ${formatModelList(conditional)}. Inspect \`copilot-proxy models --client ${selected} --json\` and run the relevant live probe.`,
      )
    }
    return check(
      `client.${selected}`,
      `Client: ${selected}`,
      'fail',
      `No direct or bounded translated route is advertised for ${selected}. Inspect \`copilot-proxy models --client ${selected} --json\` for per-model reason codes.`,
    )
  })
}

function buildUsageCheck(value: unknown): DoctorCheck {
  const usage = isRecord(value) ? value : undefined
  if (usage?.status === 'available' || usage?.available === true)
    return check('usage', 'Usage', 'pass', 'Copilot usage information is available.')
  if (usage?.status === 'unavailable' || usage?.available === false)
    return check('usage', 'Usage', 'warn', 'Copilot usage information is unavailable.')
  return check('usage', 'Usage', 'warn', 'Usage status is missing from diagnostics.')
}

function summarizeClientModels(
  profiles: Array<Record<string, unknown>>,
  client: Exclude<DoctorClient, 'all'>,
): {
  conditional: string[]
  experimental: string[]
  stableDirect: string[]
} {
  const routeNames = client === 'claude'
    ? ['anthropicMessages', 'anthropic-messages']
    : client === 'codex'
      ? ['responsesHttp', 'responsesWebSocket', 'responses-http', 'responses-websocket']
      : ['chatCompletions', 'responsesHttp', 'chat-completions', 'responses-http']

  const stableDirect: string[] = []
  const conditional: string[] = []
  const experimental: string[] = []

  for (const profile of profiles) {
    const routes = getRecord(profile, 'routes')
    const capabilities = routeNames
      .map(routeName => routes?.[routeName])
      .filter(isRecord)
    const id = safeModelId(profile.id)
    if (!id)
      continue

    if (capabilities.some(capability => capability.mode === 'direct' && (capability.maturity === 'stable' || capability.maturity === undefined)))
      stableDirect.push(id)
    else if (capabilities.some(capability => capability.maturity === 'experimental'))
      experimental.push(id)
    else if (capabilities.some(capability => capability.mode !== 'unsupported'))
      conditional.push(id)
  }

  return {
    conditional,
    experimental,
    stableDirect,
  }
}

function countLegacyClientCandidates(
  models: Array<Record<string, unknown>>,
  client: Exclude<DoctorClient, 'all'>,
): number {
  return models.filter((model) => {
    const summary = summarizeClientModels([model], client)
    if (summary.stableDirect.length + summary.conditional.length + summary.experimental.length > 0)
      return true
    const modelId = safeModelId(model.id)
    if (!modelId)
      return false
    const supportedApis = getBundledModelConfig(modelId).supportedApis
    if (client === 'claude')
      return supportedApis.includes('anthropic-messages')
    if (client === 'codex')
      return supportedApis.includes('responses')
    return supportedApis.includes('chat-completions') || supportedApis.includes('responses')
  }).length
}

function safeModelId(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const trimmed = value.trim()
  return /^[\w./:-]{1,120}$/.test(trimmed) ? trimmed : undefined
}

function formatModelList(models: string[]): string {
  const visible = models.slice(0, 5)
  const suffix = models.length > visible.length ? ` (+${models.length - visible.length} more)` : ''
  return `${visible.join(', ')}${suffix}`
}

function extractModelProfiles(value: unknown): Array<Record<string, unknown>> {
  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.profiles)
      ? value.profiles
      : isRecord(value) && Array.isArray(value.data)
        ? value.data
        : []
  return candidate.filter(isRecord)
}

function createReport(
  endpoint: string,
  client: DoctorClient,
  mode: DoctorReport['mode'],
  checks: DoctorCheck[],
): DoctorReport {
  const summary = {
    pass: checks.filter(item => item.status === 'pass').length,
    warn: checks.filter(item => item.status === 'warn').length,
    fail: checks.filter(item => item.status === 'fail').length,
  }
  const status: DoctorCheckStatus = summary.fail > 0
    ? 'fail'
    : summary.warn > 0
      ? 'warn'
      : 'pass'

  return { status, mode, endpoint, client, checks, summary }
}

function renderPlainReport(report: DoctorReport): string {
  const mode = report.mode === 'full' ? 'full diagnostics' : 'legacy/partial probes'
  const lines = [
    'copilot-proxy doctor',
    '',
    `Endpoint: ${report.endpoint}`,
    `Client: ${report.client}`,
    `Mode: ${mode}`,
    '',
    ...report.checks.map(item => `[${item.status.toUpperCase()}] ${item.label}: ${item.message}`),
    '',
    `Summary: ${report.status.toUpperCase()} (${report.summary.pass} passed, ${report.summary.warn} warnings, ${report.summary.fail} failed)`,
  ]
  return `${lines.join('\n')}\n`
}

function selectedClients(client: DoctorClient): Array<Exclude<DoctorClient, 'all'>> {
  return client === 'all' ? CLIENTS : [client]
}

function check(
  id: string,
  label: string,
  status: DoctorCheckStatus,
  message: string,
): DoctorCheck {
  return { id, label, status, message }
}

async function getJson(
  fetchImpl: NonNullable<DoctorDependencies['fetch']>,
  url: string,
  options: JsonProbeOptions,
): Promise<JsonProbe> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal

  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal,
    })
    let body: unknown
    try {
      body = await response.json()
    }
    catch (error) {
      if (signal.aborted)
        throw error
      body = undefined
    }
    return { response, body }
  }
  catch {
    return timeoutSignal.aborted && !options.signal?.aborted
      ? { failure: 'timeout', timeoutMs: options.timeoutMs }
      : { failure: 'unavailable' }
  }
}

function legacyProbeFailureMessage(
  probe: JsonProbe,
  label: string,
  fallback: string,
): string {
  return probe.failure === 'timeout'
    ? `The legacy ${label} probe timed out after ${probe.timeoutMs}ms.`
    : fallback
}

function normalizeDoctorTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_DOCTOR_TIMEOUT_MS
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new TypeError(`--timeout-ms must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  return timeoutMs
}

function normalizeEndpoint(input: string): string {
  let endpoint: URL
  try {
    endpoint = new URL(input)
  }
  catch {
    throw new TypeError('--endpoint must be a valid HTTP(S) URL')
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new TypeError('--endpoint must use http: or https:')
  if (endpoint.username || endpoint.password)
    throw new TypeError('--endpoint must not contain credentials')

  endpoint.search = ''
  endpoint.hash = ''
  return endpoint.toString().replace(/\/+$/, '')
}

function endpointUrl(endpoint: string, pathname: string): string {
  return new URL(pathname.replace(/^\/+/, ''), `${endpoint}/`).toString()
}

function getRecord(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const nested = value?.[key]
  return isRecord(nested) ? nested : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return value.filter((item): item is string =>
    typeof item === 'string' && /^[a-z][\w-]{0,79}$/i.test(item),
  )
}

function safeNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseClient(value: string): DoctorClient {
  if (value === 'all' || value === 'claude' || value === 'codex' || value === 'openai-sdk')
    return value
  throw new TypeError('--client must be one of: all, claude, codex, openai-sdk')
}

export const doctor = defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check proxy health and client model availability',
  },
  args: {
    'endpoint': {
      type: 'string',
      default: DEFAULT_DOCTOR_ENDPOINT,
      description: 'Base URL of the running copilot-proxy service',
    },
    'client': {
      type: 'string',
      default: 'all',
      description: 'Client to verify: all, claude, codex, or openai-sdk',
    },
    'timeout-ms': {
      type: 'string',
      default: String(DEFAULT_DOCTOR_TIMEOUT_MS),
      description: 'Maximum time in milliseconds for each diagnostics request',
    },
    'json': {
      type: 'boolean',
      default: false,
      description: 'Output the doctor report as JSON',
    },
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Route the diagnostics request through configured HTTP(S)_PROXY/NO_PROXY variables',
    },
  },
  async run({ args }) {
    const previousConsolaStdout = consola.options.stdout
    if (args.json)
      consola.options.stdout = process.stderr
    try {
      const endpoint = configureDoctorNetwork(args.endpoint, args['proxy-env'])
      await runDoctor({
        endpoint,
        client: parseClient(args.client),
        json: args.json,
        timeoutMs: normalizeDoctorTimeoutMs(Number(args['timeout-ms'])),
      })
    }
    finally {
      consola.options.stdout = previousConsolaStdout
    }
  },
})
