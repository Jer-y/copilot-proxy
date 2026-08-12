import type { Buffer } from 'node:buffer'
import type { AccountDescriptor, AccountsConfiguration, ClientSurface } from './types'

import type { AccountType } from '~/lib/cli-validators'
import fs from 'node:fs'
import process from 'node:process'

import { writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory } from '~/daemon/atomic-file'
import { loadLegacyServiceConfig } from '~/daemon/config'
import { loadInstalledNativeServiceCommands, probeCopilotProxyServer, resolveNativeServiceReadinessHost, waitForNativeServiceReadiness } from '~/daemon/native-service'
import { loadNativeServiceEnvironment } from '~/daemon/service-env'
import { APPLIED_NATIVE_SERVICE_DATA_DIR_ENV, loadNativeServiceInstallState, sameDataDirectory } from '~/daemon/service-install-state'
import { PATHS } from '~/lib/paths'

import { verifyAccountToken } from './auth'
import { boundAccountIdForRequiredRoute } from './capabilities'
import { acquireAccountsLock, acquireAccountStateLock, clearStaleRuntimeLock, inspectRuntimeLock } from './lock'
import { AccountRegistry } from './registry'
import {
  accountTokenPath,
  MAX_ACCOUNTS,
  readAccountsConfiguration,
  validateConfigurationReferences,
  writeAccountsConfiguration,
  writeAccountToken,
} from './store'
import { validateAccountsOffline } from './validation'

export class AccountTransactionError extends Error {
  readonly exitCode: 1 | 2

  constructor(message: string, exitCode: 1 | 2 = 1, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AccountTransactionError'
    this.exitCode = exitCode
  }
}

export async function assertAccountMutationAllowed(): Promise<'native' | 'none'> {
  const state = await resolveRuntimeMutationState()
  return state.mode === 'none' ? 'none' : 'native'
}

export async function addAccount(input: {
  accountType: AccountType
  id: string
  token: string
}): Promise<AccountsConfiguration> {
  const verified = await verifyAccountToken(input.accountType, input.token)
  return await mutateAccounts({
    operation: `add account ${input.id}`,
    mutate(configuration) {
      const current = configuration ?? createEmptyConfiguration(input.id)
      if (current.accounts.some(account => account.id === input.id))
        throw new Error(`Account ${input.id} already exists`)
      if (current.accounts.some(account => account.githubUserId === verified.userId))
        throw new Error(`GitHub identity ${verified.login} is already configured`)
      if (current.accounts.length >= MAX_ACCOUNTS)
        throw new Error(`At most ${MAX_ACCOUNTS} Copilot accounts may be configured`)
      return {
        configuration: {
          ...current,
          revision: current.revision + 1,
          accounts: [...current.accounts, {
            id: input.id,
            accountType: input.accountType,
            githubLogin: verified.login,
            githubUserId: verified.userId,
          }],
        },
        offlineValidation: {
          accountIds: [input.id],
          mode: 'always',
        },
        readyAccountProbes: [input.id],
        tokenWrites: [{ accountId: input.id, token: input.token }],
      }
    },
  })
}

export async function authenticateExistingAccount(input: {
  id: string
  token: string
}): Promise<void> {
  await mutateAccounts({
    operation: `authenticate account ${input.id}`,
    mutate(configuration) {
      const current = requirePresentConfiguration(configuration)
      requireDescriptor(current, input.id)
      return {
        configuration: current,
        offlineValidation: {
          accountIds: [input.id],
          criticalRoutes: true,
          mode: 'always',
        },
        readyAccountProbes: [input.id],
        tokenWrites: [{ accountId: input.id, token: input.token }],
      }
    },
  })
}

export async function setDefaultAccount(id: string): Promise<AccountsConfiguration> {
  return await mutateAccounts({
    operation: `set default account ${id}`,
    mutate(configuration) {
      const current = requirePresentConfiguration(configuration)
      requireDescriptor(current, id)
      return {
        configuration: {
          ...current,
          revision: current.revision + 1,
          defaultAccount: id,
        },
        offlineValidation: {
          criticalRoutes: true,
          mode: 'without-runtime',
        },
        readyAccountProbes: [id],
      }
    },
  })
}

export async function setAccountMaxConcurrency(
  id: string,
  maxConcurrency: number | undefined,
): Promise<AccountsConfiguration> {
  if (maxConcurrency !== undefined && (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0))
    throw new Error('Account max concurrency must be a positive safe integer')
  return await mutateAccounts({
    operation: `${maxConcurrency === undefined ? 'clear' : 'set'} max concurrency for account ${id}`,
    mutate(configuration) {
      const current = requirePresentConfiguration(configuration)
      const descriptor = requireDescriptor(current, id)
      if (descriptor.maxConcurrency === maxConcurrency) {
        throw new Error(
          maxConcurrency === undefined
            ? `Account ${id} has no max concurrency override`
            : `Account ${id} max concurrency is already ${maxConcurrency}`,
        )
      }
      return {
        configuration: {
          ...current,
          revision: current.revision + 1,
          accounts: current.accounts.map((account) => {
            if (account.id !== id)
              return account
            if (maxConcurrency !== undefined)
              return { ...account, maxConcurrency }
            const { maxConcurrency: _removed, ...withoutLimit } = account
            return withoutLimit
          }),
        },
        readyAccountProbes: [id],
      }
    },
  })
}

export async function setRequiredAccountRoute(
  surface: ClientSurface,
  model: string,
): Promise<AccountsConfiguration> {
  if (!model)
    throw new Error('Required route model must not be empty')
  return await mutateAccounts({
    operation: `set required route ${surface}:${model}`,
    mutate(configuration) {
      const current = requirePresentConfiguration(configuration)
      if (current.requiredRoutes.some(route => route.surface === surface && route.model === model))
        throw new Error(`Required route ${surface}:${model} already exists`)
      return {
        configuration: {
          ...current,
          revision: current.revision + 1,
          requiredRoutes: [...current.requiredRoutes, { surface, model }],
        },
        offlineValidation: {
          criticalRoutes: true,
          mode: 'without-runtime',
        },
      }
    },
  })
}

export async function removeRequiredAccountRoute(
  surface: ClientSurface,
  model: string,
): Promise<AccountsConfiguration> {
  return await mutateAccounts({
    operation: `remove required route ${surface}:${model}`,
    mutate(configuration) {
      const current = requirePresentConfiguration(configuration)
      if (!current.requiredRoutes.some(route => route.surface === surface && route.model === model))
        throw new Error(`Required route ${surface}:${model} does not exist`)
      return {
        configuration: {
          ...current,
          revision: current.revision + 1,
          requiredRoutes: current.requiredRoutes.filter(route => route.surface !== surface || route.model !== model),
        },
      }
    },
  })
}

export async function setAccountRoute(
  match: string,
  accountId: string,
): Promise<AccountsConfiguration> {
  if (!match)
    throw new Error('Route glob must not be empty')
  return await mutateAccounts({
    operation: `set route ${match}`,
    mutate(configuration) {
      const current = requirePresentConfiguration(configuration)
      requireDescriptor(current, accountId)
      const rule = { match, account: accountId }
      // Route evaluation is first-match-wins, so the most recently set rule
      // must move to the front even when it replaces an existing exact match.
      const routes = [rule, ...current.routes.filter(route => route.match !== match)]
      return {
        configuration: { ...current, revision: current.revision + 1, routes },
        offlineValidation: {
          accountIds: [accountId],
          criticalRoutes: true,
          mode: 'without-runtime',
        },
        readyAccountProbes: [accountId],
      }
    },
  })
}

export async function removeAccountRoute(match: string): Promise<AccountsConfiguration> {
  return await mutateAccounts({
    operation: `remove route ${match}`,
    mutate(configuration) {
      const current = requirePresentConfiguration(configuration)
      if (!current.routes.some(route => route.match === match))
        throw new Error(`Route ${match} does not exist`)
      const next = {
        ...current,
        revision: current.revision + 1,
        routes: current.routes.filter(route => route.match !== match),
      }
      return {
        configuration: next,
        offlineValidation: {
          criticalRoutes: true,
          mode: 'without-runtime',
        },
      }
    },
  })
}

export async function removeAccount(id: string): Promise<AccountsConfiguration> {
  return await mutateAccounts({
    operation: `remove account ${id}`,
    mutate(configuration) {
      const current = requirePresentConfiguration(configuration)
      requireDescriptor(current, id)
      const references = findAccountReferences(current, id)
      if (references.length > 0)
        throw new Error(`Account ${id} is still referenced by: ${references.join(', ')}`)
      if (current.accounts.length === 1)
        throw new Error('Cannot remove the only configured account')
      return {
        configuration: {
          ...current,
          revision: current.revision + 1,
          accounts: current.accounts.filter(account => account.id !== id),
        },
        absentAccountProbes: [id],
        tokenDeletes: [id],
      }
    },
  })
}

interface MutationResult {
  absentAccountProbes?: string[]
  configuration: AccountsConfiguration
  offlineValidation?: {
    accountIds?: string[]
    criticalRoutes?: boolean
    mode: 'always' | 'without-runtime'
  }
  readyAccountProbes?: string[]
  tokenDeletes?: string[]
  tokenWrites?: Array<{ accountId: string, token: string }>
}

async function mutateAccounts(options: {
  operation: string
  mutate: (configuration: AccountsConfiguration | undefined) => MutationResult
}): Promise<AccountsConfiguration> {
  const accountsLock = await acquireAccountsLock()
  let configSnapshot: FileSnapshot | undefined
  let current: AccountsConfiguration | undefined
  let diskMayBeMutated = false
  let rollbackRuntimeBaseline: RuntimeRollbackBaseline | undefined
  let runtimeState: RuntimeMutationState | undefined
  const tokenSnapshots = new Map<string, FileSnapshot>()
  try {
    runtimeState = await resolveRuntimeMutationState()
    const runtime = runtimeState.mode
    current = readAccountsConfiguration()
    const result = options.mutate(current)
    validateConfigurationReferences(result.configuration)
    if (runtime === 'native') {
      rollbackRuntimeBaseline = await captureRuntimeRollbackBaseline(
        current,
        affectedAccountIds(current, result),
      )
      if (!rollbackRuntimeBaseline) {
        throw new Error(
          'The running native service has not loaded the current accounts.json revision; restart it before modifying accounts',
        )
      }
    }
    await validateMutationOffline(result, runtime)

    configSnapshot = snapshotFile(PATHS.ACCOUNTS_CONFIG)
    for (const write of result.tokenWrites ?? [])
      tokenSnapshots.set(write.accountId, snapshotFile(accountTokenPath(write.accountId)))
    for (const accountId of result.tokenDeletes ?? [])
      tokenSnapshots.set(accountId, snapshotFile(accountTokenPath(accountId)))

    const stateLock = await acquireAccountStateLock()
    try {
      const publicationRuntime = await resolveRuntimeMutationState()
      if (!sameRuntimeMutationState(runtimeState, publicationRuntime)) {
        throw new Error(
          'The proxy runtime changed during account validation; no files were published. Retry the command.',
        )
      }
      // Publish referenced secrets first. A process crash before accounts.json
      // is renamed can leave only an ignored orphan token; a published config
      // can never point at a token that has not reached its final path.
      for (const write of result.tokenWrites ?? []) {
        diskMayBeMutated = true
        writeAccountToken(write.accountId, write.token)
      }
      diskMayBeMutated = true
      writeAccountsConfiguration(result.configuration)
    }
    finally {
      stateLock.release()
    }

    if (requiresNativeRestart(runtimeState.mode)) {
      const ready = await restartAndProbe({
        absentAccountIds: result.absentAccountProbes,
        configuration: result.configuration,
        readyAccountIds: result.readyAccountProbes,
        requireGlobalReady: true,
      })
      if (!ready)
        throw new Error('Native service did not validate the new account configuration')
    }

    if ((result.tokenDeletes?.length ?? 0) > 0) {
      const deleteLock = await acquireAccountStateLock()
      try {
        for (const accountId of result.tokenDeletes ?? []) {
          diskMayBeMutated = true
          fs.rmSync(accountTokenPath(accountId), { force: true })
        }
      }
      finally {
        deleteLock.release()
      }
    }
    return result.configuration
  }
  catch (error) {
    if (!diskMayBeMutated) {
      throw error instanceof AccountTransactionError
        ? error
        : new AccountTransactionError(`${options.operation} failed: ${errorMessage(error)}`, 1, { cause: error })
    }

    const restored = configSnapshot !== undefined
      && await restoreMutationSnapshots(configSnapshot, tokenSnapshots)
    if (!restored) {
      throw new AccountTransactionError(
        `Error: ${options.operation} failed and disk rollback also failed.\n  Disk state: unknown; inspect accounts.json and tokens/.\n  Runtime state: unknown; run copilot-proxy status before restarting.`,
        2,
        { cause: error },
      )
    }

    if (runtimeState && requiresNativeRestart(runtimeState.mode)) {
      const rollbackRestarted = await restartAndProbe({
        absentAccountIds: rollbackRuntimeBaseline?.accounts
          .filter(account => account.state === 'absent')
          .map(account => account.id),
        configuration: current,
        knownAccountIds: rollbackRuntimeBaseline?.accounts
          .filter(account => account.state === 'degraded')
          .map(account => account.id),
        readyAccountIds: rollbackRuntimeBaseline?.accounts
          .filter(account => account.state === 'ready')
          .map(account => account.id),
        requiredRoutes: rollbackRuntimeBaseline?.requiredRoutes,
        requireGlobalReady: rollbackRuntimeBaseline?.globalReady ?? false,
      }).catch(() => false)
      if (!rollbackRestarted) {
        throw new AccountTransactionError(
          `Error: ${options.operation} failed and the rollback restart also failed.\n  Disk state: restored to the pre-operation configuration and token files.\n  Runtime state: unknown; run copilot-proxy status and, if needed, copilot-proxy restart.`,
          2,
          { cause: error },
        )
      }
    }
    throw new AccountTransactionError(`${options.operation} failed: ${errorMessage(error)}`, 1, { cause: error })
  }
  finally {
    accountsLock.release()
  }
}

async function validateMutationOffline(
  result: MutationResult,
  runtime: RuntimeMutationMode,
): Promise<void> {
  const validation = result.offlineValidation
  if (!validation)
    return
  if (validation.mode === 'without-runtime' && runtime === 'native')
    return

  const tokenOverrides = new Map(
    (result.tokenWrites ?? []).map(write => [write.accountId, write.token]),
  )
  await validateAccountsOffline(result.configuration, {
    accountIds: validation.accountIds,
    tokenOverrides,
    validateCriticalRoutes: validation.criticalRoutes,
  })
}

function affectedAccountIds(
  before: AccountsConfiguration | undefined,
  result: MutationResult,
): string[] {
  const after = result.configuration
  const accountIds = new Set([
    ...(result.absentAccountProbes ?? []),
    ...(result.readyAccountProbes ?? []),
    after.defaultAccount,
    ...(before ? [before.defaultAccount] : []),
  ])

  const descriptorIds = new Set([
    ...(before?.accounts.map(account => account.id) ?? []),
    ...after.accounts.map(account => account.id),
  ])
  for (const accountId of descriptorIds) {
    const previous = before?.accounts.find(account => account.id === accountId)
    const next = after.accounts.find(account => account.id === accountId)
    if (JSON.stringify(previous) !== JSON.stringify(next))
      accountIds.add(accountId)
  }

  if (JSON.stringify(before?.routes ?? []) !== JSON.stringify(after.routes)) {
    for (const route of before?.routes ?? [])
      accountIds.add(route.account)
    for (const route of after.routes)
      accountIds.add(route.account)
  }

  const beforeRegistry = before ? new AccountRegistry(before) : undefined
  const afterRegistry = new AccountRegistry(after)
  if (beforeRegistry) {
    for (const route of before?.requiredRoutes ?? [])
      accountIds.add(boundAccountIdForRequiredRoute(beforeRegistry, route))
  }
  for (const route of after.requiredRoutes)
    accountIds.add(boundAccountIdForRequiredRoute(afterRegistry, route))

  return [...accountIds]
}

type RuntimeMutationMode = 'legacy-native' | 'none' | 'native'

interface RuntimeMutationState {
  instanceId?: string
  mode: RuntimeMutationMode
}

async function resolveRuntimeMutationState(): Promise<RuntimeMutationState> {
  const inspection = inspectRuntimeLock()
  if (inspection.state === 'stale') {
    clearStaleRuntimeLock()
    return await resolveRuntimeMutationState()
  }
  if (inspection.state === 'unknown')
    throw new Error('Cannot determine whether copilot-proxy is running; inspect runtime.lock manually')
  if (inspection.state === 'absent') {
    if (await isInstalledNativeServiceRunning())
      return { mode: 'legacy-native' }
    return { mode: 'none' }
  }
  if (!inspection.metadata.nativeService) {
    throw new Error(`A foreground copilot-proxy process is running (pid ${inspection.metadata.pid}, port ${inspection.metadata.port}); stop it before modifying accounts`)
  }
  return { instanceId: inspection.metadata.instanceId, mode: 'native' }
}

export async function isInstalledNativeServiceRunning(
  loadCommands: typeof loadInstalledNativeServiceCommands = loadInstalledNativeServiceCommands,
  installState: ReturnType<typeof loadNativeServiceInstallState> = shouldInspectInstalledNativeServiceState()
    ? loadNativeServiceInstallState()
    : undefined,
  appDir = PATHS.APP_DIR,
): Promise<boolean> {
  if (!installState || !sameDataDirectory(installState.dataDir, appDir))
    return false
  const nativeService = await loadCommands()
  return nativeService?.captureAutoStartState().running === true
}

function shouldInspectInstalledNativeServiceState(): boolean {
  const appliedDataDir = process.env[APPLIED_NATIVE_SERVICE_DATA_DIR_ENV]?.trim()
  return Boolean(appliedDataDir && sameDataDirectory(appliedDataDir, PATHS.APP_DIR))
}

function sameRuntimeMutationState(
  before: RuntimeMutationState,
  after: RuntimeMutationState,
): boolean {
  return before.mode === after.mode
    && (before.mode !== 'native' || before.instanceId === after.instanceId)
}

function requiresNativeRestart(mode: RuntimeMutationMode): boolean {
  return mode === 'legacy-native' || mode === 'native'
}

interface RuntimeProbeExpectation {
  absentAccountIds?: string[]
  configuration: AccountsConfiguration | undefined
  knownAccountIds?: string[]
  readyAccountIds?: string[]
  requiredRoutes?: RuntimeRequiredRouteBaseline[]
  requireGlobalReady: boolean
}

interface RuntimeRollbackBaseline {
  accounts: Array<{
    id: string
    state: 'absent' | 'degraded' | 'ready'
  }>
  globalReady: boolean
  requiredRoutes: RuntimeRequiredRouteBaseline[]
}

interface RuntimeRequiredRouteBaseline {
  accountId: string
  model: string
  ready: boolean
  surface: string
}

async function restartAndProbe(expectation: RuntimeProbeExpectation): Promise<boolean> {
  const nativeService = await loadInstalledNativeServiceCommands()
  if (!nativeService || !nativeService.restartAutoStartService())
    return false

  const globalReady = await probeInstalledService(
    '/readyz',
    readinessValidator(
      expectation.configuration,
      expectation.requireGlobalReady ? 'ready' : 'loaded',
      expectation.requiredRoutes,
    ),
  )
  if (!globalReady)
    return false

  for (const accountId of expectation.readyAccountIds ?? []) {
    const ready = await probeInstalledService(
      `/readyz?account=${encodeURIComponent(accountId)}`,
      readinessValidator(expectation.configuration, 'ready', undefined, accountId),
    )
    if (!ready)
      return false
  }

  for (const accountId of expectation.absentAccountIds ?? []) {
    const absent = await probeInstalledService(
      `/readyz?account=${encodeURIComponent(accountId)}`,
      readinessValidator(expectation.configuration, 'absent', undefined, accountId),
    )
    if (!absent)
      return false
  }

  for (const accountId of expectation.knownAccountIds ?? []) {
    const known = await probeInstalledService(
      `/readyz?account=${encodeURIComponent(accountId)}`,
      readinessValidator(expectation.configuration, 'known', undefined, accountId),
    )
    if (!known)
      return false
  }
  return true
}

async function captureRuntimeRollbackBaseline(
  configuration: AccountsConfiguration | undefined,
  accountIds: string[],
): Promise<RuntimeRollbackBaseline | undefined> {
  let globalBaseline: Omit<RuntimeRollbackBaseline, 'accounts'> | undefined
  const globalLoaded = await probeInstalledService(
    '/readyz',
    (statusCode, body) => {
      const value = parseReadinessBody(body)
      if (!value || !matchesConfiguration(value.configuration, configuration))
        return false
      if (statusCode !== 200 && statusCode !== 503)
        return false
      const requiredRoutes = parseRequiredRouteBaselines(value.requiredRoutes)
      if (!requiredRoutes)
        return false
      globalBaseline = {
        globalReady: statusCode === 200 && value.status === 'ready',
        requiredRoutes,
      }
      return true
    },
  )
  if (!globalLoaded || !globalBaseline)
    return undefined

  const accounts: RuntimeRollbackBaseline['accounts'] = []
  for (const accountId of accountIds) {
    let state: RuntimeRollbackBaseline['accounts'][number]['state'] | undefined
    const captured = await probeInstalledService(
      `/readyz?account=${encodeURIComponent(accountId)}`,
      (statusCode, body) => {
        const value = parseReadinessBody(body)
        if (!value || !matchesConfiguration(value.configuration, configuration))
          return false
        if (statusCode === 200 && value.status === 'ready') {
          if (!matchesKnownAccount(value.account, accountId))
            return false
          state = 'ready'
          return true
        }
        if (statusCode !== 503 || !Array.isArray(value.reasons))
          return false
        if (value.reasons.includes('unknown_account')) {
          if (value.account !== accountId)
            return false
          state = 'absent'
        }
        else {
          if (!matchesKnownAccount(value.account, accountId))
            return false
          state = 'degraded'
        }
        return true
      },
    )
    if (!captured || !state)
      return undefined
    accounts.push({ id: accountId, state })
  }

  return { accounts, ...globalBaseline }
}

function readinessValidator(
  configuration: AccountsConfiguration | undefined,
  expectation: 'absent' | 'known' | 'loaded' | 'ready',
  requiredRoutes?: RuntimeRequiredRouteBaseline[],
  expectedAccountId?: string,
): (statusCode: number, body: string) => boolean {
  return (statusCode, body) => isExpectedAccountReadinessResponse(
    statusCode,
    body,
    configuration,
    expectation,
    requiredRoutes,
    expectedAccountId,
  )
}

export function isExpectedAccountReadinessResponse(
  statusCode: number,
  body: string,
  configuration: AccountsConfiguration | undefined,
  expectation: 'absent' | 'known' | 'loaded' | 'ready',
  requiredRoutes: RuntimeRequiredRouteBaseline[] = [],
  expectedAccountId?: string,
): boolean {
  const value = parseReadinessBody(body)
  if (!value || !matchesConfiguration(value.configuration, configuration))
    return false
  if (!matchesRequiredRouteBaselines(value.requiredRoutes, requiredRoutes))
    return false
  if (expectation === 'loaded')
    return statusCode === 200 || statusCode === 503
  if (expectation === 'ready') {
    return statusCode === 200
      && value.status === 'ready'
      && (expectedAccountId === undefined || matchesKnownAccount(value.account, expectedAccountId))
  }
  if (expectation === 'known') {
    return (statusCode === 200 || statusCode === 503)
      && !(Array.isArray(value.reasons) && value.reasons.includes('unknown_account'))
      && (expectedAccountId === undefined || matchesKnownAccount(value.account, expectedAccountId))
  }
  return statusCode === 503
    && Array.isArray(value.reasons)
    && value.reasons.includes('unknown_account')
    && (expectedAccountId === undefined || value.account === expectedAccountId)
}

function matchesKnownAccount(value: unknown, expectedAccountId: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  return (value as Record<string, unknown>).id === expectedAccountId
}

function matchesRequiredRouteBaselines(
  value: unknown,
  baselines: RuntimeRequiredRouteBaseline[],
): boolean {
  if (baselines.length === 0)
    return true
  const current = parseRequiredRouteBaselines(value)
  if (!current)
    return false
  const unmatched = [...current]
  for (const baseline of baselines) {
    const index = unmatched.findIndex(route => route.surface === baseline.surface
      && route.model === baseline.model
      && route.accountId === baseline.accountId
      && (!baseline.ready || route.ready))
    if (index === -1)
      return false
    unmatched.splice(index, 1)
  }
  return true
}

function parseRequiredRouteBaselines(value: unknown): RuntimeRequiredRouteBaseline[] | undefined {
  if (!Array.isArray(value))
    return undefined
  const routes: RuntimeRequiredRouteBaseline[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      return undefined
    const route = item as Record<string, unknown>
    if (
      typeof route.accountId !== 'string'
      || typeof route.model !== 'string'
      || typeof route.ready !== 'boolean'
      || typeof route.surface !== 'string'
    ) {
      return undefined
    }
    routes.push({
      accountId: route.accountId,
      model: route.model,
      ready: route.ready,
      surface: route.surface,
    })
  }
  return routes
}

function matchesConfiguration(
  value: unknown,
  configuration: AccountsConfiguration | undefined,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const record = value as Record<string, unknown>
  return record.explicit === (configuration !== undefined)
    && record.revision === (configuration?.revision ?? null)
}

function parseReadinessBody(body: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(body) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  }
  catch {
    return undefined
  }
}

async function probeInstalledService(
  path: string,
  validate: (statusCode: number, body: string) => boolean,
): Promise<boolean> {
  const installState = loadNativeServiceInstallState()
  const config = installState?.config ?? loadLegacyServiceConfig()
  if (!config)
    return false
  const environment = loadNativeServiceEnvironment({
    proxyEnv: config.proxyEnv,
    targetEnv: { ...process.env },
    filePath: PATHS.NATIVE_SERVICE_ENV,
  })
  const requestHost = resolveNativeServiceReadinessHost(config.host, environment)
  if (!requestHost)
    return false
  return await waitForNativeServiceReadiness(config, {
    expectedInstanceToken: installState?.instanceToken,
    requestHost,
    probe: () => probeCopilotProxyServer(
      config.host,
      config.port,
      installState?.instanceToken,
      requestHost,
      { maxBodyBytes: 64 * 1024, path, validate },
    ),
  })
}

async function restoreMutationSnapshots(
  configSnapshot: FileSnapshot,
  tokenSnapshots: ReadonlyMap<string, FileSnapshot>,
): Promise<boolean> {
  let stateLock: Awaited<ReturnType<typeof acquireAccountStateLock>> | undefined
  try {
    stateLock = await acquireAccountStateLock()
    // Restore existing secrets before the old config can reference them again.
    for (const [accountId, snapshot] of tokenSnapshots) {
      if (snapshot.exists)
        restoreSnapshot(accountTokenPath(accountId), snapshot)
    }
    restoreSnapshot(PATHS.ACCOUNTS_CONFIG, configSnapshot)
    // Tokens created by the failed candidate are now unreferenced and can be
    // removed after the old configuration has been restored.
    for (const [accountId, snapshot] of tokenSnapshots) {
      if (!snapshot.exists)
        restoreSnapshot(accountTokenPath(accountId), snapshot)
    }
    return true
  }
  catch {
    return false
  }
  finally {
    stateLock?.release()
  }
}

function findAccountReferences(configuration: AccountsConfiguration, id: string): string[] {
  const references: string[] = []
  if (configuration.defaultAccount === id)
    references.push('defaultAccount')
  configuration.routes.forEach((route, index) => {
    if (route.account === id)
      references.push(`routes[${index}] (${route.match})`)
  })
  const registry = new AccountRegistry(configuration)
  configuration.requiredRoutes.forEach((route, index) => {
    if (boundAccountIdForRequiredRoute(registry, route) === id)
      references.push(`requiredRoutes[${index}] (${route.surface}:${route.model})`)
  })
  return references
}

function createEmptyConfiguration(defaultAccount: string): AccountsConfiguration {
  return {
    version: 1,
    revision: 0,
    defaultAccount,
    requiredRoutes: [],
    accounts: [],
    routes: [],
  }
}

function requirePresentConfiguration(
  configuration: AccountsConfiguration | undefined,
): AccountsConfiguration {
  if (!configuration)
    throw new Error('No accounts.json configuration exists')
  return configuration
}

function requireDescriptor(
  configuration: AccountsConfiguration,
  id: string,
): AccountDescriptor {
  const descriptor = configuration.accounts.find(account => account.id === id)
  if (!descriptor)
    throw new Error(`Unknown account: ${id}`)
  return descriptor
}

interface FileSnapshot {
  content?: Buffer
  exists: boolean
}

function snapshotFile(filePath: string): FileSnapshot {
  try {
    return { content: fs.readFileSync(filePath), exists: true }
  }
  catch (error) {
    if (isErrno(error, 'ENOENT'))
      return { exists: false }
    throw error
  }
}

function restoreSnapshot(filePath: string, snapshot: FileSnapshot): void {
  if (!snapshot.exists) {
    fs.rmSync(filePath, { force: true })
    return
  }
  writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory(filePath, snapshot.content!)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
