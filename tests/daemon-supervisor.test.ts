import process from 'node:process'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { readPid, removePidFile } from '../src/daemon/pid'
import { runAsSupervisor } from '../src/daemon/supervisor'

type SignalHandler = (...args: Array<unknown>) => void

const TEST_EXIT_PREFIX = '__TEST_EXIT__'

function createPortInUseError(): NodeJS.ErrnoException {
  const error = new Error('listen EADDRINUSE: address already in use :::4399') as NodeJS.ErrnoException
  error.code = 'EADDRINUSE'
  return error
}

function cleanupExtraListeners(signal: NodeJS.Signals | 'exit', baseline: SignalHandler[]): void {
  const current = process.listeners(signal) as SignalHandler[]
  for (const handler of current) {
    if (!baseline.includes(handler)) {
      process.removeListener(signal, handler as (...args: never[]) => void)
    }
  }
}

describe('runAsSupervisor', () => {
  let originalExit: typeof process.exit
  let baselineSigterm: SignalHandler[]
  let baselineSigint: SignalHandler[]
  let baselineExit: SignalHandler[]

  beforeEach(() => {
    originalExit = process.exit
    baselineSigterm = process.listeners('SIGTERM') as SignalHandler[]
    baselineSigint = process.listeners('SIGINT') as SignalHandler[]
    baselineExit = process.listeners('exit') as SignalHandler[]
    removePidFile()
  })

  afterEach(() => {
    process.exit = originalExit
    cleanupExtraListeners('SIGTERM', baselineSigterm)
    cleanupExtraListeners('SIGINT', baselineSigint)
    cleanupExtraListeners('exit', baselineExit)
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
})
