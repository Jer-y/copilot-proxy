import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory } from '~/daemon/atomic-file'
import { ensureOwnerOnlyDirectories } from '~/lib/owner-only'
import { PATHS } from '~/lib/paths'

const LOCK_SCHEMA_VERSION = 1 as const
const ACCOUNT_STATE_LOCK = path.join(PATHS.APP_DIR, 'account-state.lock')
const RUNTIME_ELECTION_TIMEOUT_MS = 1_000
let currentProcessIdentity: string | undefined

interface BaseLockMetadata {
  pid: number
  instanceId: string
  processIdentity: string
  startedAt: string
}

interface LockClaim<TMetadata extends BaseLockMetadata> {
  version: typeof LOCK_SCHEMA_VERSION
  choosing: boolean
  ticket: number
  metadata: TMetadata
}

export interface RuntimeLockMetadata extends BaseLockMetadata {
  host: string
  port: number
  nativeService: boolean
  purpose?: 'server' | 'setup'
}

export interface AccountsLockMetadata extends BaseLockMetadata {
  kind: 'accounts'
}

export interface AccountStateLockMetadata extends BaseLockMetadata {
  kind: 'account-state'
}

export type RuntimeLockInspection
  = | { state: 'absent' }
    | { state: 'active', metadata: RuntimeLockMetadata }
    | { state: 'stale', metadata: RuntimeLockMetadata }
    | { state: 'unknown', error?: unknown }

export interface OwnedFileLock<TMetadata extends BaseLockMetadata> {
  metadata: TMetadata
  release: () => void
}

interface LockOptions {
  filePath?: string
  pollIntervalMs?: number
  timeoutMs?: number
}

interface ClaimEntry<TMetadata extends BaseLockMetadata> {
  claim?: LockClaim<TMetadata>
  fileName: string
  filePath: string
  invalid?: unknown
  processState?: ProcessInspection
}

type ProcessInspection
  = | { state: 'alive', identity: string }
    | { state: 'dead' }
    | { state: 'reused', identity: string }
    | { state: 'unknown' }

export async function acquireRuntimeLock(options: {
  host: string
  port: number
  nativeService: boolean
  purpose?: 'server' | 'setup'
  filePath?: string
}): Promise<OwnedFileLock<RuntimeLockMetadata>> {
  const filePath = options.filePath ?? PATHS.RUNTIME_LOCK
  const metadata: RuntimeLockMetadata = createBaseMetadata({
    host: options.host,
    port: options.port,
    nativeService: options.nativeService,
    ...(options.purpose && { purpose: options.purpose }),
  })
  const lock = await acquireTicketLock(filePath, metadata, {
    timeoutMs: RUNTIME_ELECTION_TIMEOUT_MS,
    waitForOwner: false,
  })
  const onExit = () => {
    try {
      lock.release()
    }
    catch {}
  }
  process.on('exit', onExit)
  return {
    metadata,
    release: once(() => {
      process.removeListener('exit', onExit)
      lock.release()
    }),
  }
}

export async function acquireAccountsLock(
  options: LockOptions = {},
): Promise<OwnedFileLock<AccountsLockMetadata>> {
  const metadata: AccountsLockMetadata = createBaseMetadata({ kind: 'accounts' })
  return await acquireTicketLock(
    options.filePath ?? PATHS.ACCOUNTS_LOCK,
    metadata,
    {
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs ?? 30_000,
      waitForOwner: true,
    },
  )
}

export async function acquireAccountStateLock(
  options: LockOptions = {},
): Promise<OwnedFileLock<AccountStateLockMetadata>> {
  const metadata: AccountStateLockMetadata = createBaseMetadata({ kind: 'account-state' })
  return await acquireTicketLock(
    options.filePath ?? ACCOUNT_STATE_LOCK,
    metadata,
    {
      pollIntervalMs: options.pollIntervalMs,
      timeoutMs: options.timeoutMs ?? 30_000,
      waitForOwner: true,
    },
  )
}

export function inspectRuntimeLock(
  filePath = PATHS.RUNTIME_LOCK,
): RuntimeLockInspection {
  const entries = readClaimEntries<RuntimeLockMetadata>(filePath)
  if (entries === undefined)
    return { state: 'absent' }
  if (entries instanceof Error)
    return { state: 'unknown', error: entries }

  const active: LockClaim<RuntimeLockMetadata>[] = []
  const stale: LockClaim<RuntimeLockMetadata>[] = []
  for (const entry of entries) {
    if (!entry.claim)
      return { state: 'unknown', error: entry.invalid }
    if (!isRuntimeLockMetadata(entry.claim.metadata))
      return { state: 'unknown', error: new Error(`Invalid runtime lock claim: ${entry.filePath}`) }
    const processState = inspectClaimProcess(entry.claim.metadata)
    if (processState.state === 'unknown')
      return { state: 'unknown', error: new Error(`Cannot verify runtime lock owner ${entry.claim.metadata.pid}`) }
    if (processState.state === 'alive')
      active.push(entry.claim)
    else
      stale.push(entry.claim)
  }

  if (active.length > 1) {
    return {
      state: 'unknown',
      error: new Error(`Multiple active runtime lock claims exist at ${filePath}`),
    }
  }
  if (active.length === 1)
    return { state: 'active', metadata: active[0]!.metadata }
  if (stale.length > 0)
    return { state: 'stale', metadata: stale[0]!.metadata }
  return { state: 'absent' }
}

export function clearStaleRuntimeLock(
  filePath = PATHS.RUNTIME_LOCK,
): boolean {
  const entries = readClaimEntries<RuntimeLockMetadata>(filePath)
  if (entries === undefined)
    return false
  if (entries instanceof Error)
    throw entries

  let removed = false
  for (const entry of entries) {
    if (!entry.claim || !isRuntimeLockMetadata(entry.claim.metadata))
      continue
    const processState = inspectClaimProcess(entry.claim.metadata)
    if (processState.state === 'dead' || processState.state === 'reused') {
      removeUniqueClaim(entry.filePath, entry.claim.metadata.instanceId)
      removed = true
    }
  }
  removeEmptyLockDirectory(filePath)
  return removed
}

async function acquireTicketLock<TMetadata extends BaseLockMetadata>(
  filePath: string,
  metadata: TMetadata,
  options: {
    pollIntervalMs?: number
    timeoutMs: number
    waitForOwner: boolean
  },
): Promise<OwnedFileLock<TMetadata>> {
  const pollIntervalMs = options.pollIntervalMs ?? 25
  const deadline = Date.now() + options.timeoutMs
  const claimPath = createChoosingClaim(filePath, metadata)
  let released = false

  try {
    const initialEntries = pruneAndReadClaims<TMetadata>(filePath)
    const maxTicket = initialEntries.reduce((max, entry) => {
      const ticket = entry.claim?.choosing ? 0 : entry.claim?.ticket ?? 0
      return Math.max(max, ticket)
    }, 0)
    if (!Number.isSafeInteger(maxTicket) || maxTicket >= Number.MAX_SAFE_INTEGER)
      throw new Error(`Lock ticket space is exhausted at ${filePath}`)

    const ownClaim: LockClaim<TMetadata> = {
      version: LOCK_SCHEMA_VERSION,
      choosing: false,
      ticket: maxTicket + 1,
      metadata,
    }
    writeClaim(claimPath, ownClaim)

    while (true) {
      const entries = pruneAndReadClaims<TMetadata>(filePath)
      const blockers = entries.filter((entry) => {
        if (entry.filePath === claimPath)
          return false
        if (!entry.claim)
          return true
        if (entry.claim.choosing)
          return true
        return compareTickets(entry.claim, ownClaim) < 0
      })
      if (blockers.length === 0) {
        return {
          metadata,
          release: once(() => {
            released = true
            removeUniqueClaim(claimPath, metadata.instanceId)
            removeEmptyLockDirectory(filePath)
          }),
        }
      }

      const settledOwner = blockers.find(entry => entry.claim && !entry.claim.choosing)
      if (!options.waitForOwner && settledOwner) {
        throw new Error(
          `Another copilot-proxy process is already using this data directory (${filePath}). Use a different COPILOT_PROXY_DATA_DIR for another instance.`,
        )
      }
      if (Date.now() >= deadline) {
        throw new Error(
          options.waitForOwner
            ? `Timed out waiting for lock at ${filePath}`
            : `Another copilot-proxy process is already using this data directory (${filePath}). Use a different COPILOT_PROXY_DATA_DIR for another instance.`,
        )
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
  }
  catch (error) {
    if (!released) {
      removeUniqueClaim(claimPath, metadata.instanceId)
      removeEmptyLockDirectory(filePath)
    }
    throw error
  }
}

function createChoosingClaim<TMetadata extends BaseLockMetadata>(
  filePath: string,
  metadata: TMetadata,
): string {
  ensureLockDirectory(filePath)
  const claimPath = path.join(filePath, `${metadata.instanceId}.json`)
  // Publish the first claim atomically too. A crash while writing the
  // same-directory temporary file can leave only an ignored *.tmp artifact;
  // scanners never observe a truncated JSON claim that would block forever.
  writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory(claimPath, `${JSON.stringify({
    version: LOCK_SCHEMA_VERSION,
    choosing: true,
    ticket: 0,
    metadata,
  } satisfies LockClaim<TMetadata>)}\n`)
  return claimPath
}

function writeClaim<TMetadata extends BaseLockMetadata>(
  claimPath: string,
  claim: LockClaim<TMetadata>,
): void {
  writeOwnerOnlyFileAtomicallyInOwnerOnlyDirectory(claimPath, `${JSON.stringify(claim)}\n`)
}

function pruneAndReadClaims<TMetadata extends BaseLockMetadata>(
  filePath: string,
): Array<ClaimEntry<TMetadata>> {
  const entries = readClaimEntries<TMetadata>(filePath)
  if (entries === undefined)
    throw new Error(`Lock directory disappeared during acquisition: ${filePath}`)
  if (entries instanceof Error)
    throw entries

  for (const entry of entries) {
    if (!entry.claim)
      continue
    const processState = inspectClaimProcess(entry.claim.metadata)
    entry.processState = processState
    if (processState.state === 'dead' || processState.state === 'reused')
      removeUniqueClaim(entry.filePath, entry.claim.metadata.instanceId)
  }
  return entries.filter(entry => entry.processState?.state !== 'dead' && entry.processState?.state !== 'reused')
}

function readClaimEntries<TMetadata extends BaseLockMetadata>(
  filePath: string,
): Array<ClaimEntry<TMetadata>> | Error | undefined {
  let fileNames: string[]
  try {
    fileNames = fs.readdirSync(filePath).filter(fileName => fileName.endsWith('.json'))
  }
  catch (error) {
    if (isErrno(error, 'ENOENT'))
      return undefined
    return new Error(`Cannot inspect lock directory at ${filePath}`, { cause: error })
  }

  return fileNames.map((fileName) => {
    const claimPath = path.join(filePath, fileName)
    try {
      const value = JSON.parse(fs.readFileSync(claimPath, 'utf8')) as unknown
      if (!isLockClaim<TMetadata>(value))
        throw new Error('Invalid lock claim metadata')
      return { claim: value, fileName, filePath: claimPath }
    }
    catch (error) {
      return { fileName, filePath: claimPath, invalid: error }
    }
  })
}

function compareTickets<TMetadata extends BaseLockMetadata>(
  left: LockClaim<TMetadata>,
  right: LockClaim<TMetadata>,
): number {
  if (left.ticket !== right.ticket)
    return left.ticket - right.ticket
  return left.metadata.instanceId.localeCompare(right.metadata.instanceId)
}

function createBaseMetadata<T extends object>(extra: T): BaseLockMetadata & T {
  const processIdentity = getCurrentProcessIdentity()
  if (!processIdentity)
    throw new Error('Cannot establish a stable identity for the current process')
  return {
    pid: process.pid,
    instanceId: randomUUID(),
    processIdentity,
    startedAt: new Date().toISOString(),
    ...extra,
  }
}

function inspectClaimProcess(metadata: BaseLockMetadata): ProcessInspection {
  const localIdentity = getCurrentProcessIdentity()
  if (
    localIdentity
    && identitiesUseDifferentLinuxPidNamespaces(metadata.processIdentity, localIdentity)
  ) {
    // Processes in sibling PID namespaces are not necessarily visible through
    // this namespace's kill(2) or /proc. Treat the foreign claim as active but
    // unverifiable before consulting its numeric PID; ESRCH here is not proof
    // that the owner is dead.
    return { state: 'unknown' }
  }

  if (metadata.pid === process.pid) {
    if (!localIdentity)
      return { state: 'unknown' }
    return compareObservedProcessIdentity(metadata.processIdentity, localIdentity)
  }
  const current = inspectProcess(metadata.pid)
  if (current.state !== 'alive')
    return current
  return compareObservedProcessIdentity(metadata.processIdentity, current.identity)
}

function identitiesUseDifferentLinuxPidNamespaces(
  expected: string,
  local: string,
): boolean {
  const expectedLinux = parseLinuxProcessIdentity(expected)
  const localLinux = parseLinuxProcessIdentity(local)
  return Boolean(
    expectedLinux
    && localLinux
    && expectedLinux.bootId === localLinux.bootId
    && expectedLinux.pidNamespace !== localLinux.pidNamespace,
  )
}

function compareObservedProcessIdentity(
  expected: string,
  observed: string,
): ProcessInspection {
  if (expected === observed)
    return { state: 'alive', identity: observed }

  const expectedLinux = parseLinuxProcessIdentity(expected)
  const observedLinux = parseLinuxProcessIdentity(observed)
  if (
    expectedLinux
    && observedLinux
    && expectedLinux.bootId === observedLinux.bootId
    && expectedLinux.pidNamespace !== observedLinux.pidNamespace
  ) {
    // A process in a sibling or parent PID namespace can have the same visible
    // PID while remaining invisible through this namespace's /proc. Fail
    // closed instead of deleting its live claim as a locally reused PID.
    return { state: 'unknown' }
  }

  return { state: 'reused', identity: observed }
}

function getCurrentProcessIdentity(): string | undefined {
  currentProcessIdentity ??= readProcessIdentity(process.pid)
  return currentProcessIdentity
}

function inspectProcess(pid: number): ProcessInspection {
  try {
    process.kill(pid, 0)
  }
  catch (error) {
    if (isErrno(error, 'ESRCH'))
      return { state: 'dead' }
    if (!isErrno(error, 'EPERM'))
      return { state: 'unknown' }
  }

  const identity = readProcessIdentity(pid)
  return identity ? { state: 'alive', identity } : { state: 'unknown' }
}

function readProcessIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return undefined
  if (process.platform === 'linux')
    return readLinuxProcessIdentity(pid)
  if (process.platform === 'darwin')
    return readDarwinProcessIdentity(pid)
  if (process.platform === 'win32')
    return readWindowsProcessIdentity(pid)
  return undefined
}

function readLinuxProcessIdentity(pid: number): string | undefined {
  try {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    const pidNamespace = fs.readlinkSync(`/proc/${pid}/ns/pid`)
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const commandEnd = stat.lastIndexOf(')')
    if (!bootId || commandEnd < 0)
      return undefined
    const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/)
    const startTicks = fieldsAfterCommand[19]
    return bootId && /^pid:\[\d+\]$/.test(pidNamespace) && startTicks && /^\d+$/.test(startTicks)
      ? `linux:${bootId}:${pidNamespace}:${startTicks}`
      : undefined
  }
  catch {
    return undefined
  }
}

function parseLinuxProcessIdentity(identity: string): {
  bootId: string
  pidNamespace: string
  startTicks: string
} | undefined {
  const match = identity.match(/^linux:([^:]+):(pid:\[\d+\]):(\d+)$/)
  return match
    ? { bootId: match[1]!, pidNamespace: match[2]!, startTicks: match[3]! }
    : undefined
}

function readDarwinProcessIdentity(pid: number): string | undefined {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 2_000,
  })
  const startedAt = result.status === 0 ? result.stdout.trim() : ''
  return startedAt ? `darwin:${startedAt}` : undefined
}

function readWindowsProcessIdentity(pid: number): string | undefined {
  const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  })
  const startedAt = result.status === 0 ? result.stdout.trim() : ''
  return startedAt && /^\d+$/.test(startedAt)
    ? `win32:${startedAt}`
    : undefined
}

function ensureLockDirectory(filePath: string): void {
  const parentDirectory = path.dirname(filePath)
  fs.mkdirSync(parentDirectory, { recursive: true, mode: 0o700 })
  fs.mkdirSync(filePath, { recursive: true, mode: 0o700 })
  ensureOwnerOnlyDirectories([parentDirectory, filePath])
}

function removeUniqueClaim(filePath: string, instanceId: string): void {
  if (path.basename(filePath) !== `${instanceId}.json`)
    throw new Error(`Refusing to remove a lock claim with mismatched ownership: ${filePath}`)
  try {
    fs.unlinkSync(filePath)
  }
  catch (error) {
    if (!isErrno(error, 'ENOENT'))
      throw error
  }
}

function removeEmptyLockDirectory(filePath: string): void {
  try {
    fs.rmdirSync(filePath)
  }
  catch (error) {
    if (!isErrno(error, 'ENOENT') && !isErrno(error, 'ENOTEMPTY') && !isErrno(error, 'EEXIST'))
      throw error
  }
}

function isLockClaim<TMetadata extends BaseLockMetadata>(value: unknown): value is LockClaim<TMetadata> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const record = value as Record<string, unknown>
  if (record.version !== LOCK_SCHEMA_VERSION
    || typeof record.choosing !== 'boolean'
    || typeof record.ticket !== 'number'
    || !Number.isSafeInteger(record.ticket)
    || record.ticket < 0
    || !record.metadata
    || typeof record.metadata !== 'object'
    || Array.isArray(record.metadata)) {
    return false
  }
  const metadata = record.metadata as Record<string, unknown>
  return typeof metadata.pid === 'number'
    && Number.isSafeInteger(metadata.pid)
    && metadata.pid > 0
    && typeof metadata.instanceId === 'string'
    && metadata.instanceId.length > 0
    && typeof metadata.processIdentity === 'string'
    && metadata.processIdentity.length > 0
    && typeof metadata.startedAt === 'string'
}

function isRuntimeLockMetadata(value: BaseLockMetadata): value is RuntimeLockMetadata {
  const record = value as unknown as Record<string, unknown>
  return typeof record.host === 'string'
    && typeof record.port === 'number'
    && Number.isSafeInteger(record.port)
    && typeof record.nativeService === 'boolean'
    && (record.purpose === undefined || record.purpose === 'server' || record.purpose === 'setup')
}

function once(action: () => void): () => void {
  let called = false
  return () => {
    if (called)
      return
    called = true
    action()
  }
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
