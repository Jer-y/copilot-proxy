import type { CodexClientCatalog } from '~/lib/client-setup'
import type { Model } from '~/services/copilot/get-models'
import type { SetupOptions, SetupProbeOutcome, SetupWebSocketSemanticValidation } from '~/setup'

import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, mock, test } from 'bun:test'
import { WebSocketServer } from 'ws'

import { resolveRunPreset } from '~/lib/run-presets'
import { state } from '~/lib/state'
import { buildSetupStartCommand, fetchDirectSetupProbe, fetchDirectSetupWebSocketProbe, findExistingClientConfigs, runDisposableSetupProbe, runSetup, setupProxyRequiredTargets } from '~/setup'

function model(id: string, endpoints: string[]): Model {
  return {
    id,
    name: id,
    vendor: id.startsWith('claude') ? 'Anthropic' : 'OpenAI',
    version: '1',
    object: 'model',
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
      object: 'model_capabilities',
      supports: { tool_calls: true },
      tokenizer: 'test',
      type: 'chat',
    },
  }
}

const MODELS = [
  model('gpt-setup', ['/responses', 'ws:/responses']),
  model('claude-setup', ['/v1/messages']),
]

const CODEX_CLIENT_CATALOG: CodexClientCatalog = {
  command: 'codex',
  modelSlugs: ['gpt-setup', 'gpt-http-only'],
  version: '0.144.6',
}

async function inspectCodexClient(): Promise<CodexClientCatalog> {
  return CODEX_CLIENT_CATALOG
}

function probeOutcome(
  path: SetupProbeOutcome['path'],
  semanticValidation: SetupWebSocketSemanticValidation = 'passed',
  advertised = semanticValidation === 'passed',
  failure?: string,
  httpTransport: SetupProbeOutcome['httpTransport'] = 'sse',
): SetupProbeOutcome {
  return {
    httpTransport,
    path,
    websocket: {
      advertised,
      semanticValidation,
      ...(failure && { failure }),
    },
  }
}

function eventStream(frames: Array<Record<string, unknown>>): string {
  return frames
    .map(frame => `event: ${String(frame.type)}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join('')
}

function options(overrides: Partial<SetupOptions> = {}): SetupOptions {
  return {
    accountType: 'individual',
    client: 'codex',
    copy: false,
    host: '127.0.0.1',
    json: false,
    model: 'gpt-setup',
    port: 4399,
    preset: resolveRunPreset('personal'),
    proxyEnv: false,
    ...overrides,
  }
}

describe('runSetup', () => {
  test('uses a direct local transport when global fetch is fail-closed', async () => {
    const received: { body?: unknown, contentType?: string, method?: string } = {}
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        received.body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        received.contentType = request.headers['content-type']
        received.method = request.method
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    const originalFetch = globalThis.fetch
    const failClosedFetch = mock(async () => {
      throw new Error('--proxy-env requires a proxy route; refusing a direct connection')
    }) as unknown as typeof fetch
    globalThis.fetch = failClosedFetch

    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP address')

      const response = await fetchDirectSetupProbe(
        `http://127.0.0.1:${address.port}/v1/responses`,
        { input: 'COPILOT_PROXY_SETUP_PROBE' },
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(received).toEqual({
        body: { input: 'COPILOT_PROXY_SETUP_PROBE' },
        contentType: 'application/json',
        method: 'POST',
      })
      expect(failClosedFetch).not.toHaveBeenCalled()
    }
    finally {
      globalThis.fetch = originalFetch
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  })

  test('times out a hanging direct probe and closes its socket', async () => {
    const server = createServer((request) => {
      request.resume()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP address')

      await expect(fetchDirectSetupProbe(
        `http://127.0.0.1:${address.port}/hang`,
        { probe: true },
        { timeoutMs: 50 },
      )).rejects.toThrow('Direct setup probe timed out after 50ms')
    }
    finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  })

  test('rejects invalid direct probe timeout values before opening a socket', async () => {
    await expect(fetchDirectSetupProbe(
      'http://127.0.0.1:1/v1/responses',
      { probe: true },
      { timeoutMs: 1.5 },
    )).rejects.toThrow('must be a positive integer')
    await expect(fetchDirectSetupProbe(
      'http://127.0.0.1:1/v1/responses',
      { probe: true },
      { timeoutMs: Number.MAX_SAFE_INTEGER },
    )).rejects.toThrow('must be a positive integer')
  })

  test('aborts a direct probe from a caller signal and closes its socket', async () => {
    const controller = new AbortController()
    const server = createServer((request) => {
      request.resume()
      controller.abort(new Error('caller cancelled setup probe'))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })

    try {
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP address')

      await expect(fetchDirectSetupProbe(
        `http://127.0.0.1:${address.port}/abort`,
        { probe: true },
        { signal: controller.signal, timeoutMs: 1_000 },
      )).rejects.toThrow('caller cancelled setup probe')
    }
    finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
      })
    }
  })

  test('validates the exact setup sentinel through a real local Responses WebSocket', async () => {
    const webSocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const paths: string[] = []
    const events: Array<Record<string, unknown>> = []
    webSocketServer.on('connection', (socket, request) => {
      paths.push(request.url ?? '')
      socket.once('message', (rawData) => {
        const event = JSON.parse(rawData.toString()) as Record<string, unknown>
        events.push(event)
        if (event.input === 'force-failure') {
          socket.send(JSON.stringify({
            type: 'response.failed',
            response: {
              error: { code: 'upstream_error' },
              status: 'failed',
            },
          }))
          return
        }
        const text = event.input === 'force-mismatch'
          ? 'WRONG_SETUP_SENTINEL'
          : 'COPILOT_PROXY_SETUP_OK'
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text }],
            }],
          },
        }))
      })
    })
    await new Promise<void>((resolve, reject) => {
      webSocketServer.once('error', reject)
      webSocketServer.once('listening', resolve)
    })

    try {
      const address = webSocketServer.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP address')
      const url = `ws://127.0.0.1:${address.port}/v1/responses`

      await expect(fetchDirectSetupWebSocketProbe(url, {
        input: 'Reply with the setup sentinel.',
        model: 'gpt-setup',
        store: false,
        stream: true,
      }, { timeoutMs: 1_000 })).resolves.toBeUndefined()
      await expect(fetchDirectSetupWebSocketProbe(url, {
        input: 'force-mismatch',
        model: 'gpt-setup',
        store: false,
      }, { timeoutMs: 1_000 })).rejects.toThrow('required COPILOT_PROXY_SETUP_OK response')
      await expect(fetchDirectSetupWebSocketProbe(url, {
        input: 'force-failure',
        model: 'gpt-setup',
        store: false,
      }, { timeoutMs: 1_000 })).rejects.toThrow('response.failed (upstream_error)')

      expect(paths).toEqual(['/v1/responses', '/v1/responses', '/v1/responses'])
      expect(events[0]).toMatchObject({
        type: 'response.create',
        input: 'Reply with the setup sentinel.',
        model: 'gpt-setup',
        store: false,
      })
      expect(events[0]).not.toHaveProperty('stream')
    }
    finally {
      for (const client of webSocketServer.clients)
        client.terminate()
      webSocketServer.close()
      await Bun.sleep(0)
    }
  })

  test('times out a hanging direct Responses WebSocket and closes it', async () => {
    const webSocketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    webSocketServer.on('connection', (socket) => {
      socket.on('message', () => {})
    })
    await new Promise<void>((resolve, reject) => {
      webSocketServer.once('error', reject)
      webSocketServer.once('listening', resolve)
    })

    try {
      const address = webSocketServer.address()
      if (!address || typeof address === 'string')
        throw new Error('Expected a TCP address')
      await expect(fetchDirectSetupWebSocketProbe(
        `ws://127.0.0.1:${address.port}/v1/responses`,
        { input: 'hang', model: 'gpt-setup', store: false },
        { timeoutMs: 50 },
      )).rejects.toThrow('timed out after 50ms')

      const controller = new AbortController()
      const abortTimer = setTimeout(() => {
        controller.abort(new Error('caller cancelled setup WebSocket probe'))
      }, 20)
      await expect(fetchDirectSetupWebSocketProbe(
        `ws://127.0.0.1:${address.port}/v1/responses`,
        { input: 'hang until abort', model: 'gpt-setup', store: false },
        { signal: controller.signal, timeoutMs: 1_000 },
      )).rejects.toThrow('caller cancelled setup WebSocket probe')
      clearTimeout(abortTimer)
      await Bun.sleep(20)
      expect(webSocketServer.clients.size).toBe(0)
    }
    finally {
      for (const client of webSocketServer.clients)
        client.terminate()
      webSocketServer.close()
      await Bun.sleep(0)
    }
  })

  test('aborts all setup upstream routes without sharing global state with the test runner', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('tests/fixtures/setup-hanging-upstream.ts')],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 15_000,
      },
    )

    if (result.error)
      throw result.error
    if (result.status !== 0)
      throw new Error(`Isolated setup deadline probe exited ${String(result.status)}:\n${result.stderr || result.stdout}`)

    const resultLine = result.stdout
      .split('\n')
      .find(line => line.startsWith('SETUP_HANGING_PROBE_RESULT='))
    if (!resultLine)
      throw new Error(`Isolated setup deadline probe emitted no result:\n${result.stderr || result.stdout}`)
    const evidence = JSON.parse(resultLine.slice('SETUP_HANGING_PROBE_RESULT='.length)) as Array<{
      api: string
      elapsedMs: number
      upstreamPath: string
      upstreamSignalAborted: boolean
    }>

    expect(evidence.map(item => ({
      api: item.api,
      upstreamPath: item.upstreamPath,
      upstreamSignalAborted: item.upstreamSignalAborted,
    }))).toEqual([
      { api: 'responses', upstreamPath: '/responses', upstreamSignalAborted: true },
      { api: 'chat-completions', upstreamPath: '/chat/completions', upstreamSignalAborted: true },
      { api: 'anthropic-messages', upstreamPath: '/v1/messages', upstreamSignalAborted: true },
    ])
    expect(evidence.every(item => item.elapsedMs < 3_000)).toBe(true)
  }, 20_000)

  test('cancels a disposable setup token refresh and lets the process exit at the deadline', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('tests/fixtures/setup-recovery-deadline.ts')],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )
    if (result.error)
      throw result.error
    if (result.status !== 0)
      throw new Error(`Isolated setup recovery deadline probe exited ${String(result.status)}:\n${result.stderr || result.stdout}`)

    const resultLine = result.stdout
      .split('\n')
      .find(line => line.startsWith('SETUP_RECOVERY_DEADLINE_RESULT='))
    if (!resultLine)
      throw new Error(`Isolated setup recovery deadline probe emitted no result:\n${result.stderr || result.stdout}`)
    const evidence = JSON.parse(resultLine.slice('SETUP_RECOVERY_DEADLINE_RESULT='.length)) as {
      copilotAttempts: number
      consecutiveRefreshFailures: number
      lastReactiveRefreshOutcome: string
      reactiveRefreshInFlight: boolean
      reactiveRefreshFailures: number
      scenario: string
      setupElapsedMs: number
      tokenAttempts: number
      tokenCompleted: boolean
      tokenSignalAborted: boolean
    }

    expect(evidence).toMatchObject({
      copilotAttempts: 1,
      consecutiveRefreshFailures: 0,
      lastReactiveRefreshOutcome: 'cancelled',
      reactiveRefreshInFlight: false,
      reactiveRefreshFailures: 0,
      scenario: 'in-flight',
      tokenAttempts: 1,
      tokenCompleted: false,
      tokenSignalAborted: true,
    })
    expect(evidence.setupElapsedMs).toBeLessThan(750)
  }, 15_000)

  test('interrupts the production token retry backoff when disposable setup ends', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('tests/fixtures/setup-recovery-deadline.ts')],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          SETUP_RECOVERY_SCENARIO: 'backoff',
        },
        timeout: 10_000,
      },
    )
    if (result.error)
      throw result.error
    if (result.status !== 0)
      throw new Error(`Isolated setup recovery backoff probe exited ${String(result.status)}:\n${result.stderr || result.stdout}`)

    const resultLine = result.stdout
      .split('\n')
      .find(line => line.startsWith('SETUP_RECOVERY_DEADLINE_RESULT='))
    if (!resultLine)
      throw new Error(`Isolated setup recovery backoff probe emitted no result:\n${result.stderr || result.stdout}`)
    const evidence = JSON.parse(resultLine.slice('SETUP_RECOVERY_DEADLINE_RESULT='.length)) as {
      consecutiveRefreshFailures: number
      lastReactiveRefreshOutcome: string
      reactiveRefreshFailures: number
      scenario: string
      setupElapsedMs: number
      tokenAttempts: number
      tokenSignalAborted: boolean
    }

    expect(evidence).toMatchObject({
      consecutiveRefreshFailures: 0,
      lastReactiveRefreshOutcome: 'cancelled',
      reactiveRefreshFailures: 0,
      scenario: 'backoff',
      tokenAttempts: 1,
      tokenSignalAborted: true,
    })
    expect(evidence.setupElapsedMs).toBeLessThan(750)
    expect(result.stderr).not.toContain('Unexpected reactive Copilot token refresh failure')
    expect(result.stderr).not.toContain('Token refresh failed after')
  }, 15_000)

  test('cancels a scheduled token refresh that is already in flight when setup ends', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve('tests/fixtures/setup-recovery-deadline.ts')],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: {
          ...process.env,
          SETUP_RECOVERY_SCENARIO: 'scheduled',
        },
        timeout: 10_000,
      },
    )
    if (result.error)
      throw result.error
    if (result.status !== 0)
      throw new Error(`Isolated scheduled setup refresh probe exited ${String(result.status)}:\n${result.stderr || result.stdout}`)

    const resultLine = result.stdout
      .split('\n')
      .find(line => line.startsWith('SETUP_RECOVERY_DEADLINE_RESULT='))
    if (!resultLine)
      throw new Error(`Isolated scheduled setup refresh probe emitted no result:\n${result.stderr || result.stdout}`)
    const evidence = JSON.parse(resultLine.slice('SETUP_RECOVERY_DEADLINE_RESULT='.length)) as {
      lastReactiveRefreshOutcome: string
      reactiveRefreshInFlight: boolean
      scenario: string
      setupElapsedMs: number
      tokenAttempts: number
      tokenCompleted: boolean
      tokenSignalAborted: boolean
    }

    expect(evidence).toMatchObject({
      lastReactiveRefreshOutcome: 'cancelled',
      reactiveRefreshInFlight: false,
      scenario: 'scheduled',
      tokenAttempts: 1,
      tokenCompleted: false,
      tokenSignalAborted: true,
    })
    expect(evidence.setupElapsedMs).toBeLessThan(750)
  }, 15_000)

  test('rejects non-loopback disposable listeners before opening a server', async () => {
    for (const host of ['0.0.0.0', '::', '192.0.2.10', 'proxy.internal', 'foo.localhost', 'localhost.', '::1%lo', '[::1]']) {
      await expect(runDisposableSetupProbe({
        choice: {
          api: 'responses',
          model: MODELS[0]!,
          supportsWebSockets: true,
        },
        client: 'openai-sdk',
        host,
        port: 0,
        timeoutMs: 2_000,
      })).rejects.toThrow('setup requires a bindable loopback --host')
    }
  })

  test('validates the real Codex and Claude SSE routes through terminal events', async () => {
    const originalFetch = globalThis.fetch
    const originalState = {
      accountType: state.accountType,
      concurrencyLimiter: state.concurrencyLimiter,
      copilotToken: state.copilotToken,
      lastRequestTimestamp: state.lastRequestTimestamp,
      manualApprove: state.manualApprove,
      models: state.models,
      rateLimitSeconds: state.rateLimitSeconds,
      rateLimitWait: state.rateLimitWait,
      vsCodeVersion: state.vsCodeVersion,
    }
    const gptModel = model('gpt-stream-setup', ['/responses'])
    const claudeModel = model('claude-stream-setup', ['/v1/messages'])
    const forwarded: Array<{ path: string, stream: unknown }> = []

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      forwarded.push({ path: url.pathname, stream: body.stream })

      if (url.pathname === '/responses') {
        return new Response(eventStream([
          {
            type: 'response.created',
            response: { id: 'resp_setup_sse', object: 'response', status: 'in_progress', output: [] },
          },
          { type: 'response.output_text.delta', delta: 'COPILOT_PROXY_SETUP_OK' },
          {
            type: 'response.completed',
            response: {
              id: 'resp_setup_sse',
              object: 'response',
              model: gptModel.id,
              status: 'completed',
              output: [{
                id: 'msg_setup_sse',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'COPILOT_PROXY_SETUP_OK', annotations: [] }],
              }],
            },
          },
        ]), { headers: { 'Content-Type': 'text/event-stream' } })
      }

      if (url.pathname === '/v1/messages') {
        return new Response(eventStream([
          {
            type: 'message_start',
            message: {
              id: 'msg_setup_sse',
              type: 'message',
              role: 'assistant',
              model: claudeModel.id,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'COPILOT_PROXY_' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SETUP_OK' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]), { headers: { 'Content-Type': 'text/event-stream' } })
      }

      throw new Error(`Unexpected setup SSE URL: ${url.toString()}`)
    }) as typeof fetch

    state.accountType = 'individual'
    state.concurrencyLimiter = undefined
    state.copilotToken = 'setup-test-token'
    state.lastRequestTimestamp = undefined
    state.manualApprove = false
    state.models = { data: [gptModel, claudeModel], object: 'list' }
    state.rateLimitSeconds = undefined
    state.rateLimitWait = false
    state.vsCodeVersion = '1.0.0'

    try {
      await expect(runDisposableSetupProbe({
        choice: { api: 'responses', model: gptModel, supportsWebSockets: false },
        client: 'codex',
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 2_000,
      })).resolves.toEqual(probeOutcome('/v1/responses', 'not-advertised', false))
      state.lastRequestTimestamp = undefined
      await expect(runDisposableSetupProbe({
        choice: { api: 'anthropic-messages', model: claudeModel, supportsWebSockets: false },
        client: 'claude',
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 2_000,
      })).resolves.toEqual(probeOutcome('/v1/messages', 'not-applicable', false))

      expect(forwarded).toEqual([
        { path: '/responses', stream: true },
        { path: '/v1/messages', stream: true },
      ])
    }
    finally {
      globalThis.fetch = originalFetch
      Object.assign(state, originalState)
    }
  })

  test('does not accept a non-streaming success when the required Codex SSE route fails', async () => {
    const originalFetch = globalThis.fetch
    const originalState = {
      accountType: state.accountType,
      concurrencyLimiter: state.concurrencyLimiter,
      copilotToken: state.copilotToken,
      lastRequestTimestamp: state.lastRequestTimestamp,
      manualApprove: state.manualApprove,
      models: state.models,
      rateLimitSeconds: state.rateLimitSeconds,
      rateLimitWait: state.rateLimitWait,
      vsCodeVersion: state.vsCodeVersion,
    }
    const gptModel = model('gpt-stream-failure', ['/responses'])
    let forwardedStream: unknown

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      forwardedStream = body.stream
      if (body.stream === true) {
        return Response.json({ error: { message: 'streaming path unavailable' } }, { status: 500 })
      }
      return Response.json({
        id: 'resp_nonstream_only',
        object: 'response',
        model: gptModel.id,
        status: 'completed',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'COPILOT_PROXY_SETUP_OK' }],
        }],
      })
    }) as typeof fetch

    state.accountType = 'individual'
    state.concurrencyLimiter = undefined
    state.copilotToken = 'setup-test-token'
    state.lastRequestTimestamp = undefined
    state.manualApprove = false
    state.models = { data: [gptModel], object: 'list' }
    state.rateLimitSeconds = undefined
    state.rateLimitWait = false
    state.vsCodeVersion = '1.0.0'

    try {
      await expect(runDisposableSetupProbe({
        choice: { api: 'responses', model: gptModel, supportsWebSockets: false },
        client: 'codex',
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 2_000,
      })).rejects.toThrow('failed with HTTP 500: streaming path unavailable')
      expect(forwardedStream).toBe(true)
    }
    finally {
      globalThis.fetch = originalFetch
      Object.assign(state, originalState)
    }
  })

  test('bounds WebSocket validation before the overall deadline and preserves the validated SSE fallback', async () => {
    const originalFetch = globalThis.fetch
    const originalState = {
      accountType: state.accountType,
      concurrencyLimiter: state.concurrencyLimiter,
      copilotToken: state.copilotToken,
      lastRequestTimestamp: state.lastRequestTimestamp,
      manualApprove: state.manualApprove,
      models: state.models,
      rateLimitSeconds: state.rateLimitSeconds,
      rateLimitWait: state.rateLimitWait,
      vsCodeVersion: state.vsCodeVersion,
    }
    const gptModel = model('gpt-ws-timeout-fallback', ['/responses', 'ws:/responses'])
    let websocketTimeoutMs: number | undefined

    globalThis.fetch = (async () => new Response(eventStream([
      {
        type: 'response.completed',
        response: {
          id: 'resp_ws_timeout_fallback',
          object: 'response',
          model: gptModel.id,
          status: 'completed',
          output: [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'COPILOT_PROXY_SETUP_OK' }],
          }],
        },
      },
    ]), { headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch

    state.accountType = 'individual'
    state.concurrencyLimiter = undefined
    state.copilotToken = 'setup-test-token'
    state.lastRequestTimestamp = undefined
    state.manualApprove = false
    state.models = { data: [gptModel], object: 'list' }
    state.rateLimitSeconds = undefined
    state.rateLimitWait = false
    state.vsCodeVersion = '1.0.0'

    try {
      const result = await runDisposableSetupProbe({
        choice: { api: 'responses', model: gptModel, supportsWebSockets: true },
        client: 'codex',
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 2_000,
      }, {
        probeWebSocket: async (_url, _body, probeOptions) => {
          if (probeOptions?.timeoutMs === undefined)
            throw new Error('Expected a bounded WebSocket probe timeout')
          websocketTimeoutMs = probeOptions.timeoutMs
          throw new Error(`Direct setup WebSocket probe timed out after ${probeOptions.timeoutMs}ms.`)
        },
      })

      expect(websocketTimeoutMs).toBeNumber()
      expect(websocketTimeoutMs!).toBeGreaterThan(0)
      expect(websocketTimeoutMs!).toBeLessThan(2_000)
      expect(result).toEqual({
        httpTransport: 'sse',
        path: '/v1/responses',
        websocket: {
          advertised: true,
          failure: `Direct setup WebSocket probe timed out after ${String(websocketTimeoutMs)}ms.`,
          semanticValidation: 'failed',
        },
      })
    }
    finally {
      globalThis.fetch = originalFetch
      Object.assign(state, originalState)
    }
  })

  test('initializes, proves the selected route, and emits Codex config', async () => {
    const lines: string[] = []
    const copy = mock(() => {})
    const initialize = mock(async () => {})
    const probe = mock(async () => probeOutcome('/v1/responses'))
    const result = await runSetup(options(), {
      chooseModel: async () => 'gpt-setup',
      copy,
      findExistingConfigs: () => ['/home/test/.codex/config.toml'],
      initialize,
      inspectCodexClient,
      isInteractive: () => false,
      models: () => MODELS,
      probe,
      writeJson: () => {},
      writeLine: value => lines.push(value),
    })

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      choice: expect.objectContaining({ api: 'responses' }),
      client: 'codex',
      host: '127.0.0.1',
      port: 4399,
    }))
    expect(result.probe.semanticValidation).toBe('passed')
    expect(result.probe.httpTransport).toBe('sse')
    expect(result.probe.websocket).toEqual({
      advertised: true,
      semanticValidation: 'passed',
    })
    expect(result.configuration).toEqual({
      existingFiles: ['/home/test/.codex/config.toml'],
      written: false,
    })
    expect(result.artifact.content).toContain('supports_websockets = true')
    expect(result.startCommands.installed).toBe('copilot-proxy start --preset personal --host 127.0.0.1 --port 4399 --account-type individual')
    expect(result.startCommands.source).toBe('bun run ./src/main.ts start --preset personal --host 127.0.0.1 --port 4399 --account-type individual')
    expect(lines.join('\n')).toContain('Setup HTTP/SSE probe passed')
    expect(lines.join('\n')).toContain('WebSocket probe passed')
    expect(lines.join('\n')).toContain(result.startCommands.installed)
    expect(lines.join('\n')).toContain(result.startCommands.source)
    expect(lines.join('\n')).toContain('Existing user configuration detected and preserved')
    expect(lines.join('\n')).toContain('No configuration file or clipboard content was changed')
    expect(copy).not.toHaveBeenCalled()
  })

  test('requires an explicit Codex model before authentication when setup cannot prompt', async () => {
    const initialize = mock(async () => {})
    const probe = mock(async () => probeOutcome('/v1/responses'))
    const dependencies = {
      chooseModel: async () => 'gpt-setup',
      copy: () => {},
      initialize,
      models: () => MODELS,
      probe,
      writeJson: () => {},
      writeLine: () => {},
    }

    for (const modelValue of [undefined, '', '   ']) {
      await expect(runSetup(options({ model: modelValue }), {
        ...dependencies,
        isInteractive: () => false,
      })).rejects.toThrow('setup codex requires --model')
    }
    await expect(runSetup(options({ json: true, model: undefined }), {
      ...dependencies,
      isInteractive: () => true,
    })).rejects.toThrow('setup codex requires --model')

    expect(initialize).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  test('keeps interactive Codex model selection explicit', async () => {
    const chooseModel = mock(async () => 'gpt-setup')
    const result = await runSetup(options({ model: undefined }), {
      chooseModel,
      copy: () => {},
      initialize: async () => {},
      inspectCodexClient,
      isInteractive: () => true,
      models: () => MODELS,
      probe: async () => probeOutcome('/v1/responses'),
      writeJson: () => {},
      writeLine: () => {},
    })

    expect(chooseModel).toHaveBeenCalledTimes(1)
    expect(result.model).toBe('gpt-setup')
  })

  test('uses the same installed Codex metadata gate for interactive and explicit selection', async () => {
    const missingMetadata = model('gpt-5.3-codex', ['/responses', 'ws:/responses'])
    const liveModels = [MODELS[0], missingMetadata]
    const chooseModel = mock(async (_message: string, models: Model[]) => models[0]!.id)
    const interactiveResult = await runSetup(options({ model: undefined }), {
      chooseModel,
      copy: () => {},
      initialize: async () => {},
      inspectCodexClient,
      isInteractive: () => true,
      models: () => liveModels,
      probe: async () => probeOutcome('/v1/responses'),
      writeJson: () => {},
      writeLine: () => {},
    })

    expect(chooseModel.mock.calls[0]?.[1].map(candidate => candidate.id)).toEqual(['gpt-setup'])
    expect(interactiveResult.model).toBe('gpt-setup')

    const initialize = mock(async () => {})
    const probe = mock(async () => probeOutcome('/v1/responses'))
    await expect(runSetup(options({ model: missingMetadata.id }), {
      chooseModel: async () => missingMetadata.id,
      copy: () => {},
      initialize,
      inspectCodexClient,
      isInteractive: () => false,
      models: () => liveModels,
      probe,
      writeJson: () => {},
      writeLine: () => {},
    })).rejects.toThrow('bundled catalog has no usable metadata')
    expect(initialize).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  test('explicitly disables Codex WebSockets when the advertised transport fails validation', async () => {
    const lines: string[] = []
    const result = await runSetup(options(), {
      chooseModel: async () => 'gpt-setup',
      copy: () => {},
      initialize: async () => {},
      inspectCodexClient,
      isInteractive: () => false,
      models: () => MODELS,
      probe: async () => probeOutcome(
        '/v1/responses',
        'failed',
        true,
        'Direct setup WebSocket probe ended with response.failed (upstream_error).',
      ),
      writeJson: () => {},
      writeLine: value => lines.push(value),
    })

    expect(result.supportsWebSockets).toBe(false)
    expect(result.probe.websocket).toEqual({
      advertised: true,
      failure: 'Direct setup WebSocket probe ended with response.failed (upstream_error).',
      semanticValidation: 'failed',
    })
    expect(result.artifact.content).toContain('supports_websockets = false')
    expect(result.artifact.notes.join('\n')).toContain('independently validated HTTP/SSE Responses route')
    expect(lines.join('\n')).toContain('explicitly disables WebSocket transport')
  })

  test('keeps HTTP-only Codex profiles on HTTP without claiming a WebSocket probe', async () => {
    const httpOnlyModel = model('gpt-http-only', ['/responses'])
    const probe = mock(async () => probeOutcome('/v1/responses', 'not-advertised', false))
    const result = await runSetup(options({ model: httpOnlyModel.id }), {
      chooseModel: async () => httpOnlyModel.id,
      copy: () => {},
      initialize: async () => {},
      inspectCodexClient,
      isInteractive: () => false,
      models: () => [httpOnlyModel],
      probe,
      writeJson: () => {},
      writeLine: () => {},
    })

    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ client: 'codex' }))
    expect(result.probe.websocket).toEqual({
      advertised: false,
      semanticValidation: 'not-advertised',
    })
    expect(result.supportsWebSockets).toBe(false)
    expect(result.artifact.content).toContain('supports_websockets = false')
  })

  test('copies only when explicitly requested', async () => {
    const copy = mock(() => {})
    const lines: string[] = []
    await runSetup(options({ copy: true }), {
      chooseModel: async () => 'gpt-setup',
      copy,
      initialize: async () => {},
      inspectCodexClient,
      isInteractive: () => false,
      models: () => MODELS,
      probe: async () => probeOutcome('/v1/responses'),
      writeJson: () => {},
      writeLine: value => lines.push(value),
    })

    expect(copy).toHaveBeenCalledTimes(1)
    expect(lines.join('\n')).toContain('--copy was requested')
  })

  test('uses the explicitly selected shell for generated setup artifacts', async () => {
    const result = await runSetup(options({
      client: 'openai-sdk',
      shell: 'powershell',
    }), {
      chooseModel: async () => 'gpt-setup',
      copy: () => {},
      initialize: async () => {},
      isInteractive: () => false,
      models: () => MODELS,
      probe: async () => probeOutcome('/v1/responses', 'not-applicable', true, undefined, 'json'),
      writeJson: () => {},
      writeLine: () => {},
    })

    expect(result.artifact.content).toStartWith(`$env:OPENAI_BASE_URL = 'http://127.0.0.1:4399/v1'`)
  })

  test('rejects gateway mode because setup only validates direct local clients', async () => {
    await expect(runSetup(options({
      preset: resolveRunPreset('gateway-upstream'),
    }), {
      chooseModel: async () => 'gpt-setup',
      copy: () => {},
      initialize: async () => {},
      isInteractive: () => false,
      models: () => MODELS,
      probe: async () => probeOutcome('/v1/responses'),
      writeJson: () => {},
      writeLine: () => {},
    })).rejects.toThrow('does not accept gateway-upstream')
  })

  test('rejects non-loopback setup hosts before initialization', async () => {
    for (const host of ['0.0.0.0', '::', '192.0.2.10', 'proxy.internal', 'foo.localhost', 'localhost.', '::1%lo', '[::1]']) {
      const initialize = mock(async () => {})
      await expect(runSetup(options({ host }), {
        chooseModel: async () => 'gpt-setup',
        copy: () => {},
        initialize,
        isInteractive: () => false,
        models: () => MODELS,
        probe: async () => probeOutcome('/v1/responses'),
        writeJson: () => {},
        writeLine: () => {},
      })).rejects.toThrow('setup requires a bindable loopback --host')
      expect(initialize).not.toHaveBeenCalled()
    }
  })

  test('accepts localhost case-insensitively as a bindable setup host', async () => {
    const initialize = mock(async () => {})
    const result = await runSetup(options({
      host: 'LOCALHOST',
      model: 'gpt-setup',
    }), {
      chooseModel: async () => 'gpt-setup',
      copy: () => {},
      initialize,
      inspectCodexClient,
      isInteractive: () => false,
      models: () => MODELS,
      probe: async () => probeOutcome('/v1/responses'),
      writeJson: () => {},
      writeLine: () => {},
    })

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(result.baseUrl).toBe('http://LOCALHOST:4399')
  })

  test('rejects a public setup host in the real CLI before authentication', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve('src/main.ts'),
        'setup',
        'openai-sdk',
        '--json',
        '--host',
        '0.0.0.0',
        '--model',
        'gpt-5.4',
      ],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('setup requires a bindable loopback --host')
    expect(result.stderr).not.toContain('Logged in as')
    expect(result.stderr).not.toContain('<-- POST')
  }, 15_000)

  test('rejects JSON Codex setup without --model in the real CLI before authentication', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve('src/main.ts'),
        'setup',
        'codex',
        '--json',
      ],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('setup codex requires --model')
    expect(result.stderr).not.toContain('Logged in as')
    expect(result.stderr).not.toContain('<-- POST')
  }, 15_000)

  test('preserves every non-default runtime choice in the generated start command', () => {
    expect(buildSetupStartCommand(options({
      accountType: 'enterprise',
      host: '0.0.0.0',
      port: 4400,
      preset: resolveRunPreset('gateway-upstream'),
      proxyEnv: true,
    }))).toBe(
      'copilot-proxy start --preset gateway-upstream --host 0.0.0.0 --port 4400 --account-type enterprise --proxy-env',
    )
  })

  test('requires every setup bootstrap endpoint to use the configured proxy', () => {
    expect(setupProxyRequiredTargets('individual')).toEqual([
      'https://github.com',
      'https://api.github.com',
      'https://api.githubcopilot.com',
      'https://update.code.visualstudio.com',
      'https://raw.githubusercontent.com',
    ])
    expect(setupProxyRequiredTargets('enterprise')).toContain('https://api.enterprise.githubcopilot.com')
  })

  test('prompts for primary and small Claude models in interactive mode', async () => {
    const selections = ['claude-setup', 'claude-setup']
    const chooseModel = mock(async () => selections.shift()!)
    const result = await runSetup(options({ client: 'claude', model: undefined }), {
      chooseModel,
      copy: () => {},
      initialize: async () => {},
      isInteractive: () => true,
      models: () => MODELS,
      probe: async () => probeOutcome('/v1/messages', 'not-applicable', false),
      writeJson: () => {},
      writeLine: () => {},
    })

    expect(chooseModel).toHaveBeenCalledTimes(2)
    expect(result.model).toBe('claude-setup')
    expect(result.smallModel).toBe('claude-setup')
  })

  test('cleans initialized runtime when model selection fails before the disposable probe', async () => {
    const cleanup = mock(async (_reason: Error) => {})
    const initialize = mock(async () => {})
    const probe = mock(async () => probeOutcome('/v1/responses'))

    await expect(runSetup(options({ model: undefined }), {
      chooseModel: async () => {
        throw new Error('prompt cancelled')
      },
      cleanup,
      copy: () => {},
      initialize,
      inspectCodexClient,
      isInteractive: () => true,
      models: () => MODELS,
      probe,
      writeJson: () => {},
      writeLine: () => {},
    })).rejects.toThrow('prompt cancelled')

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(probe).not.toHaveBeenCalled()
  })

  test('probes a distinct Claude secondary model before generating configuration', async () => {
    const primary = model('claude-primary', ['/v1/messages'])
    const secondary = model('claude-secondary', ['/v1/messages'])
    const probedModels: string[] = []
    const result = await runSetup(options({
      client: 'claude',
      model: primary.id,
      shell: 'bash',
      smallModel: secondary.id,
    }), {
      chooseModel: async () => primary.id,
      copy: () => {},
      initialize: async () => {},
      isInteractive: () => false,
      models: () => [primary, secondary],
      probe: async ({ choice }) => {
        probedModels.push(choice.model.id)
        return probeOutcome('/v1/messages', 'not-applicable', false)
      },
      writeJson: () => {},
      writeLine: () => {},
    })

    expect(probedModels).toEqual([primary.id, secondary.id])
    expect(result.probe.smallModel).toEqual({
      httpTransport: 'sse',
      model: secondary.id,
      path: '/v1/messages',
      semanticValidation: 'passed',
    })
    expect(result.artifact.content).toContain('"ANTHROPIC_SMALL_FAST_MODEL":"claude-secondary"')
  })

  test('emits no Claude configuration when a distinct secondary model probe fails', async () => {
    const primary = model('claude-primary', ['/v1/messages'])
    const secondary = model('claude-secondary', ['/v1/messages'])
    const copy = mock(() => {})
    const writeJson = mock(() => {})

    await expect(runSetup(options({
      client: 'claude',
      json: true,
      model: primary.id,
      smallModel: secondary.id,
    }), {
      chooseModel: async () => primary.id,
      copy,
      initialize: async () => {},
      isInteractive: () => false,
      models: () => [primary, secondary],
      probe: async ({ choice }) => {
        if (choice.model.id === secondary.id)
          throw new Error('secondary model SSE probe failed')
        return probeOutcome('/v1/messages', 'not-applicable', false)
      },
      writeJson,
      writeLine: () => {},
    })).rejects.toThrow('secondary model SSE probe failed')

    expect(writeJson).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })

  test('rejects --small-model for non-Claude clients before initialization or probing', async () => {
    for (const client of ['codex', 'openai-sdk'] as const) {
      for (const smallModel of ['nonexistent-small-model', '']) {
        const initialize = mock(async () => {})
        const probe = mock(async () => probeOutcome('/v1/responses'))

        await expect(runSetup(options({
          client,
          smallModel,
        }), {
          chooseModel: async () => 'gpt-setup',
          copy: () => {},
          initialize,
          isInteractive: () => false,
          models: () => MODELS,
          probe,
          writeJson: () => {},
          writeLine: () => {},
        })).rejects.toThrow('--small-model is only supported for the claude setup client')

        expect(initialize).not.toHaveBeenCalled()
        expect(probe).not.toHaveBeenCalled()
      }
    }
  })

  test('rejects --small-model from the real CLI before authentication or probing', () => {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve('src/main.ts'),
        'setup',
        'codex',
        '--json',
        '--model',
        'gpt-5.4',
        '--small-model',
        'definitely-not-a-real-copilot-model',
      ],
      {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        env: process.env,
        timeout: 10_000,
      },
    )

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--small-model is only supported for the claude setup client')
    expect(result.stderr).not.toContain('Logged in as')
    expect(result.stderr).not.toContain('<-- POST')
  }, 15_000)

  test('JSON mode is noninteractive and returns the generated artifact', async () => {
    let json: unknown
    const chooseModel = mock(async () => 'never')
    const result = await runSetup(options({ json: true }), {
      chooseModel,
      copy: () => {
        throw new Error('must not copy')
      },
      initialize: async () => {},
      inspectCodexClient,
      isInteractive: () => true,
      models: () => MODELS,
      probe: async () => probeOutcome('/v1/responses'),
      writeJson: value => json = value,
      writeLine: () => {},
    })

    expect(chooseModel).not.toHaveBeenCalled()
    expect(json).toEqual(result)
  })

  test('rejects --json with --copy before initialization', async () => {
    const copy = mock(() => {})
    const initialize = mock(async () => {})

    await expect(runSetup(options({ copy: true, json: true }), {
      chooseModel: async () => 'gpt-setup',
      copy,
      initialize,
      isInteractive: () => false,
      models: () => MODELS,
      probe: async () => probeOutcome('/v1/responses'),
      writeJson: () => {},
      writeLine: () => {},
    })).rejects.toThrow('setup --copy cannot be combined with --json')

    expect(initialize).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })

  test('fails before emitting configuration when no direct client model exists', async () => {
    const chooseModel = mock(async () => 'never')
    await expect(runSetup(options({ client: 'claude' }), {
      chooseModel,
      copy: () => {},
      initialize: async () => {},
      isInteractive: () => true,
      models: () => [MODELS[0]],
      probe: async () => probeOutcome('/v1/messages', 'not-applicable', false),
      writeJson: () => {},
      writeLine: () => {},
    })).rejects.toThrow('No current Copilot model')
    expect(chooseModel).not.toHaveBeenCalled()
  })

  test('detects existing client files without reading or rewriting them', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-setup-existing-'))
    const codexHome = path.join(home, 'custom-codex')
    const isolatedCodexHome = path.join(codexHome, 'copilot-proxy-home')
    const claudeDir = path.join(home, '.claude')
    fs.mkdirSync(codexHome, { recursive: true })
    fs.mkdirSync(isolatedCodexHome, { recursive: true })
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'user-owned = true\n')
    fs.writeFileSync(path.join(codexHome, 'copilot-proxy.config.toml'), 'legacy-user-owned = true\n')
    fs.writeFileSync(path.join(isolatedCodexHome, 'config.toml'), 'isolated-base-user-owned = true\n')
    fs.writeFileSync(path.join(isolatedCodexHome, 'copilot-proxy.config.toml'), 'isolated-profile-user-owned = true\n')
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"userOwned":true}\n')
    fs.writeFileSync(path.join(home, '.claude.json'), '{"userOwned":true}\n')

    try {
      expect(findExistingClientConfigs('codex', { CODEX_HOME: codexHome }, home)).toEqual([
        path.join(codexHome, 'config.toml'),
        path.join(codexHome, 'copilot-proxy.config.toml'),
        path.join(isolatedCodexHome, 'config.toml'),
        path.join(isolatedCodexHome, 'copilot-proxy.config.toml'),
      ])
      expect(findExistingClientConfigs('claude', {}, home)).toEqual([
        path.join(claudeDir, 'settings.json'),
        path.join(home, '.claude.json'),
      ])
    }
    finally {
      fs.rmSync(home, { force: true, recursive: true })
    }
  })
})
