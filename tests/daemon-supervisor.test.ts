import fs from 'node:fs'
import process from 'node:process'

import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test'

import { readPid, removePidFile } from '../src/daemon/pid'
import { runAsSupervisor } from '../src/daemon/supervisor'
import { PATHS } from '../src/lib/paths'

type SignalHandler = NodeJS.SignalsListener
type ExitHandler = NodeJS.ExitListener

const TEST_EXIT_PREFIX = '__TEST_EXIT__'

function createPortInUseError(): NodeJS.ErrnoException {
  const error = new Error('listen EADDRINUSE: address already in use :::4399') as NodeJS.ErrnoException
  error.code = 'EADDRINUSE'
  return error
}

function cleanupExtraSignalListeners(signal: NodeJS.Signals, baseline: SignalHandler[]): void {
  const current = process.listeners(signal)
  for (const handler of current) {
    if (!baseline.includes(handler)) {
      process.removeListener(signal, handler)
    }
  }
}

function cleanupExtraExitListeners(baseline: ExitHandler[]): void {
  const current = process.listeners('exit')
  for (const handler of current) {
    if (!baseline.includes(handler)) {
      process.removeListener('exit', handler)
    }
  }
}

describe('runAsSupervisor', () => {
  let originalExit: typeof process.exit
  let baselineSigterm: SignalHandler[]
  let baselineSigint: SignalHandler[]
  let baselineExit: ExitHandler[]

  beforeEach(() => {
    vi.useFakeTimers()
    originalExit = process.exit
    baselineSigterm = process.listeners('SIGTERM') as SignalHandler[]
    baselineSigint = process.listeners('SIGINT') as SignalHandler[]
    baselineExit = process.listeners('exit')
    fs.mkdirSync(PATHS.APP_DIR, { recursive: true })
    fs.rmSync(PATHS.DAEMON_STOP, { force: true })
    removePidFile()
  })

  afterEach(() => {
    process.exit = originalExit
    cleanupExtraSignalListeners('SIGTERM', baselineSigterm)
    cleanupExtraSignalListeners('SIGINT', baselineSigint)
    cleanupExtraExitListeners(baselineExit)
    vi.clearAllTimers()
    vi.useRealTimers()
    fs.rmSync(PATHS.DAEMON_STOP, { force: true })
    removePidFile()
  })

  test('exits without retry when runFn throws EADDRINUSE', async () => {
    const runFn = mock(async () => {
      throw createPortInUseError()
    })

    process.exit = ((code?: number) => {
      throw new Error(`${TEST_EXIT_PREFIX}${code ?? 0}`)
    }) as typeof process.exit

    await expect(runAsSupervisor(runFn)).rejects.toThrow(`${TEST_EXIT_PREFIX}1`)
    expect(runFn).toHaveBeenCalledTimes(1)
    expect(readPid()).toBeNull()
  })

  test('cleans supervisor state when the managed server returns normally', async () => {
    fs.writeFileSync(PATHS.DAEMON_STOP, 'stale stop request')
    const runFn = mock(async () => {})

    await runAsSupervisor(runFn)

    expect(runFn).toHaveBeenCalledTimes(1)
    expect(readPid()).toBeNull()
    expect(fs.existsSync(PATHS.DAEMON_STOP)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(process.listeners('exit')).toEqual(baselineExit)
  })

  test('emits SIGTERM for a stop request and keeps the request until shutdown', async () => {
    expect(baselineSigterm).toHaveLength(0)
    let stopRequestPresentDuringSignal = false
    const signalHandler = mock((signal: NodeJS.Signals) => {
      if (signal === 'SIGTERM') {
        stopRequestPresentDuringSignal = fs.existsSync(PATHS.DAEMON_STOP)
      }
    })
    process.once('SIGTERM', signalHandler)
    let finishRun!: () => void
    const runFn = mock(() => new Promise<void>((resolve) => {
      finishRun = resolve
    }))

    const supervisorPromise = runAsSupervisor(runFn)
    fs.writeFileSync(PATHS.DAEMON_STOP, 'stop')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(499)
    const signalCallsBeforePoll = signalHandler.mock.calls.length
    vi.advanceTimersByTime(1)
    finishRun()
    await supervisorPromise

    expect(signalCallsBeforePoll).toBe(0)
    expect(runFn).toHaveBeenCalledTimes(1)
    expect(signalHandler).toHaveBeenCalledTimes(1)
    expect(signalHandler).toHaveBeenCalledWith('SIGTERM')
    expect(stopRequestPresentDuringSignal).toBe(true)
    expect(readPid()).toBeNull()
    expect(fs.existsSync(PATHS.DAEMON_STOP)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    expect(process.listeners('exit')).toEqual(baselineExit)
  })
})
