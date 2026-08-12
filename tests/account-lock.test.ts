import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'

import { acquireAccountsLock, acquireAccountStateLock, acquireRuntimeLock, clearStaleRuntimeLock, inspectRuntimeLock } from '~/lib/account/lock'

const temporaryDirectories: string[] = []
const testLinux = process.platform === 'linux' ? test : test.skip

if (process.platform === 'win32')
  setDefaultTimeout(15_000)

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { force: true, recursive: true })
})

describe('account and runtime locks', () => {
  test('prevents a second runtime owner and releases its unique claim', async () => {
    const filePath = path.join(createTemporaryDirectory(), 'runtime.lock')
    const first = await acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4399, nativeService: false })
    expect(inspectRuntimeLock(filePath).state).toBe('active')
    await expect(acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4400, nativeService: false }))
      .rejects
      .toThrow('Another copilot-proxy')
    first.release()
    expect(inspectRuntimeLock(filePath).state).toBe('absent')
  })

  test('times out a concurrent accounts writer without overwriting the first lock', async () => {
    const filePath = path.join(createTemporaryDirectory(), 'accounts.lock')
    const first = await acquireAccountsLock({ filePath })
    await expect(acquireAccountsLock({ filePath, timeoutMs: 10, pollIntervalMs: 1 }))
      .rejects
      .toThrow('Timed out waiting')
    first.release()
    const second = await acquireAccountsLock({ filePath, timeoutMs: 10, pollIntervalMs: 1 })
    second.release()
  })

  test('serializes the short account-state publication gate independently', async () => {
    const filePath = path.join(createTemporaryDirectory(), 'account-state.lock')
    const first = await acquireAccountStateLock({ filePath })
    await expect(acquireAccountStateLock({ filePath, timeoutMs: 10, pollIntervalMs: 1 }))
      .rejects
      .toThrow('Timed out waiting')
    first.release()
    const second = await acquireAccountStateLock({ filePath, timeoutMs: 10, pollIntervalMs: 1 })
    second.release()
  })

  test('ignores an unpublished partial claim left by a writer crash', async () => {
    const filePath = path.join(createTemporaryDirectory(), 'runtime.lock')
    fs.mkdirSync(filePath, { recursive: true })
    fs.writeFileSync(
      path.join(filePath, 'crashed.json.1234.partial.tmp'),
      '{"version":1,"choosing":true',
    )

    const owner = await acquireRuntimeLock({
      filePath,
      host: '127.0.0.1',
      port: 4399,
      nativeService: false,
    })
    expect(inspectRuntimeLock(filePath)).toMatchObject({
      state: 'active',
      metadata: { instanceId: owner.metadata.instanceId },
    })
    owner.release()
    expect(inspectRuntimeLock(filePath)).toEqual({ state: 'absent' })
  })

  test('treats a live reused PID with a different process identity as stale', async () => {
    const filePath = path.join(createTemporaryDirectory(), 'runtime.lock')
    const first = await acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4399, nativeService: false })
    const claimPath = path.join(filePath, fs.readdirSync(filePath)[0]!)
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8')) as {
      metadata: { processIdentity: string }
    }
    first.release()

    fs.mkdirSync(filePath, { recursive: true })
    claim.metadata.processIdentity = `${claim.metadata.processIdentity}:reused`
    fs.writeFileSync(claimPath, JSON.stringify(claim))

    expect(inspectRuntimeLock(filePath).state).toBe('stale')
    expect(clearStaleRuntimeLock(filePath)).toBe(true)
    expect(inspectRuntimeLock(filePath).state).toBe('absent')
  })

  testLinux('does not reclaim a live claim owned by another PID namespace', async () => {
    const filePath = path.join(createTemporaryDirectory(), 'runtime.lock')
    const owner = await acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4399, nativeService: false })
    const claimPath = path.join(filePath, fs.readdirSync(filePath)[0]!)
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8')) as {
      metadata: { processIdentity: string }
    }
    claim.metadata.processIdentity = claim.metadata.processIdentity.replace(
      /pid:\[\d+\]/,
      'pid:[999999999]',
    )
    fs.writeFileSync(claimPath, JSON.stringify(claim))

    expect(inspectRuntimeLock(filePath).state).toBe('unknown')
    await expect(acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4400, nativeService: false }))
      .rejects
      .toThrow('Another copilot-proxy')
    owner.release()
  })

  testLinux('does not treat a foreign namespace PID missing locally as dead', async () => {
    const filePath = path.join(createTemporaryDirectory(), 'runtime.lock')
    const owner = await acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4399, nativeService: false })
    const claimPath = path.join(filePath, fs.readdirSync(filePath)[0]!)
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8')) as {
      metadata: { pid: number, processIdentity: string }
    }
    claim.metadata.pid = 999_999_999
    claim.metadata.processIdentity = claim.metadata.processIdentity.replace(
      /pid:\[\d+\]/,
      'pid:[999999998]',
    )
    fs.writeFileSync(claimPath, JSON.stringify(claim))

    expect(inspectRuntimeLock(filePath).state).toBe('unknown')
    await expect(acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4400, nativeService: false }))
      .rejects
      .toThrow('Another copilot-proxy')
    owner.release()
  })

  test('stale cleanup cannot unlink a later owner with a different claim path', async () => {
    const filePath = path.join(createTemporaryDirectory(), 'runtime.lock')
    const staleOwner = await acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4399, nativeService: false })
    const staleClaimPath = path.join(filePath, fs.readdirSync(filePath)[0]!)
    const staleClaim = JSON.parse(fs.readFileSync(staleClaimPath, 'utf8')) as {
      metadata: { processIdentity: string }
    }
    staleOwner.release()
    fs.mkdirSync(filePath, { recursive: true })
    staleClaim.metadata.processIdentity = `${staleClaim.metadata.processIdentity}:stale`
    fs.writeFileSync(staleClaimPath, JSON.stringify(staleClaim))

    const successor = await acquireRuntimeLock({ filePath, host: '127.0.0.1', port: 4400, nativeService: false })
    expect(clearStaleRuntimeLock(filePath)).toBe(false)
    expect(inspectRuntimeLock(filePath)).toMatchObject({
      state: 'active',
      metadata: { instanceId: successor.metadata.instanceId, port: 4400 },
    })
    successor.release()
  })
})

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-account-lock-'))
  temporaryDirectories.push(directory)
  return directory
}
