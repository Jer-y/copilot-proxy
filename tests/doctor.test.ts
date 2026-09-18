import type { AddressInfo } from 'node:net'
import type {
  DoctorClient,
  DoctorDependencies,
  DoctorOptions,
} from '~/doctor'

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import path from 'node:path'
import process from 'node:process'

import { describe, expect, test } from 'bun:test'
import { fetch as undiciFetch } from 'undici'

import { configureDoctorNetwork, runDoctor } from '~/doctor'

import { createPackagedCliFixture } from './helpers/packaged-cli-fixture'

const directFetch: NonNullable<DoctorDependencies['fetch']> = (input, init) =>
  undiciFetch(input, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>

describe('doctor command', () => {
  test('initializes direct and explicit proxy networking consistently across runtimes', () => {
    const events: string[] = []
    const dependencies = {
      assertProxy: (_env: NodeJS.ProcessEnv, targets: string[]) => events.push(`assert:${targets.join(',')}`),
      initialize: (proxyEnv: boolean) => events.push(`initialize:${proxyEnv}`),
    }

    expect(configureDoctorNetwork('http://127.0.0.1:4399', false, dependencies)).toBe('http://127.0.0.1:4399')
    expect(configureDoctorNetwork('https://proxy.example.test/path?secret=value#fragment', true, dependencies)).toBe('https://proxy.example.test/path')

    expect(events).toEqual([
      'initialize:false',
      'assert:https://proxy.example.test/path',
      'initialize:true',
    ])
  })

  test('rejects endpoint credentials before proxy preflight can observe them', () => {
    const events: string[] = []
    const endpoint = 'http://doctor-user:doctor-password@127.0.0.1:4399/path?doctor-query-secret=yes#doctor-fragment-secret'

    expect(() => configureDoctorNetwork(endpoint, true, {
      assertProxy: (_env, targets) => events.push(`assert:${targets.join(',')}`),
      initialize: proxyEnv => events.push(`initialize:${proxyEnv}`),
    })).toThrow('--endpoint must not contain credentials')
    expect(events).toEqual([])
  })

  test('does not leak endpoint credentials or query data from the real CLI', () => {
    const credentialsResult = spawnSync(
      process.execPath,
      [
        path.resolve('src/main.ts'),
        'doctor',
        '--proxy-env',
        '--endpoint',
        'http://doctor-user:doctor-password@127.0.0.1:1/path?doctor-query-secret=yes#doctor-fragment-secret',
      ],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: removeProxyVariables(process.env),
        timeout: 10_000,
      },
    )

    expect(credentialsResult.error).toBeUndefined()
    expect(credentialsResult.status).toBe(1)
    expect(credentialsResult.stderr).toContain('--endpoint must not contain credentials')
    const credentialOutput = `${credentialsResult.stdout}\n${credentialsResult.stderr}`
    expect(credentialOutput).not.toContain('doctor-user')
    expect(credentialOutput).not.toContain('doctor-password')
    expect(credentialOutput).not.toContain('doctor-query-secret')
    expect(credentialOutput).not.toContain('doctor-fragment-secret')

    const queryResult = spawnSync(
      process.execPath,
      [
        path.resolve('src/main.ts'),
        'doctor',
        '--proxy-env',
        '--endpoint',
        'http://127.0.0.1:1/path?doctor-query-secret=yes#doctor-fragment-secret',
      ],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: removeProxyVariables(process.env),
        timeout: 10_000,
      },
    )

    expect(queryResult.error).toBeUndefined()
    expect(queryResult.status).toBe(1)
    expect(queryResult.stderr).toContain('route http://127.0.0.1:1/path')
    const queryOutput = `${queryResult.stdout}\n${queryResult.stderr}`
    expect(queryOutput).not.toContain('doctor-query-secret')
    expect(queryOutput).not.toContain('doctor-fragment-secret')
  }, 25_000)

  test('reports a complete successful diagnostics response', async () => {
    const calls: string[] = []
    const result = await executeDoctor({
      client: 'all',
      fetch: async (input) => {
        calls.push(input)
        return Response.json(successDiagnostics())
      },
    })

    expect(calls).toEqual(['http://127.0.0.1:4399/diagnostics'])
    expect(result.report).toMatchObject({
      status: 'pass',
      mode: 'full',
      summary: { fail: 0, warn: 0 },
    })
    expect(result.report.checks.filter(item => item.id.startsWith('client.'))).toEqual([
      expect.objectContaining({ id: 'client.claude', status: 'pass' }),
      expect.objectContaining({ id: 'client.codex', status: 'pass' }),
      expect.objectContaining({ id: 'client.openai-sdk', status: 'pass' }),
    ])
    expect(result.output).toContain('[PASS] Service')
    expect(result.output).toContain('Summary: PASS')
    expect(result.exitCodes).toEqual([0])
  })

  test('accepts the current required token lifecycle fields when optional telemetry is absent', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.token = {
      consecutiveRefreshFailures: 0,
      generation: 1,
      reactiveRefreshInFlight: false,
      refreshInFlight: true,
      refreshScheduled: false,
      tokenAvailable: true,
    }

    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'auth')).toMatchObject({ status: 'pass' })
    expect(result.report.status).toBe('pass')
    expect(result.exitCodes).toEqual([0])
  })

  test('accepts current optional lifecycle enums, timestamp boundaries, and non-OK HTTP statuses', async () => {
    const cases: Array<{
      failureKind: 'permanent_auth' | 'transient'
      failureStatus?: number
      outcome: 'already_refreshed' | 'cancelled' | 'failed' | 'refreshed'
    }> = [
      { failureKind: 'transient', failureStatus: 304, outcome: 'already_refreshed' },
      { failureKind: 'transient', failureStatus: 599, outcome: 'cancelled' },
      { failureKind: 'permanent_auth', failureStatus: 401, outcome: 'failed' },
      { failureKind: 'permanent_auth', failureStatus: 403, outcome: 'refreshed' },
      { failureKind: 'transient', outcome: 'refreshed' },
    ]

    for (const current of cases) {
      const diagnostics = successDiagnostics()
      Object.assign(diagnostics.readiness.token, {
        consecutiveRefreshFailures: 1,
        lastReactiveRefreshAt: 0,
        lastReactiveRefreshOutcome: current.outcome,
        lastRefreshAttemptAt: 0,
        lastRefreshFailureAt: 0,
        lastRefreshFailureKind: current.failureKind,
        lastRefreshSuccessAt: 0,
        ...(current.failureStatus !== undefined && {
          lastRefreshFailureStatus: current.failureStatus,
        }),
      })

      const result = await executeDoctor({
        client: 'all',
        fetch: async () => Response.json(diagnostics),
      })

      expect(findCheck(result, 'auth')).toMatchObject({ status: 'pass' })
      expect(result.report.status).toBe('pass')
      expect(result.exitCodes).toEqual([0])
    }
  })

  test('fails every missing required token lifecycle field', async () => {
    const requiredFields = [
      'consecutiveRefreshFailures',
      'generation',
      'reactiveRefreshInFlight',
      'refreshInFlight',
      'refreshScheduled',
      'tokenAvailable',
    ]

    for (const field of requiredFields) {
      const diagnostics = successDiagnostics()
      delete diagnostics.readiness.token[field]

      const result = await executeDoctor({
        client: 'all',
        fetch: async () => Response.json(diagnostics),
      })

      expect(findCheck(result, 'auth')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining(field),
      })
      expect(result.report.status).toBe('fail')
      expect(result.exitCodes).toEqual([1])
    }
  })

  test('fails malformed values for every token lifecycle field without reflecting values', async () => {
    const invalidCases: Array<{ field: string, values: unknown[] }> = [
      { field: 'consecutiveRefreshFailures', values: [null, 'secret-failure-count', -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'expiresAt', values: [null, 'secret-expiry-at', 0, -1, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'expiresInMs', values: [null, 'secret-expiry-duration', -1, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'generation', values: [null, 'secret-generation', -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'lastReactiveRefreshAt', values: [null, 'secret-reactive-at', -1, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'lastReactiveRefreshOutcome', values: [null, 'secret-reactive-outcome'] },
      { field: 'lastRefreshAttemptAt', values: [null, 'secret-attempt-at', -1, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'lastRefreshFailureAt', values: [null, 'secret-failure-at', -1, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'lastRefreshFailureKind', values: [null, 'secret-failure-kind'] },
      { field: 'lastRefreshFailureStatus', values: [null, 'secret-failure-status', 299, 600, 401.5, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'lastRefreshSuccessAt', values: [null, 'secret-success-at', -1, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'nextRefreshAt', values: [null, 'secret-next-refresh', -1, Number.NaN, Number.POSITIVE_INFINITY] },
      { field: 'reactiveRefreshInFlight', values: [null, 'secret-reactive-in-flight', 0] },
      { field: 'refreshInFlight', values: [null, 'secret-refresh-in-flight', 0] },
      { field: 'refreshScheduled', values: [null, 'secret-refresh-scheduled', 1] },
      { field: 'tokenAvailable', values: [null, 'secret-token-available', 1] },
    ]

    for (const { field, values } of invalidCases) {
      for (const value of values) {
        const diagnostics = successDiagnostics()
        diagnostics.readiness.token[field] = value

        const result = await executeDoctor({
          client: 'all',
          fetch: async () => inMemoryJsonResponse(diagnostics),
        })

        expect(findCheck(result, 'auth')).toMatchObject({
          status: 'fail',
          message: expect.stringContaining(field),
        })
        expect(result.report.status).toBe('fail')
        expect(result.exitCodes).toEqual([1])
        if (typeof value === 'string')
          expect(result.output).not.toContain(value)
      }
    }
  })

  test('fails token lifecycle relationships that cannot be emitted by readyz', async () => {
    const mutations: Array<{
      expectedField: string
      mutate: (token: Record<string, unknown>) => void
    }> = [
      {
        expectedField: 'expiresAt/expiresInMs',
        mutate: token => delete token.expiresAt,
      },
      {
        expectedField: 'expiresAt/expiresInMs',
        mutate: token => delete token.expiresInMs,
      },
      {
        expectedField: 'refreshScheduled/nextRefreshAt',
        mutate: token => delete token.nextRefreshAt,
      },
      {
        expectedField: 'refreshScheduled/nextRefreshAt',
        mutate: (token) => {
          token.refreshScheduled = false
        },
      },
      {
        expectedField: 'generation',
        mutate: (token) => {
          token.generation = 0
        },
      },
    ]

    for (const { expectedField, mutate } of mutations) {
      const diagnostics = successDiagnostics()
      mutate(diagnostics.readiness.token)

      const result = await executeDoctor({
        client: 'all',
        fetch: async () => Response.json(diagnostics),
      })

      expect(findCheck(result, 'auth')).toMatchObject({
        status: 'fail',
        message: expect.stringContaining(expectedField),
      })
      expect(result.report.status).toBe('fail')
      expect(result.exitCodes).toEqual([1])
    }
  })

  test('keeps valid zero expiry distinct from malformed lifecycle telemetry', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.token.expiresInMs = 0

    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'auth')).toEqual({
      id: 'auth',
      label: 'Authentication and token',
      status: 'fail',
      message: 'The Copilot access token is expired.',
    })
    expect(result.report.status).toBe('fail')
    expect(result.exitCodes).toEqual([1])
  })

  test('accepts a complete legacy concurrency snapshot without the enabled flag', async () => {
    const diagnostics = successDiagnostics()
    delete diagnostics.readiness.concurrency.enabled

    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'concurrency')).toMatchObject({ status: 'pass' })
    expect(result.report.status).toBe('pass')
    expect(result.exitCodes).toEqual([0])
  })

  test('reports account-specific limits when the global limiter is disabled', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.concurrency = {
      enabled: false,
      global: { enabled: false },
      perAccount: {
        personal: { enabled: false },
        work: {
          enabled: true,
          maxConcurrency: 2,
          maxQueue: 50,
          active: 1,
          queued: 0,
        },
      },
    }

    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'concurrency')).toEqual({
      id: 'concurrency',
      label: 'Concurrency',
      status: 'warn',
      message: 'The global upstream concurrency limiter is disabled; 1/2 account-specific limiter(s) enabled.',
    })
    expect(result.output).not.toContain('no account-specific limiters')
  })

  test('reports global usage and the number of account-specific limits together', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.concurrency = {
      enabled: true,
      maxConcurrency: 4,
      maxQueue: 8,
      active: 1,
      queued: 2,
      global: {
        enabled: true,
        maxConcurrency: 4,
        maxQueue: 8,
        active: 1,
        queued: 2,
      },
      perAccount: {
        personal: { enabled: false },
        work: {
          enabled: true,
          maxConcurrency: 2,
          maxQueue: 50,
          active: 1,
          queued: 0,
        },
      },
    }

    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'concurrency')).toEqual({
      id: 'concurrency',
      label: 'Concurrency',
      status: 'pass',
      message: 'The global upstream concurrency limiter is 1/4 active; 2/8 queued; 1/2 account-specific limiter(s) enabled.',
    })
  })

  test('keeps recovery passing when global and scoped circuits are closed', async () => {
    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(successDiagnostics()),
    })

    expect(findCheck(result, 'recovery')).toEqual({
      id: 'recovery',
      label: 'Recovery',
      status: 'pass',
      message: 'The global upstream recovery circuit is closed.',
    })
    expect(result.report).toMatchObject({
      status: 'pass',
      summary: { pass: 10, warn: 0, fail: 0 },
    })
    expect(result.exitCodes).toEqual([0])
  })

  test('warns with safe aggregate counts when scoped recovery circuits are open', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.recovery.scopes = {
      tracked: 2,
      open: 2,
      halfOpen: 0,
      earliestOpenUntil: 1_900_000_000_000,
      endpoint: 'https://scope-secret.example.test/responses',
      model: 'scope-secret-model',
      authorization: 'Bearer scope-secret-token',
    }

    const result = await executeDoctor({
      client: 'all',
      json: true,
      fetch: async () => Response.json(diagnostics),
    })
    const output = JSON.parse(result.output) as Record<string, unknown>

    expect(findCheck(result, 'recovery')).toEqual({
      id: 'recovery',
      label: 'Recovery',
      status: 'warn',
      message: 'The global upstream recovery circuit is closed, but scoped recovery circuits remain active: 2 open awaiting retry.',
    })
    expect(result.report).toMatchObject({
      status: 'warn',
      summary: { pass: 9, warn: 1, fail: 0 },
    })
    expect(output).toMatchObject({
      status: 'warn',
      summary: { pass: 9, warn: 1, fail: 0 },
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'recovery', status: 'warn' }),
      ]),
    })
    expect(result.output).not.toContain('scope-secret')
    expect(result.exitCodes).toEqual([0])
  })

  test('warns in plain output when a scoped recovery circuit is half-open', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.recovery.scopes = {
      tracked: 1,
      open: 0,
      halfOpen: 1,
      earliestOpenUntil: 1_700_000_000_000,
    }

    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'recovery')).toMatchObject({
      status: 'warn',
      message: 'The global upstream recovery circuit is closed, but scoped recovery circuits remain active: 1 half-open probing recovery.',
    })
    expect(result.report).toMatchObject({
      status: 'warn',
      summary: { pass: 9, warn: 1, fail: 0 },
    })
    expect(result.output).toContain('[WARN] Recovery: The global upstream recovery circuit is closed, but scoped recovery circuits remain active: 1 half-open probing recovery.')
    expect(result.output).toContain('Summary: WARN (9 passed, 1 warnings, 0 failed)')
    expect(result.exitCodes).toEqual([0])
  })

  test('combines scoped open and half-open recovery counts', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.recovery.scopes = {
      tracked: 3,
      open: 2,
      halfOpen: 1,
      earliestOpenUntil: 1_900_000_000_000,
    }

    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'recovery')).toMatchObject({
      status: 'warn',
      message: 'The global upstream recovery circuit is closed, but scoped recovery circuits remain active: 2 open awaiting retry, 1 half-open probing recovery.',
    })
    expect(result.report).toMatchObject({
      status: 'warn',
      summary: { pass: 9, warn: 1, fail: 0 },
    })
    expect(result.exitCodes).toEqual([0])
  })

  test('keeps an open global recovery circuit as a failure', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.recovery.globalCircuit = {
      phase: 'open',
      retryAfterSeconds: 30,
    }
    diagnostics.readiness.recovery.scopes = {
      tracked: 1,
      open: 1,
      halfOpen: 0,
      earliestOpenUntil: 1_900_000_000_000,
    }

    const result = await executeDoctor({
      client: 'all',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'recovery')).toEqual({
      id: 'recovery',
      label: 'Recovery',
      status: 'fail',
      message: 'The global upstream recovery circuit is open.',
    })
    expect(result.report).toMatchObject({
      status: 'fail',
      summary: { pass: 9, warn: 0, fail: 1 },
    })
    expect(result.exitCodes).toEqual([1])
  })

  test('warns instead of passing malformed concurrency diagnostics', async () => {
    const malformedSnapshots: Array<Record<string, unknown>> = [
      { enabled: true },
      { enabled: 'yes', maxConcurrency: 4, maxQueue: 8, active: 0, queued: 0 },
      { enabled: true, maxConcurrency: 0, maxQueue: 8, active: 0, queued: 0 },
      { enabled: true, maxConcurrency: 4, maxQueue: 8, active: 5, queued: 0 },
      { enabled: true, maxConcurrency: 4, maxQueue: 1, active: 0, queued: 2 },
    ]

    for (const concurrency of malformedSnapshots) {
      const diagnostics = successDiagnostics()
      diagnostics.readiness.concurrency = concurrency

      const result = await executeDoctor({
        client: 'all',
        fetch: async () => Response.json(diagnostics),
      })

      expect(findCheck(result, 'concurrency')).toMatchObject({ status: 'warn' })
      expect(result.report.status).toBe('warn')
      expect(result.exitCodes).toEqual([0])
    }
  })

  test('fails degraded readiness while keeping advisory findings as warnings', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.status = 'degraded'
    diagnostics.readiness.status = 'degraded'
    diagnostics.readiness.reasons = ['copilot_upstream_circuit_not_closed']
    diagnostics.readiness.recovery.globalCircuit.phase = 'half_open'
    diagnostics.readiness.concurrency = { enabled: false }
    diagnostics.usage = { status: 'unavailable', error: 'Failed to fetch Copilot usage' }

    const result = await executeDoctor({
      client: 'openai-sdk',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'readiness')).toMatchObject({ status: 'fail' })
    expect(findCheck(result, 'recovery')).toMatchObject({ status: 'warn' })
    expect(findCheck(result, 'concurrency')).toMatchObject({ status: 'warn' })
    expect(findCheck(result, 'usage')).toMatchObject({ status: 'warn' })
    expect(result.report.status).toBe('fail')
    expect(result.exitCodes).toEqual([1])
  })

  test('warns without failing when readiness retains a stale model catalog', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.status = 'degraded'
    diagnostics.readiness.warnings = ['model_catalog_stale']

    const result = await executeDoctor({
      client: 'codex',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'readiness')).toMatchObject({
      status: 'warn',
      message: expect.stringContaining('model_catalog_stale'),
    })
    expect(findCheck(result, 'models')).toMatchObject({ status: 'pass' })
    expect(result.report.status).toBe('warn')
    expect(result.exitCodes).toEqual([0])
  })

  test('fails when the selected client has no usable model', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.models = [modelProfile({
      chatCompletions: { mode: 'direct' },
      responsesHttp: { mode: 'direct' },
      responsesWebSocket: { mode: 'unsupported' },
      anthropicMessages: { mode: 'unsupported' },
    })]

    const result = await executeDoctor({
      client: 'claude',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'models')).toMatchObject({ status: 'pass' })
    expect(findCheck(result, 'client.claude')).toMatchObject({
      status: 'fail',
    })
    expect(findCheck(result, 'client.claude')?.message).toContain('No native route')
    expect(result.report.status).toBe('fail')
    expect(result.exitCodes).toEqual([1])
  })

  test('warns when a client has only conditional or experimental native candidates', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.models = [{
      id: 'claude-conditional',
      name: 'Claude conditional',
      routes: {
        anthropicMessages: { mode: 'direct', maturity: 'conditional' },
      },
    }]

    const result = await executeDoctor({
      client: 'claude',
      fetch: async () => Response.json(diagnostics),
    })

    expect(findCheck(result, 'client.claude')).toMatchObject({ status: 'warn' })
    expect(findCheck(result, 'client.claude')?.message).toContain('claude-conditional')
    expect(findCheck(result, 'client.claude')?.message).toContain('run the relevant live probe')
    expect(result.report.status).toBe('warn')
    expect(result.exitCodes).toEqual([0])
  })

  test.each([false, true])('fails diagnostics 404 without legacy probes (json=%s)', async (json) => {
    const calls: string[] = []
    const result = await executeDoctor({
      client: 'codex',
      json,
      fetch: async (input) => {
        const pathname = new URL(input).pathname
        calls.push(pathname)
        return Response.json({ error: '404-body-must-not-print' }, { status: 404 })
      },
    })

    expect(calls).toEqual(['/diagnostics'])
    expect(result.report).toMatchObject({
      status: 'fail',
      mode: 'full',
      summary: { pass: 0 },
    })
    expect(findCheck(result, 'service')).toMatchObject({ status: 'fail' })
    expect(findCheck(result, 'service')?.message).toContain('HTTP 404')
    expect(findCheck(result, 'service')?.message).toContain('service base URL and reverse-proxy routing')
    expect(findCheck(result, 'service')?.message).toContain('upgrade the server')
    expect(findCheck(result, 'readiness')).toMatchObject({ status: 'fail' })
    expect(findCheck(result, 'models')).toMatchObject({ status: 'fail' })
    expect(findCheck(result, 'client.codex')).toMatchObject({ status: 'fail' })
    expect(result.output).not.toContain('404-body-must-not-print')
    if (json)
      expect(JSON.parse(result.output)).toEqual(result.report)
    else
      expect(result.output).toContain('Summary: FAIL')
    expect(result.exitCodes).toEqual([1])
  })

  test('fails safely when the endpoint is unreachable', async () => {
    const calls: string[] = []
    const result = await executeDoctor({
      client: 'claude',
      fetch: async (input) => {
        calls.push(input)
        throw new TypeError('connection refused with secret details')
      },
    })

    expect(calls).toEqual(['http://127.0.0.1:4399/diagnostics'])
    expect(findCheck(result, 'service')).toMatchObject({
      status: 'fail',
      message: 'Cannot reach the proxy service.',
    })
    expect(result.output).not.toContain('secret details')
    expect(result.report.status).toBe('fail')
    expect(result.exitCodes).toEqual([1])
  })

  test('returns a failed report for a real diagnostics endpoint that hangs', async () => {
    const server = createServer(() => {
      // Deliberately never send response headers. The doctor request must own
      // its timeout instead of relying on the endpoint to close the socket.
    })
    await listenOnLoopback(server)

    try {
      const startedAt = Date.now()
      const result = await executeDoctor({
        client: 'claude',
        endpoint: serverEndpoint(server),
        fetch: directFetch,
        timeoutMs: 75,
      })

      expect(Date.now() - startedAt).toBeLessThan(2_000)
      expect(findCheck(result, 'service')).toMatchObject({
        status: 'fail',
        message: 'Diagnostics request timed out after 75ms.',
      })
      expect(result.report.status).toBe('fail')
      expect(result.output).toContain('Summary: FAIL')
      expect(result.exitCodes).toEqual([1])
    }
    finally {
      await closeServer(server)
    }
  })

  test('real source and packaged CLI preserve full diagnostics and never fall back on 404', async () => {
    const fixture = createPackagedCliFixture()
    const calls: string[] = []
    let status = 200
    const server = createServer((request, response) => {
      calls.push(request.url ?? '')
      response.writeHead(request.url === '/diagnostics' ? status : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(status === 200 ? successDiagnostics() : { error: '404-body-must-not-print' }))
    })

    try {
      await listenOnLoopback(server)
      const endpoint = serverEndpoint(server)
      for (const entrypoint of [
        { path: path.resolve('src/main.ts'), runtime: process.execPath },
        { path: fixture.entrypoint, runtime: 'node' },
      ]) {
        for (status of [200, 404]) {
          for (const json of [false, true]) {
            calls.length = 0
            const result = await runDoctorCli([
              '--endpoint',
              endpoint,
              '--client',
              'all',
              ...(json ? ['--json'] : []),
            ], entrypoint)
            expect(result.error).toBeUndefined()
            expect(result.status).toBe(status === 200 ? 0 : 1)
            expect(calls).toEqual(['/diagnostics'])
            if (json) {
              const report = JSON.parse(result.stdout) as Record<string, unknown>
              expect(Object.keys(report).sort()).toEqual(['checks', 'client', 'endpoint', 'mode', 'status', 'summary'])
              expect(report).toMatchObject({
                status: status === 200 ? 'pass' : 'fail',
                mode: 'full',
                endpoint,
                client: 'all',
              })
            }
            else {
              expect(result.stdout).toContain('Mode: full diagnostics')
              expect(result.stdout).toContain(status === 200 ? 'Summary: PASS' : 'Summary: FAIL')
            }
            if (status === 404)
              expect(result.stdout).toContain('Diagnostics endpoint /diagnostics returned HTTP 404')
            expect(`${result.stdout}\n${result.stderr}`).not.toContain('404-body-must-not-print')
          }
        }
      }
    }
    finally {
      try {
        if (server.listening)
          await closeServer(server)
      }
      finally {
        fixture.cleanup()
      }
    }
  }, 60_000)

  test('emits a safe machine-readable JSON report', async () => {
    const diagnostics = successDiagnostics() as ReturnType<typeof successDiagnostics> & {
      authorization?: string
    }
    diagnostics.authorization = 'Bearer must-not-print'
    Object.assign(diagnostics.readiness.token, {
      token: 'copilot-token-must-not-print',
    })
    diagnostics.usage = {
      status: 'available',
      data: { access_token: 'usage-secret-must-not-print' },
    }

    const result = await executeDoctor({
      client: 'claude',
      json: true,
      fetch: async () => Response.json(diagnostics),
    })
    const output = JSON.parse(result.output) as Record<string, unknown>

    expect(output).toMatchObject({
      status: 'pass',
      mode: 'full',
      endpoint: 'http://127.0.0.1:4399',
      client: 'claude',
    })
    expect(result.output).not.toContain('must-not-print')
    expect(result.exitCodes).toEqual([0])
  })

  test('real CLI JSON and text modes fail malformed endpoint lifecycle data without leaking values', async () => {
    const diagnostics = successDiagnostics()
    diagnostics.readiness.token.expiresInMs = 'cli-expiry-value-must-not-print'
    diagnostics.readiness.token.refreshInFlight = 'cli-refresh-value-must-not-print'
    const server = createServer((request, response) => {
      if (request.url !== '/diagnostics') {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(diagnostics))
    })
    await listenOnLoopback(server)

    try {
      const endpoint = serverEndpoint(server)
      const jsonResult = await runDoctorCli(['--json', '--endpoint', endpoint])
      expect(jsonResult.error).toBeUndefined()
      expect(jsonResult.status).toBe(1)
      const jsonReport = JSON.parse(jsonResult.stdout) as {
        checks: Array<{ id: string, message: string, status: string }>
        status: string
      }
      expect(jsonReport.status).toBe('fail')
      const jsonAuthCheck = jsonReport.checks.find(check => check.id === 'auth')
      expect(jsonAuthCheck?.status).toBe('fail')
      expect(jsonAuthCheck?.message).toMatch(/expiresInMs/)
      expect(jsonAuthCheck?.message).toMatch(/refreshInFlight/)

      const textResult = await runDoctorCli(['--endpoint', endpoint])
      expect(textResult.error).toBeUndefined()
      expect(textResult.status).toBe(1)
      expect(textResult.stdout).toContain('[FAIL] Authentication and token:')
      expect(textResult.stdout).toContain('expiresInMs')
      expect(textResult.stdout).toContain('refreshInFlight')
      expect(textResult.stdout).toContain('Summary: FAIL')

      const combinedOutput = [
        jsonResult.stdout,
        jsonResult.stderr,
        textResult.stdout,
        textResult.stderr,
      ].join('\n')
      expect(combinedOutput).not.toContain('cli-expiry-value-must-not-print')
      expect(combinedOutput).not.toContain('cli-refresh-value-must-not-print')
    }
    finally {
      await closeServer(server)
    }
  }, 25_000)

  test('keeps command initialization logs on stderr in JSON mode', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve('src/main.ts'),
        'doctor',
        '--json',
        '--endpoint',
        'http://127.0.0.1:1',
      ],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          CONSOLA_LEVEL: '4',
        },
        timeout: 10_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(() => JSON.parse(result.stdout)).not.toThrow()
    expect(result.stdout.trimStart().startsWith('{')).toBe(true)
    expect(result.stderr).toContain('HTTP proxy environment disabled')
  }, 15_000)
})

async function runDoctorCli(args: string[], entrypoint = {
  path: path.resolve('src/main.ts'),
  runtime: process.execPath,
}): Promise<{
  error?: Error
  status: number | null
  stderr: string
  stdout: string
}> {
  return await new Promise((resolve) => {
    const child = spawn(
      entrypoint.runtime,
      [entrypoint.path, 'doctor', ...args],
      {
        cwd: path.resolve('.'),
        env: removeProxyVariables(process.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      },
    )
    let stdout = ''
    let stderr = ''
    let spawnError: Error | undefined
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (status) => {
      resolve({ error: spawnError, status, stderr, stdout })
    })
  })
}

function removeProxyVariables(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
  ]) {
    delete env[key]
  }
  return env
}

function inMemoryJsonResponse(body: unknown): Response {
  return {
    json: async () => body,
    ok: true,
    status: 200,
  } as Response
}

async function executeDoctor(options: {
  client: DoctorClient
  endpoint?: string
  fetch?: NonNullable<DoctorDependencies['fetch']>
  json?: boolean
  signal?: AbortSignal
  timeoutMs?: number
}) {
  let output = ''
  const exitCodes: number[] = []
  const doctorOptions: DoctorOptions = {
    endpoint: options.endpoint ?? 'http://127.0.0.1:4399/',
    client: options.client,
    json: options.json ?? false,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  }
  const report = await runDoctor(doctorOptions, {
    ...(options.fetch && { fetch: options.fetch }),
    write: (value) => {
      output += value
    },
    setExitCode: (exitCode) => {
      exitCodes.push(exitCode)
    },
  })
  return { report, output, exitCodes }
}

function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function serverEndpoint(server: ReturnType<typeof createServer>): string {
  const address = server.address() as AddressInfo | null
  if (!address)
    throw new Error('Expected the hanging test server to be listening')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error)
        reject(error)
      else
        resolve()
    })
    server.closeAllConnections()
  })
}

function findCheck(
  result: Awaited<ReturnType<typeof executeDoctor>>,
  id: string,
) {
  const item = result.report.checks.find(check => check.id === id)
  expect(item).toBeDefined()
  return item
}

function successDiagnostics() {
  return {
    status: 'ready',
    generated_at: '2026-07-17T00:00:00.000Z',
    readiness: {
      status: 'ready',
      reasons: [] as string[],
      warnings: [] as string[],
      token: {
        consecutiveRefreshFailures: 0,
        expiresAt: Date.now() + 3_600_000,
        tokenAvailable: true,
        expiresInMs: 3_600_000,
        generation: 1,
        nextRefreshAt: Date.now() + 3_000_000,
        refreshScheduled: true,
        refreshInFlight: false,
        reactiveRefreshInFlight: false,
      } as Record<string, unknown>,
      recovery: {
        globalCircuit: { phase: 'closed' } as Record<string, unknown>,
        scopes: {
          tracked: 0,
          open: 0,
          halfOpen: 0,
        } as Record<string, unknown>,
      },
      concurrency: {
        enabled: true,
        maxConcurrency: 4,
        maxQueue: 8,
        active: 0,
        queued: 0,
      } as Record<string, unknown>,
    },
    models: [modelProfile({
      chatCompletions: { mode: 'direct' },
      responsesHttp: { mode: 'direct' },
      responsesWebSocket: { mode: 'direct' },
      anthropicMessages: { mode: 'direct' },
    })],
    usage: { status: 'available', data: { quota: 'ok' } } as Record<string, unknown>,
  }
}

function modelProfile(routes: Record<string, { maturity?: string, mode: string }>): {
  id: string
  name: string
  routes: Record<string, { maturity?: string, mode: string }>
} {
  return {
    id: 'omni-test-model',
    name: 'Omni test model',
    routes,
  }
}
