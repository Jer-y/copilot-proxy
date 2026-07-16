import type { AddressInfo, Socket } from 'node:net'

import type WebSocket from 'ws'

import type { ConnectCopilotResponsesWebSocketDeps } from '~/services/copilot/responses-websocket'

import { Buffer } from 'node:buffer'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { HTTPError, UpstreamTimeoutError } from '~/lib/error'
import { state } from '~/lib/state'
import {
  configureCopilotFetchTimeouts,
  getCopilotWebSocketHandshakeTimeoutMs,
  resolveRuntimeProxyForUrl,
} from '~/lib/upstream-fetch'
import {
  connectAuthenticatedCopilotResponsesWebSocket,
  openCopilotResponsesWebSocketAttempt,
} from '~/services/copilot/responses-websocket'

function fakeSocket(): WebSocket {
  return {} as WebSocket
}

async function startBlackHoleServer(): Promise<{
  close: () => Promise<void>
  url: string
}> {
  const acceptedSockets = new Set<Socket>()
  const server = createServer((socket) => {
    acceptedSockets.add(socket)
    socket.once('close', () => acceptedSockets.delete(socket))
    socket.on('error', () => {})
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    close: async () => {
      for (const socket of acceptedSockets)
        socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error)
            reject(error)
          else
            resolve()
        })
      })
    },
    url: `ws://127.0.0.1:${address.port}/responses`,
  }
}

async function startUnexpectedHandshakeServer(
  status: 200 | 204 | 304,
  body: string,
): Promise<{
  close: () => Promise<void>
  url: string
}> {
  const acceptedSockets = new Set<Socket>()
  const statusText = status === 200
    ? 'OK'
    : status === 204
      ? 'No Content'
      : 'Not Modified'
  const server = createServer((socket) => {
    acceptedSockets.add(socket)
    socket.once('close', () => acceptedSockets.delete(socket))
    socket.on('error', () => {})
    socket.once('data', () => {
      socket.end([
        `HTTP/1.1 ${status} ${statusText}`,
        'Connection: close',
        `Content-Length: ${Buffer.byteLength(body)}`,
        `X-Original-Handshake-Status: ${status}`,
        '',
        body,
      ].join('\r\n'))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  return {
    close: async () => {
      for (const socket of acceptedSockets)
        socket.destroy()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error)
            reject(error)
          else
            resolve()
        })
      })
    },
    url: `ws://127.0.0.1:${address.port}/responses`,
  }
}

async function runNodeHandshakeTimeoutProbe(url: string): Promise<{
  elapsedMs: number
  isUpstreamTimeout: boolean
  message: string
  name: string
  status: number
  target: string
  timeoutMs: number
}> {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'copilot-proxy-node-ws-timeout-'))
  const entryPath = join(temporaryDirectory, 'probe.ts')
  const outputDirectory = join(temporaryDirectory, 'dist')
  const upstreamFetchPath = join(repoRoot, 'src/lib/upstream-fetch.ts')
  const errorPath = join(repoRoot, 'src/lib/error.ts')
  const responsesWebSocketPath = join(repoRoot, 'src/services/copilot/responses-websocket.ts')

  try {
    await Bun.write(entryPath, `
      import { UpstreamTimeoutError } from ${JSON.stringify(errorPath)}
      import { configureCopilotFetchTimeouts } from ${JSON.stringify(upstreamFetchPath)}
      import { openCopilotResponsesWebSocketAttempt } from ${JSON.stringify(responsesWebSocketPath)}

      configureCopilotFetchTimeouts({ connectTimeoutMs: 25, headersTimeoutMs: 250 })
      const startedAt = performance.now()
      try {
        const result = await openCopilotResponsesWebSocketAttempt(process.argv[2], {})
        result.ok && result.socket.terminate()
        process.stdout.write(JSON.stringify({ unexpectedSuccess: true }))
        process.exitCode = 2
      }
      catch (error) {
        process.stdout.write(JSON.stringify({
          elapsedMs: performance.now() - startedAt,
          isUpstreamTimeout: error instanceof UpstreamTimeoutError,
          message: error instanceof Error ? error.message : String(error),
          name: error instanceof Error ? error.name : typeof error,
          status: error instanceof UpstreamTimeoutError ? error.status : 0,
          target: error instanceof UpstreamTimeoutError ? error.target : '',
          timeoutMs: error instanceof UpstreamTimeoutError ? error.timeoutMs : 0,
        }))
      }
    `)

    const build = await Bun.build({
      entrypoints: [entryPath],
      format: 'esm',
      outdir: outputDirectory,
      packages: 'bundle',
      root: repoRoot,
      target: 'node',
      tsconfig: join(repoRoot, 'tsconfig.json'),
    })
    if (!build.success) {
      throw new Error(`Failed to build Node handshake probe: ${build.logs.map(log => log.message).join('; ')}`)
    }
    await Bun.write(join(outputDirectory, 'package.json'), '{"type":"module"}\n')

    const child = Bun.spawn(['node', build.outputs[0].path, url], {
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const watchdog = setTimeout(() => child.kill(), 3_000)
    try {
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ])
      if (exitCode !== 0)
        throw new Error(`Node handshake probe exited ${exitCode}: ${stderr || stdout}`)
      return JSON.parse(stdout) as Awaited<ReturnType<typeof runNodeHandshakeTimeoutProbe>>
    }
    finally {
      clearTimeout(watchdog)
    }
  }
  finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

async function runNodeUnexpectedHandshakeProbe(url: string): Promise<{
  body: string
  originalStatusHeader: string | null
  status: number
  statusText: string
}> {
  const repoRoot = fileURLToPath(new URL('../', import.meta.url))
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'copilot-proxy-node-ws-response-'))
  const entryPath = join(temporaryDirectory, 'probe.ts')
  const outputDirectory = join(temporaryDirectory, 'dist')
  const responsesWebSocketPath = join(repoRoot, 'src/services/copilot/responses-websocket.ts')

  try {
    await Bun.write(entryPath, `
      import { openCopilotResponsesWebSocketAttempt } from ${JSON.stringify(responsesWebSocketPath)}

      const result = await openCopilotResponsesWebSocketAttempt(process.argv[2], {})
      if (result.ok) {
        result.socket.terminate()
        process.stdout.write(JSON.stringify({ unexpectedSuccess: true }))
        process.exitCode = 2
      }
      else {
        process.stdout.write(JSON.stringify({
          body: await result.response.text(),
          originalStatusHeader: result.response.headers.get('x-original-handshake-status'),
          status: result.response.status,
          statusText: result.response.statusText,
        }))
      }
    `)

    const build = await Bun.build({
      entrypoints: [entryPath],
      format: 'esm',
      outdir: outputDirectory,
      packages: 'bundle',
      root: repoRoot,
      target: 'node',
      tsconfig: join(repoRoot, 'tsconfig.json'),
    })
    if (!build.success) {
      throw new Error(`Failed to build Node handshake response probe: ${build.logs.map(log => log.message).join('; ')}`)
    }
    await Bun.write(join(outputDirectory, 'package.json'), '{"type":"module"}\n')

    const child = Bun.spawn(['node', build.outputs[0].path, url], {
      env: {
        ...process.env,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    })
    const watchdog = setTimeout(() => child.kill(), 3_000)
    try {
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ])
      if (exitCode !== 0)
        throw new Error(`Node handshake response probe exited ${exitCode}: ${stderr || stdout}`)
      return JSON.parse(stdout) as Awaited<ReturnType<typeof runNodeUnexpectedHandshakeProbe>>
    }
    finally {
      clearTimeout(watchdog)
    }
  }
  finally {
    await rm(temporaryDirectory, { force: true, recursive: true })
  }
}

describe('authenticated Copilot Responses WebSocket connection', () => {
  let originalAccountType: typeof state.accountType
  let originalToken: string | undefined

  beforeEach(() => {
    originalAccountType = state.accountType
    originalToken = state.copilotToken
    state.accountType = 'individual'
    state.copilotToken = 'old-token'
  })

  afterEach(() => {
    state.accountType = originalAccountType
    state.copilotToken = originalToken
  })

  test('rebuilds authorization and request IDs for every authenticated attempt', async () => {
    const socket = fakeSocket()
    const attemptHeaders: Array<Record<string, string>> = []
    const openAttempt: NonNullable<ConnectCopilotResponsesWebSocketDeps['openAttempt']> = mock(async (_url, headers) => {
      attemptHeaders.push(headers)
      return attemptHeaders.length === 1
        ? {
            ok: false as const,
            response: new Response('Unauthorized', { status: 401 }),
          }
        : {
            headers: new Headers({ 'x-request-id': 'upstream-upgrade-id' }),
            ok: true as const,
            socket,
          }
    })
    const fetchAuthenticated: NonNullable<ConnectCopilotResponsesWebSocketDeps['fetchAuthenticated']> = mock(async (options) => {
      const firstResponse = await options.request(0)
      expect(firstResponse.status).toBe(401)
      state.copilotToken = 'new-token'
      return await options.request(1)
    })

    const connection = await connectAuthenticatedCopilotResponsesWebSocket({
      hasVision: true,
      initiator: 'agent',
      model: 'gpt-test',
    }, {
      fetchAuthenticated,
      openAttempt,
    })

    expect(connection.socket).toBe(socket)
    expect(openAttempt).toHaveBeenCalledTimes(2)
    expect(attemptHeaders.map(headers => headers.Authorization)).toEqual([
      'Bearer old-token',
      'Bearer new-token',
    ])
    expect(attemptHeaders[0]['x-request-id']).not.toBe(attemptHeaders[1]['x-request-id'])
    expect(attemptHeaders.map(headers => headers['X-Initiator'])).toEqual(['agent', 'agent'])
    expect(attemptHeaders.every(headers => headers['copilot-vision-request'] === 'true')).toBe(true)

    await connection.releaseInitialTurn()
  })

  test('holds the authenticated response lease until the initial turn is released', async () => {
    const socket = fakeSocket()
    let released = 0
    const openAttempt: NonNullable<ConnectCopilotResponsesWebSocketDeps['openAttempt']> = mock(async () => ({
      headers: new Headers(),
      ok: true as const,
      socket,
    }))
    const fetchAuthenticated: NonNullable<ConnectCopilotResponsesWebSocketDeps['fetchAuthenticated']> = mock(async (options) => {
      const permitResponse = await options.request(0)
      return new Response(new ReadableStream<Uint8Array>({
        async cancel(reason) {
          released++
          await permitResponse.body?.cancel(reason)
        },
      }), {
        headers: permitResponse.headers,
        status: permitResponse.status,
        statusText: permitResponse.statusText,
      })
    })

    const connection = await connectAuthenticatedCopilotResponsesWebSocket({
      hasVision: false,
      initiator: 'user',
      model: 'gpt-test',
    }, {
      fetchAuthenticated,
      openAttempt,
    })

    expect(released).toBe(0)
    await connection.releaseInitialTurn()
    expect(released).toBe(1)
    await connection.releaseInitialTurn()
    expect(released).toBe(1)
  })

  test('turns a rejected handshake into an HTTPError with a reusable body', async () => {
    const openAttempt: NonNullable<ConnectCopilotResponsesWebSocketDeps['openAttempt']> = mock(async () => ({
      ok: false as const,
      response: new Response('account is not allowed', {
        headers: { 'x-github-request-id': 'github-request-id' },
        status: 403,
        statusText: 'Forbidden',
      }),
    }))
    const fetchAuthenticated: NonNullable<ConnectCopilotResponsesWebSocketDeps['fetchAuthenticated']> = mock(async options => await options.request(0))

    const error = await connectAuthenticatedCopilotResponsesWebSocket({
      hasVision: false,
      initiator: 'user',
      model: 'gpt-test',
    }, {
      fetchAuthenticated,
      openAttempt,
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(HTTPError)
    const httpError = error as HTTPError
    expect(httpError.response.status).toBe(403)
    expect(httpError.response.headers.get('x-github-request-id')).toBe('github-request-id')
    expect(await httpError.text()).toBe('account is not allowed')
    expect(await httpError.response.text()).toBe('account is not allowed')
  })

  test.each([
    { body: 'ordinary HTTP response', status: 200 },
    { body: null, status: 204 },
    { body: null, status: 304 },
  ])('normalizes a non-101 $status handshake response to 502', async ({ body, status }) => {
    const openAttempt: NonNullable<ConnectCopilotResponsesWebSocketDeps['openAttempt']> = mock(async () => ({
      ok: false as const,
      response: new Response(body, {
        headers: { 'x-upstream-handshake-status': String(status) },
        status,
      }),
    }))
    const fetchAuthenticated: NonNullable<ConnectCopilotResponsesWebSocketDeps['fetchAuthenticated']> = mock(async options => await options.request(0))

    const error = await connectAuthenticatedCopilotResponsesWebSocket({
      hasVision: false,
      initiator: 'user',
      model: 'gpt-test',
    }, {
      fetchAuthenticated,
      openAttempt,
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(HTTPError)
    const httpError = error as HTTPError
    expect(httpError.response.status).toBe(502)
    expect(httpError.response.statusText).toBe('Bad Gateway')
    expect(httpError.response.headers.get('x-upstream-handshake-status')).toBe(String(status))
    expect(await httpError.text()).toBe(body ?? '')
    expect(await httpError.response.text()).toBe(body ?? '')
  })

  test('preserves a rejected 5xx handshake for upstream failure handling', async () => {
    const openAttempt: NonNullable<ConnectCopilotResponsesWebSocketDeps['openAttempt']> = mock(async () => ({
      ok: false as const,
      response: new Response('upstream unavailable', {
        headers: { 'retry-after': '3' },
        status: 503,
        statusText: 'Service Unavailable',
      }),
    }))
    const fetchAuthenticated: NonNullable<ConnectCopilotResponsesWebSocketDeps['fetchAuthenticated']> = mock(async options => await options.request(0))

    const error = await connectAuthenticatedCopilotResponsesWebSocket({
      hasVision: false,
      initiator: 'user',
      model: 'gpt-test',
    }, {
      fetchAuthenticated,
      openAttempt,
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(HTTPError)
    const httpError = error as HTTPError
    expect(httpError.response.status).toBe(503)
    expect(httpError.response.statusText).toBe('Service Unavailable')
    expect(httpError.response.headers.get('retry-after')).toBe('3')
    expect(await httpError.text()).toBe('upstream unavailable')
  })
})

describe('Copilot WebSocket proxy and handshake timeout helpers', () => {
  const proxyKeys = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'all_proxy',
  ] as const
  const originalProxyEnvironment = Object.fromEntries(
    proxyKeys.map(key => [key, process.env[key]]),
  ) as Record<typeof proxyKeys[number], string | undefined>

  afterEach(() => {
    for (const key of proxyKeys) {
      const value = originalProxyEnvironment[key]
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
    configureCopilotFetchTimeouts({})
  })

  test('maps wss targets through the required HTTPS proxy route', () => {
    for (const key of proxyKeys)
      delete process.env[key]
    process.env.HTTPS_PROXY = 'http://proxy.example.test:8080'
    configureCopilotFetchTimeouts({ proxyEnv: true })

    expect(resolveRuntimeProxyForUrl('wss://api.githubcopilot.com/responses'))
      .toBe('http://proxy.example.test:8080')
  })

  test('uses the shortest enabled connection or header timeout for the handshake', () => {
    configureCopilotFetchTimeouts({
      connectTimeoutMs: 37,
      headersTimeoutMs: 91,
    })
    expect(getCopilotWebSocketHandshakeTimeoutMs()).toBe(37)

    configureCopilotFetchTimeouts({
      connectTimeoutMs: 0,
      headersTimeoutMs: 53,
    })
    expect(getCopilotWebSocketHandshakeTimeoutMs()).toBe(53)

    configureCopilotFetchTimeouts({
      connectTimeoutMs: 0,
      headersTimeoutMs: 0,
    })
    expect(getCopilotWebSocketHandshakeTimeoutMs()).toBe(0)
  })

  test('enforces the configured handshake timeout against a black-hole server under Bun', async () => {
    const blackHole = await startBlackHoleServer()
    configureCopilotFetchTimeouts({
      connectTimeoutMs: 25,
      headersTimeoutMs: 250,
    })

    const startedAt = performance.now()
    try {
      const error = await openCopilotResponsesWebSocketAttempt(blackHole.url, {})
        .catch((reason: unknown) => reason)
      const elapsedMs = performance.now() - startedAt

      expect(error).toBeInstanceOf(UpstreamTimeoutError)
      expect(error).toMatchObject({
        status: 504,
        target: blackHole.url,
        timeoutMs: 25,
      })
      expect(elapsedMs).toBeGreaterThanOrEqual(15)
      expect(elapsedMs).toBeLessThan(1_000)
    }
    finally {
      await blackHole.close()
    }
  })

  test('maps the explicit handshake timeout to UpstreamTimeoutError under Node', async () => {
    const blackHole = await startBlackHoleServer()
    try {
      const result = await runNodeHandshakeTimeoutProbe(blackHole.url)

      expect(result).toMatchObject({
        isUpstreamTimeout: true,
        name: 'UpstreamTimeoutError',
        status: 504,
        target: blackHole.url,
        timeoutMs: 25,
      })
      expect(result.message).toContain('Upstream WebSocket handshake timed out after 25ms')
      expect(result.elapsedMs).toBeGreaterThanOrEqual(15)
      expect(result.elapsedMs).toBeLessThan(1_000)
    }
    finally {
      await blackHole.close()
    }
  })

  test.each([
    { body: 'ordinary HTTP response', status: 200 as const },
    { body: '', status: 204 as const },
    { body: '', status: 304 as const },
  ])('normalizes a real non-101 Node handshake response with status $status', async ({ body, status }) => {
    const upstream = await startUnexpectedHandshakeServer(status, body)
    try {
      const result = await runNodeUnexpectedHandshakeProbe(upstream.url)

      expect(result).toEqual({
        body,
        originalStatusHeader: String(status),
        status: 502,
        statusText: 'Bad Gateway',
      })
    }
    finally {
      await upstream.close()
    }
  })

  test('preserves caller AbortError semantics while a handshake is pending', async () => {
    const blackHole = await startBlackHoleServer()
    const abortController = new AbortController()
    configureCopilotFetchTimeouts({
      connectTimeoutMs: 1_000,
      headersTimeoutMs: 1_000,
    })
    const abortTimer = setTimeout(() => abortController.abort(), 25)

    try {
      const error = await openCopilotResponsesWebSocketAttempt(
        blackHole.url,
        {},
        abortController.signal,
      ).catch((reason: unknown) => reason)

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(UpstreamTimeoutError)
      expect(error).toMatchObject({
        message: 'Copilot Responses WebSocket handshake was cancelled',
        name: 'AbortError',
      })
    }
    finally {
      clearTimeout(abortTimer)
      await blackHole.close()
    }
  })
})
