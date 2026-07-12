import fs from 'node:fs'
import { afterEach, describe, expect, test } from 'bun:test'

import { buildWindowsCimProcessScript, isCurrentDaemonProcess, isProcessRunning, readPid, removePidFile, writePid } from '../src/daemon/pid'
import { PATHS } from '../src/lib/paths'

afterEach(() => {
  try {
    fs.unlinkSync(PATHS.DAEMON_PID)
  }
  catch {}
})

describe('writePid / readPid', () => {
  test('writes and reads PID with startTime', () => {
    const before = Date.now()
    writePid(12345)
    const info = readPid()
    expect(info).not.toBeNull()
    expect(info!.pid).toBe(12345)
    expect(info!.startTime).toBeGreaterThanOrEqual(before)
    expect(info!.startTime).toBeLessThanOrEqual(Date.now())
  })

  test('returns null when no PID file', () => {
    expect(readPid()).toBeNull()
  })

  test('returns null for invalid PID file content', () => {
    fs.writeFileSync(PATHS.DAEMON_PID, 'garbage')
    expect(readPid()).toBeNull()
  })

  test('returns null for trailing garbage after number', () => {
    fs.writeFileSync(PATHS.DAEMON_PID, '123garbage')
    expect(readPid()).toBeNull()
  })

  test('returns null for PID 0', () => {
    fs.writeFileSync(PATHS.DAEMON_PID, '0')
    expect(readPid()).toBeNull()
  })

  test('returns null for negative PID', () => {
    fs.writeFileSync(PATHS.DAEMON_PID, '-1')
    expect(readPid()).toBeNull()
  })

  test('reads legacy format (PID only) with startTime 0', () => {
    fs.writeFileSync(PATHS.DAEMON_PID, '12345')
    const info = readPid()
    expect(info).not.toBeNull()
    expect(info!.pid).toBe(12345)
    expect(info!.startTime).toBe(0)
  })

  test('returns null for valid PID with invalid startTime', () => {
    fs.writeFileSync(PATHS.DAEMON_PID, '12345\nnotanumber')
    expect(readPid()).toBeNull()
  })
})

describe('removePidFile', () => {
  test('removes PID file', () => {
    writePid(12345)
    removePidFile()
    expect(readPid()).toBeNull()
  })

  test('does not throw when no PID file', () => {
    expect(() => removePidFile()).not.toThrow()
  })
})

describe('isProcessRunning', () => {
  test('returns true for current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true)
  })

  test('returns false for non-existent PID', () => {
    expect(isProcessRunning(999999)).toBe(false)
  })
})

describe('isCurrentDaemonProcess', () => {
  test('rejects a live PID that is not the daemon supervisor', () => {
    writePid(process.pid)

    expect(isCurrentDaemonProcess(process.pid)).toBe(false)
  })
})

describe('Windows process CIM queries', () => {
  test('queries command lines without WMIC or cmd interpolation', () => {
    const script = buildWindowsCimProcessScript(12345, 'CommandLine')

    expect(script).toContain('Get-CimInstance -ClassName Win32_Process')
    expect(script).toContain('-Filter \'ProcessId = 12345\'')
    expect(script).toContain('$process.CommandLine')
    expect(script.toLowerCase()).not.toContain('wmic')
  })

  test('converts CIM creation time directly to epoch milliseconds', () => {
    const script = buildWindowsCimProcessScript(12345, 'CreationDate')

    expect(script).toContain('$process.CreationDate')
    expect(script).toContain('ToUnixTimeMilliseconds()')
  })

  test('rejects invalid PIDs before constructing PowerShell source', () => {
    expect(() => buildWindowsCimProcessScript(Number.NaN, 'CommandLine')).toThrow()
    expect(() => buildWindowsCimProcessScript(0, 'CreationDate')).toThrow()
  })
})
