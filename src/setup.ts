import type { ServerSentEventMessage } from 'fetch-event-stream'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { Server, ServerHandler } from 'srvx'
import type { RawData } from 'ws'
import type { CodexClientCatalog, SetupClient, SetupModelChoice, SetupProbeRequest } from './lib/client-setup'
import type { ShellName } from './lib/shell'
import type { Model } from './services/copilot/get-models'
import type { RunServerOptions } from './start'

import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { request as httpRequest } from 'node:http'
import { isIP } from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { defineCommand } from 'citty'
import clipboard from 'clipboardy'
import consola from 'consola'
import { events } from 'fetch-event-stream'
import WebSocket from 'ws'

import { assertProxyEndpointAvailable } from './daemon/service-env'
import { validateAccountType, validateHost, validatePort } from './lib/cli-validators'
import { assertCodexClientModelMetadata, assertSetupProbeSucceeded, buildClientSetupArtifact, buildSetupProbeRequest, compatibleModelsForClient, inspectCodexClientCatalog, isSetupClient, resolveCodexProfilePaths, selectSetupModel, SETUP_CLIENTS } from './lib/client-setup'
import { MAX_TIMER_DELAY_MS } from './lib/http-timeouts'
import { getUserHomeDir } from './lib/paths'
import { isRunPresetName, resolveRunPreset, RUN_PRESET_NAMES, wasRunOptionPassed } from './lib/run-presets'
import { isLoopbackHostname } from './lib/security'
import { initializeServer } from './lib/server-setup'
import { SHELL_NAMES } from './lib/shell'
import { state } from './lib/state'
import { cancelInFlightCopilotTokenRefreshes, stopCopilotTokenRefresh } from './lib/token'
import { stopModelRefresh } from './lib/utils'
import { server } from './server'
import { closeServerGracefully, createAppServer } from './start'

const SETUP_PRESET_NAMES = RUN_PRESET_NAMES.filter(name => name !== 'gateway-upstream')
const SETUP_PROBE_TIMEOUT_MS = 60_000
const SETUP_PROBE_ABORT_GRACE_MS = 1_000
const SETUP_WEBSOCKET_CLOSE_GRACE_MS = 1_000
const SETUP_WEBSOCKET_PROBE_TIMEOUT_MS = 15_000
const SETUP_WEBSOCKET_DEADLINE_GUARD_MS = 250

export type SetupWebSocketSemanticValidation
  = | 'failed'
    | 'not-advertised'
    | 'not-applicable'
    | 'passed'

export interface SetupProbeOutcome {
  httpTransport: 'json' | 'sse'
  path: SetupProbeRequest['path']
  websocket: {
    advertised: boolean
    failure?: string
    semanticValidation: SetupWebSocketSemanticValidation
  }
}

interface DisposableSetupProbeDependencies {
  probeWebSocket?: typeof fetchDirectSetupWebSocketProbe
}

export interface DirectSetupProbeOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface SetupOptions {
  accountType: string
  client: SetupClient
  copy: boolean
  host: string
  json: boolean
  model?: string
  port: number
  preset: ReturnType<typeof resolveRunPreset>
  proxyEnv: boolean
  shell?: ShellName
  smallModel?: string
}

export interface SetupResult {
  api: SetupModelChoice['api']
  artifact: ReturnType<typeof buildClientSetupArtifact>
  baseUrl: string
  client: SetupClient
  configuration: {
    existingFiles: string[]
    written: false
  }
  model: string
  probe: {
    httpTransport: SetupProbeOutcome['httpTransport']
    path: string
    semanticValidation: 'passed'
    smallModel?: {
      httpTransport: SetupProbeOutcome['httpTransport']
      model: string
      path: string
      semanticValidation: 'passed'
    }
    websocket: SetupProbeOutcome['websocket']
  }
  smallModel?: string
  startCommands: {
    installed: string
    source: string
  }
  supportsWebSockets: boolean
}

interface SetupDependencies {
  chooseModel: (message: string, models: Model[]) => Promise<string>
  cleanup?: (reason: Error) => Promise<void>
  copy: (value: string) => void
  findExistingConfigs?: (client: SetupClient) => string[]
  initialize: (options: RunServerOptions) => Promise<void>
  inspectCodexClient?: () => Promise<CodexClientCatalog>
  isInteractive: () => boolean
  models: () => Model[]
  probe: (options: { choice: SetupModelChoice, client: SetupClient, host: string, port: number }) => Promise<SetupProbeOutcome>
  writeJson: (value: unknown) => void
  writeLine: (value: string) => void
}

const defaultDependencies: SetupDependencies = {
  chooseModel: async (message, models) => await consola.prompt(message, {
    type: 'select',
    options: models.map(model => model.id),
  }) as string,
  cleanup: cleanupSetupRuntime,
  copy: value => clipboard.writeSync(value),
  findExistingConfigs: client => findExistingClientConfigs(client),
  initialize: initializeServer,
  inspectCodexClient: inspectCodexClientCatalog,
  isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  models: () => state.models?.data ?? [],
  probe: runDisposableSetupProbe,
  writeJson: (value) => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  },
  writeLine: value => consola.log(value),
}

export async function runSetup(
  options: SetupOptions,
  dependencies: SetupDependencies = defaultDependencies,
): Promise<SetupResult> {
  assertSetupOutputMode(options)
  assertSetupSmallModelClient(options.client, options.smallModel)
  if (options.preset.name === 'gateway-upstream') {
    throw new TypeError('setup configures a direct local client and does not accept gateway-upstream; configure the authenticated gateway separately, then run `start --preset gateway-upstream`.')
  }
  assertLoopbackSetupHost(options.host)
  const interactive = dependencies.isInteractive()
  assertCodexModelSelection(options, interactive)
  const codexCatalog = options.client === 'codex'
    ? await (dependencies.inspectCodexClient ?? inspectCodexClientCatalog)()
    : undefined
  if (options.model?.trim() && codexCatalog)
    assertCodexClientModelMetadata(options.model, codexCatalog)
  let initializationStarted = false
  try {
    initializationStarted = true
    await dependencies.initialize(toRunServerOptions(options))
    return await completeSetup(options, dependencies, interactive, codexCatalog)
  }
  finally {
    if (initializationStarted) {
      await (dependencies.cleanup ?? cleanupSetupRuntime)(
        new Error('Setup workflow finished.'),
      )
    }
  }
}

async function completeSetup(
  options: SetupOptions,
  dependencies: SetupDependencies,
  interactive: boolean,
  codexCatalog?: CodexClientCatalog,
): Promise<SetupResult> {
  const models = dependencies.models()
  const compatible = compatibleModelsForClient(options.client, models, codexCatalog)
  if (compatible.length === 0 && codexCatalog) {
    throw new Error(
      `No current Copilot Responses model also has usable bundled metadata in installed Codex ${codexCatalog.version}.`,
    )
  }
  if (compatible.length === 0) {
    throw new Error(`No current Copilot model can serve ${options.client} through a faithful direct route.`)
  }
  let requestedModel = options.model
  if (!requestedModel && !options.json && interactive) {
    requestedModel = await dependencies.chooseModel(
      `Select a direct model for ${options.client}`,
      compatible.map(choice => choice.model),
    )
  }
  const choice = selectSetupModel(options.client, models, requestedModel, codexCatalog)

  let smallModel = options.smallModel
  let smallModelChoice: SetupModelChoice | undefined
  if (options.client === 'claude') {
    if (!smallModel && !options.json && interactive) {
      smallModel = await dependencies.chooseModel(
        'Select a direct small/fast model for Claude Code',
        compatible.map(item => item.model),
      )
    }
    if (smallModel) {
      smallModelChoice = selectSetupModel('claude', models, smallModel)
    }
    else {
      smallModel = choice.model.id
      smallModelChoice = choice
    }
  }

  const baseUrl = `http://${formatClientHost(options.host)}:${options.port}`
  const startCommand = buildSetupStartCommand(options)
  const sourceStartCommand = buildSetupStartCommand(options, 'bun run ./src/main.ts start')
  const probe = await dependencies.probe({
    choice,
    client: options.client,
    host: options.host,
    port: options.port,
  })
  const smallModelProbe = options.client === 'claude'
    && smallModelChoice
    && smallModelChoice.model.id !== choice.model.id
    ? await dependencies.probe({
        choice: smallModelChoice,
        client: 'claude',
        host: options.host,
        port: options.port,
      })
    : undefined
  const supportsWebSockets = options.client === 'codex'
    && probe.websocket.semanticValidation === 'passed'
  const validatedChoice = supportsWebSockets === choice.supportsWebSockets
    ? choice
    : { ...choice, supportsWebSockets }
  const artifact = buildClientSetupArtifact({
    baseUrl,
    choice: validatedChoice,
    client: options.client,
    codexCatalog,
    shell: options.shell,
    smallModel,
  })
  if (options.client === 'codex' && probe.websocket.semanticValidation === 'failed') {
    artifact.notes.push(
      `The live catalog advertised Responses WebSocket, but setup could not validate it (${probe.websocket.failure ?? 'unknown failure'}). The generated profile keeps supports_websockets=false and uses the independently validated HTTP/SSE Responses route.`,
    )
  }
  const existingFiles = dependencies.findExistingConfigs?.(options.client) ?? []
  if (existingFiles.length > 0) {
    artifact.notes.push(
      `Existing user configuration detected and preserved: ${existingFiles.join(', ')}.`,
    )
  }
  const result: SetupResult = {
    api: choice.api,
    artifact,
    baseUrl,
    client: options.client,
    configuration: {
      existingFiles,
      written: false,
    },
    model: choice.model.id,
    probe: {
      httpTransport: probe.httpTransport,
      path: probe.path,
      semanticValidation: 'passed',
      ...(smallModelProbe && smallModel && {
        smallModel: {
          httpTransport: smallModelProbe.httpTransport,
          model: smallModel,
          path: smallModelProbe.path,
          semanticValidation: 'passed' as const,
        },
      }),
      websocket: probe.websocket,
    },
    ...(smallModel && { smallModel }),
    startCommands: {
      installed: startCommand,
      source: sourceStartCommand,
    },
    supportsWebSockets,
  }

  if (options.json) {
    dependencies.writeJson(result)
    return result
  }

  dependencies.writeLine(`Setup HTTP${probe.httpTransport === 'sse' ? '/SSE' : ''} probe passed through ${probe.path} with ${choice.model.id}.`)
  if (codexCatalog) {
    dependencies.writeLine(
      `Installed Codex ${codexCatalog.version} bundled metadata validated for ${choice.model.id}.`,
    )
  }
  if (smallModelProbe && smallModel) {
    dependencies.writeLine(
      `Setup HTTP${smallModelProbe.httpTransport === 'sse' ? '/SSE' : ''} probe also passed for the Claude secondary model ${smallModel}.`,
    )
  }
  if (probe.websocket.semanticValidation === 'passed') {
    dependencies.writeLine('Setup Responses WebSocket probe passed with the same semantic sentinel.')
  }
  else if (probe.websocket.semanticValidation === 'failed') {
    dependencies.writeLine(
      `Setup Responses WebSocket probe failed; the generated Codex profile explicitly disables WebSocket transport (${probe.websocket.failure ?? 'unknown failure'}).`,
    )
  }
  dependencies.writeLine('\nGenerated configuration:\n')
  dependencies.writeLine(artifact.content)
  for (const note of artifact.notes)
    dependencies.writeLine(`\n- ${note}`)
  dependencies.writeLine(`\nStart the proxy in another terminal:\n- Installed CLI: ${startCommand}\n- Source checkout: ${sourceStartCommand}`)
  if (options.copy) {
    try {
      dependencies.copy(artifact.content)
      dependencies.writeLine('\nConfiguration copied to the clipboard because --copy was requested.')
    }
    catch {
      dependencies.writeLine('\nClipboard unavailable; copy the configuration above.')
    }
  }
  else {
    dependencies.writeLine('\nNo configuration file or clipboard content was changed. Use --copy to copy explicitly.')
  }
  return result
}

export async function cleanupSetupRuntime(reason: Error): Promise<void> {
  stopCopilotTokenRefresh()
  await cancelInFlightCopilotTokenRefreshes(reason)
  stopModelRefresh()
}

export function findExistingClientConfigs(
  client: SetupClient,
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string,
): string[] {
  const resolvedHomeDir = homeDir ?? getUserHomeDir(env)
  const candidates = client === 'codex'
    ? (() => {
        const codexPaths = resolveCodexProfilePaths('copilot-proxy', {
          env,
          ...(homeDir !== undefined && { homeDir }),
        })
        return [
          codexPaths.baseConfigPath,
          codexPaths.legacyProfilePath,
          codexPaths.isolatedBaseConfigPath,
          codexPaths.suggestedPath,
        ]
      })()
    : client === 'claude'
      ? [
          path.join(resolvedHomeDir, '.claude', 'settings.json'),
          path.join(resolvedHomeDir, '.claude.json'),
        ]
      : env.OPENAI_CONFIG_FILE?.trim()
        ? [path.resolve(env.OPENAI_CONFIG_FILE)]
        : []

  return candidates.filter(candidate => fs.existsSync(candidate))
}

export function buildSetupStartCommand(
  options: Pick<SetupOptions, 'accountType' | 'host' | 'port' | 'preset' | 'proxyEnv'>,
  command = 'copilot-proxy start',
): string {
  return [
    command,
    `--preset ${options.preset.name}`,
    `--host ${options.host}`,
    `--port ${options.port}`,
    `--account-type ${options.accountType}`,
    ...(options.proxyEnv ? ['--proxy-env'] : []),
  ].join(' ')
}

export function setupProxyRequiredTargets(accountType: string): string[] {
  const copilotOrigin = accountType === 'individual'
    ? 'https://api.githubcopilot.com'
    : `https://api.${accountType}.githubcopilot.com`
  return [
    'https://github.com',
    'https://api.github.com',
    copilotOrigin,
    'https://update.code.visualstudio.com',
    'https://raw.githubusercontent.com',
  ]
}

export async function runDisposableSetupProbe(options: {
  choice: SetupModelChoice
  client: SetupClient
  host: string
  port: number
  timeoutMs?: number
}, dependencies: DisposableSetupProbeDependencies = {}): Promise<SetupProbeOutcome> {
  assertLoopbackSetupHost(options.host)
  let appServer: Server | undefined
  const baseRequest = buildSetupProbeRequest(options.choice)
  const streamingApi = setupStreamingProbeApi(options.client, options.choice.api)
  const request = streamingApi
    ? { ...baseRequest, body: { ...baseRequest.body, stream: true } }
    : baseRequest
  const timeoutMs = options.timeoutMs ?? SETUP_PROBE_TIMEOUT_MS
  assertDirectSetupProbeTimeoutMs(timeoutMs)
  const deadlineAt = Date.now() + timeoutMs
  const setupController = new AbortController()
  const timeoutError = new Error(`Direct setup probe timed out after ${timeoutMs}ms.`)
  const deadline = setTimeout(() => setupController.abort(timeoutError), timeoutMs)
  deadline.unref?.()
  const setupFetchHandler: ServerHandler = request => server.fetch(request, {
    setupProbeSignal: setupController.signal,
  })
  try {
    appServer = createAppServer(
      { host: options.host, port: options.port, silent: true },
      undefined,
      setupFetchHandler,
    )
    await appServer.ready()
    const probeUrl = resolveDisposableSetupProbeUrl(
      appServer.url,
      options.host,
      options.port,
      request.path,
    )
    let response: Response
    try {
      response = await fetchDirectSetupProbe(probeUrl, request.body, {
        // Let the setup-only upstream signal abort the real route first. The
        // direct local socket gets a short independent grace period so the
        // handler can finish and the disposable server can drain normally.
        timeoutMs: Math.min(MAX_TIMER_DELAY_MS, timeoutMs + SETUP_PROBE_ABORT_GRACE_MS),
      })
    }
    catch (error) {
      if (setupController.signal.aborted)
        throw timeoutError
      throw error
    }
    if (setupController.signal.aborted)
      throw timeoutError
    const body = await readSetupResponse(response, response.ok ? streamingApi : undefined)
    if (!response.ok) {
      throw new Error(
        `Setup probe ${request.path} failed with HTTP ${response.status}: ${summarizeSetupError(body)}`,
      )
    }
    assertSetupProbeSucceeded(options.choice.api, body)

    const websocket: SetupProbeOutcome['websocket'] = {
      advertised: options.choice.supportsWebSockets,
      semanticValidation: options.client !== 'codex'
        ? 'not-applicable'
        : options.choice.supportsWebSockets
          ? 'failed'
          : 'not-advertised',
    }
    if (options.client === 'codex' && options.choice.supportsWebSockets) {
      const websocketTimeoutMs = setupWebSocketProbeTimeoutMs(deadlineAt - Date.now())
      if (websocketTimeoutMs === undefined) {
        websocket.failure = 'The overall setup deadline left no bounded WebSocket probe budget.'
      }
      else {
        try {
          await (dependencies.probeWebSocket ?? fetchDirectSetupWebSocketProbe)(
            probeUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:'),
            request.body,
            { signal: setupController.signal, timeoutMs: websocketTimeoutMs },
          )
          websocket.semanticValidation = 'passed'
        }
        catch (error) {
          if (setupController.signal.aborted)
            throw timeoutError
          websocket.failure = safeSetupProbeFailure(error)
        }
      }
    }

    return {
      httpTransport: streamingApi ? 'sse' : 'json',
      path: request.path,
      websocket,
    }
  }
  finally {
    clearTimeout(deadline)
    if (!setupController.signal.aborted)
      setupController.abort(new Error('Disposable setup probe completed.'))
    stopCopilotTokenRefresh()
    await cancelInFlightCopilotTokenRefreshes(new Error('Disposable setup probe finished.'))
    if (appServer)
      await closeServerGracefully(appServer, 10_000)
    stopModelRefresh()
  }
}

export async function fetchDirectSetupWebSocketProbe(
  url: string,
  body: Record<string, unknown>,
  options: DirectSetupProbeOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? SETUP_PROBE_TIMEOUT_MS
  assertDirectSetupProbeTimeoutMs(timeoutMs)
  const event: Record<string, unknown> = {
    ...body,
    type: 'response.create',
  }
  delete event.stream

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url)
    let closeTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let validated = false
    let onAbort = () => {}
    let onClose = () => {}
    let onError = (_error: Error) => {}
    let onMessage = (_rawData: RawData, _isBinary: boolean) => {}
    let onOpen = () => {}
    const safetyErrorGuard = () => {}

    const cleanup = () => {
      if (timeout !== undefined)
        clearTimeout(timeout)
      if (closeTimer !== undefined)
        clearTimeout(closeTimer)
      options.signal?.removeEventListener('abort', onAbort)
      socket.off('close', onClose)
      socket.off('error', onError)
      socket.off('message', onMessage)
      socket.off('open', onOpen)
    }
    const terminate = () => {
      if (socket.readyState !== WebSocket.CLOSED)
        socket.terminate()
    }
    const fail = (error: Error) => {
      if (settled)
        return
      settled = true
      cleanup()
      terminate()
      reject(error)
    }
    const succeed = () => {
      if (settled)
        return
      settled = true
      cleanup()
      resolve()
    }
    onAbort = () => {
      if (validated) {
        terminate()
        return
      }
      const reason = options.signal?.reason
      fail(reason instanceof Error ? reason : new Error('Direct setup WebSocket probe was aborted.'))
    }
    onClose = () => {
      if (validated)
        succeed()
      else
        fail(new Error('Direct setup WebSocket probe closed before response.completed.'))
    }
    onError = (error: Error) => {
      fail(new Error(`Direct setup WebSocket probe failed: ${error.message}`, { cause: error }))
    }
    onOpen = () => {
      try {
        socket.send(JSON.stringify(event))
      }
      catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    }
    onMessage = (rawData: RawData, isBinary: boolean) => {
      if (isBinary) {
        fail(new Error('Direct setup WebSocket probe received a binary frame.'))
        return
      }

      let frame: Record<string, unknown>
      try {
        const text = Array.isArray(rawData)
          ? Buffer.concat(rawData).toString('utf8')
          : Buffer.isBuffer(rawData)
            ? rawData.toString('utf8')
            : Buffer.from(new Uint8Array(rawData)).toString('utf8')
        const parsed: unknown = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new TypeError('frame must be a JSON object')
        frame = parsed as Record<string, unknown>
      }
      catch (error) {
        fail(new Error('Direct setup WebSocket probe received an invalid JSON frame.', { cause: error }))
        return
      }

      if (frame.type === 'response.completed') {
        try {
          if (!frame.response || typeof frame.response !== 'object' || Array.isArray(frame.response))
            throw new Error('Direct setup WebSocket response.completed omitted its response object.')
          const response = frame.response as Record<string, unknown>
          if (response.status !== 'completed')
            throw new Error('Direct setup WebSocket response.completed did not report completed status.')
          assertSetupProbeSucceeded('responses', response)
        }
        catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
          return
        }
        validated = true
        if (timeout !== undefined)
          clearTimeout(timeout)
        closeTimer = setTimeout(terminate, SETUP_WEBSOCKET_CLOSE_GRACE_MS)
        socket.close(1000, 'setup probe complete')
        return
      }

      if (frame.type === 'error' || frame.type === 'response.failed' || frame.type === 'response.incomplete') {
        const code = setupWebSocketErrorCode(frame)
        fail(new Error(`Direct setup WebSocket probe ended with ${String(frame.type)}${code ? ` (${code})` : ''}.`))
      }
    }
    timeout = setTimeout(() => {
      fail(new Error(`Direct setup WebSocket probe timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    socket.on('error', safetyErrorGuard)
    socket.once('close', () => socket.off('error', safetyErrorGuard))
    socket.on('close', onClose)
    socket.on('error', onError)
    socket.on('message', onMessage)
    socket.on('open', onOpen)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted)
      onAbort()
  })
}

export async function fetchDirectSetupProbe(
  url: string,
  body: unknown,
  options: DirectSetupProbeOptions = {},
): Promise<Response> {
  const payload = JSON.stringify(body)
  const timeoutMs = options.timeoutMs ?? SETUP_PROBE_TIMEOUT_MS
  assertDirectSetupProbeTimeoutMs(timeoutMs)

  return await new Promise<Response>((resolve, reject) => {
    let incomingResponse: IncomingMessage | undefined
    let request: ClientRequest | undefined
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onAbort = () => {}

    const cleanup = () => {
      if (timeout !== undefined)
        clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error) => {
      if (settled)
        return
      settled = true
      cleanup()
      incomingResponse?.destroy(error)
      request?.destroy(error)
      reject(error)
    }
    const succeed = (response: Response) => {
      if (settled)
        return
      settled = true
      cleanup()
      resolve(response)
    }
    onAbort = () => {
      const reason = options.signal?.reason
      fail(reason instanceof Error ? reason : new Error('Direct setup probe was aborted.'))
    }
    timeout = setTimeout(() => {
      fail(new Error(`Direct setup probe timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    // This is intentionally node:http rather than fetch. The disposable server
    // is local, while Node's global fetch dispatcher may be configured to fail
    // closed under --proxy-env. `agent: false` also avoids the process-wide
    // node:http agent, giving Node and Bun an explicit one-shot direct socket.
    try {
      request = httpRequest(url, {
        agent: false,
        headers: {
          'Content-Length': Buffer.byteLength(payload).toString(),
          'Content-Type': 'application/json',
        },
        method: 'POST',
      }, (incoming) => {
        incomingResponse = incoming
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        incoming.once('aborted', () => fail(new Error('Direct setup probe response was aborted.')))
        incoming.once('error', fail)
        incoming.once('end', () => {
          const status = incoming.statusCode
          if (status === undefined) {
            fail(new Error('Direct setup probe returned no HTTP status.'))
            return
          }

          const headers = new Headers()
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value)
                headers.append(name, item)
            }
            else if (value !== undefined) {
              headers.append(name, value)
            }
          }

          succeed(new Response(Buffer.concat(chunks).toString('utf8'), {
            headers,
            status,
            statusText: incoming.statusMessage,
          }))
        })
      })
      request.once('error', fail)
      request.end(payload)
    }
    catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

function assertDirectSetupProbeTimeoutMs(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS)
    throw new TypeError(`Direct setup probe timeoutMs must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}.`)
}

function assertLoopbackSetupHost(host: string): void {
  const normalizedHost = host.toLowerCase()
  const bindableLoopback = normalizedHost === 'localhost'
    || normalizedHost === '::1'
    || (isIP(host) === 4 && isLoopbackHostname(host))
  if (!bindableLoopback) {
    throw new TypeError(
      'setup requires a bindable loopback --host (localhost, 127/8, or ::1) because its disposable validation listener has no downstream client authentication.',
    )
  }
}

function setupWebSocketProbeTimeoutMs(remainingMs: number): number | undefined {
  if (!Number.isFinite(remainingMs) || remainingMs <= 1)
    return undefined
  const guardMs = Math.min(
    SETUP_WEBSOCKET_DEADLINE_GUARD_MS,
    Math.max(1, Math.floor(remainingMs / 10)),
  )
  const boundedMs = Math.min(SETUP_WEBSOCKET_PROBE_TIMEOUT_MS, Math.floor(remainingMs - guardMs))
  return boundedMs > 0 ? boundedMs : undefined
}

async function readSetupResponse(
  response: Response,
  streamingApi?: Extract<SetupModelChoice['api'], 'anthropic-messages' | 'responses'>,
): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? ''
  if (streamingApi) {
    const mediaType = contentType.toLowerCase().split(';', 1)[0]?.trim()
    if (mediaType !== 'text/event-stream') {
      throw new Error(
        `Setup ${streamingApi} streaming probe expected text/event-stream, received ${mediaType || 'no Content-Type'}.`,
      )
    }
    return await readSetupEventStream(response, streamingApi)
  }
  if (contentType.includes('json'))
    return await response.json()
  return await response.text()
}

async function readSetupEventStream(
  response: Response,
  api: Extract<SetupModelChoice['api'], 'anthropic-messages' | 'responses'>,
): Promise<unknown> {
  let anthropicMessageStarted = false
  let anthropicText = ''

  for await (const message of events(response)) {
    const frame = parseSetupEventStreamFrame(message)
    if (!frame)
      continue

    if (api === 'responses') {
      if (frame.type === 'response.completed') {
        if (!isSetupRecord(frame.response))
          throw new Error('Setup Responses SSE response.completed omitted its response object.')
        if (frame.response.status !== 'completed')
          throw new Error('Setup Responses SSE response.completed did not report completed status.')
        return frame.response
      }
      if (frame.type === 'error' || frame.type === 'response.failed' || frame.type === 'response.incomplete') {
        const code = setupWebSocketErrorCode(frame)
        throw new Error(`Setup Responses SSE ended with ${String(frame.type)}${code ? ` (${code})` : ''}.`)
      }
      continue
    }

    if (frame.type === 'message_start') {
      anthropicMessageStarted = true
      continue
    }
    if (frame.type === 'content_block_start') {
      const contentBlock = isSetupRecord(frame.content_block) ? frame.content_block : undefined
      if (contentBlock?.type === 'text' && typeof contentBlock.text === 'string')
        anthropicText += contentBlock.text
      continue
    }
    if (frame.type === 'content_block_delta') {
      const delta = isSetupRecord(frame.delta) ? frame.delta : undefined
      if (delta?.type === 'text_delta' && typeof delta.text === 'string')
        anthropicText += delta.text
      continue
    }
    if (frame.type === 'message_stop') {
      if (!anthropicMessageStarted)
        throw new Error('Setup Anthropic SSE received message_stop before message_start.')
      return {
        content: [{ type: 'text', text: anthropicText }],
      }
    }
    if (frame.type === 'error') {
      const code = setupWebSocketErrorCode(frame)
      throw new Error(`Setup Anthropic SSE ended with error${code ? ` (${code})` : ''}.`)
    }
  }

  throw new Error(
    api === 'responses'
      ? 'Setup Responses SSE ended before response.completed.'
      : 'Setup Anthropic SSE ended before message_stop.',
  )
}

function parseSetupEventStreamFrame(message: ServerSentEventMessage): Record<string, unknown> | undefined {
  if (typeof message.data !== 'string' || !message.data || message.data === '[DONE]')
    return undefined

  let frame: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(message.data)
    if (!isSetupRecord(parsed))
      throw new TypeError('event data must be a JSON object')
    frame = parsed
  }
  catch (error) {
    throw new Error('Setup streaming probe received an invalid JSON event.', { cause: error })
  }

  const frameType = typeof frame.type === 'string' ? frame.type : undefined
  if (message.event && frameType && message.event !== frameType) {
    throw new Error(`Setup streaming probe event mismatch: event=${message.event} data.type=${frameType}.`)
  }
  return !frameType && message.event ? { ...frame, type: message.event } : frame
}

function summarizeSetupError(value: unknown): string {
  if (typeof value === 'string')
    return value.slice(0, 500)
  if (value && typeof value === 'object') {
    const error = (value as Record<string, unknown>).error
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string')
        return message
    }
  }
  return JSON.stringify(value).slice(0, 500)
}

function isSetupRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setupStreamingProbeApi(
  client: SetupClient,
  api: SetupModelChoice['api'],
): Extract<SetupModelChoice['api'], 'anthropic-messages' | 'responses'> | undefined {
  if (client === 'codex' && api === 'responses')
    return 'responses'
  if (client === 'claude' && api === 'anthropic-messages')
    return 'anthropic-messages'
  return undefined
}

function safeSetupProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown failure'
}

function setupWebSocketErrorCode(frame: Record<string, unknown>): string | undefined {
  if (typeof frame.code === 'string' && frame.code)
    return frame.code.slice(0, 100)
  const response = frame.response
  const candidates = [
    frame.error,
    response && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>).error
      : undefined,
  ]
  for (const error of candidates) {
    if (!error || typeof error !== 'object' || Array.isArray(error))
      continue
    const code = (error as Record<string, unknown>).code
    if (typeof code === 'string' && code)
      return code.slice(0, 100)
  }
  return undefined
}

function toRunServerOptions(options: SetupOptions): RunServerOptions {
  return {
    port: options.port,
    host: options.host,
    verbose: false,
    accountType: options.accountType,
    manual: false,
    rateLimitWait: false,
    maxConcurrency: options.preset.maxConcurrency,
    maxQueue: options.preset.maxQueue,
    queueTimeoutMs: options.preset.queueTimeoutMs,
    claudeCode: false,
    showToken: false,
    proxyEnv: options.proxyEnv,
  }
}

function formatClientHost(host: string): string {
  const normalized = host.toLowerCase()
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]')
    return '127.0.0.1'
  if (host.includes(':') && !host.startsWith('['))
    return `[${host}]`
  return host
}

function resolveDisposableSetupProbeUrl(
  serverUrl: string | URL | undefined,
  configuredHost: string,
  configuredPort: number,
  requestPath: string,
): string {
  const url = serverUrl
    ? new URL(requestPath, serverUrl)
    : new URL(requestPath, `http://${formatClientHost(configuredHost)}:${configuredPort}`)
  const normalizedHost = configuredHost.toLowerCase()
  if (normalizedHost === '0.0.0.0')
    url.hostname = '127.0.0.1'
  else if (normalizedHost === '::' || normalizedHost === '[::]')
    url.hostname = '[::1]'
  return url.toString()
}

export const setup = defineCommand({
  meta: {
    name: 'setup',
    description: 'Authenticate, validate a live route, and generate client configuration. Codex only: preflight installed Codex >=0.134.0 and bundled metadata before authentication',
  },
  args: {
    'client': {
      type: 'positional',
      required: true,
      description: 'Client to configure: claude, codex, or openai-sdk',
    },
    'model': {
      type: 'string',
      description: 'Model to validate; Codex only: must have both a live direct route and installed bundled metadata (required when non-interactive)',
    },
    'small-model': {
      type: 'string',
      description: 'Direct small/fast Claude model; defaults to the primary model',
    },
    'port': {
      alias: 'p',
      type: 'string',
      default: '4399',
      description: 'Disposable validation listener and generated client port',
    },
    'host': {
      alias: 'H',
      type: 'string',
      default: '127.0.0.1',
      description: 'Disposable validation listener host',
    },
    'account-type': {
      alias: 'a',
      type: 'string',
      default: 'individual',
      description: 'Copilot account route: individual, business, or enterprise',
    },
    'preset': {
      type: 'enum',
      options: [...SETUP_PRESET_NAMES],
      default: 'personal',
      description: 'Local runtime preset used for validation: personal, service, or custom',
    },
    'proxy-env': {
      type: 'boolean',
      default: false,
      description: 'Use configured HTTP(S)_PROXY/NO_PROXY variables',
    },
    'shell': {
      type: 'enum',
      options: [...SHELL_NAMES],
      description: 'Shell syntax for generated commands; auto-detected when omitted',
    },
    'json': {
      type: 'boolean',
      default: false,
      description: 'Print the setup result and generated configuration as JSON; cannot be combined with --copy',
    },
    'copy': {
      type: 'boolean',
      default: false,
      description: 'Copy the generated configuration to the clipboard after validation; cannot be combined with --json',
    },
  },
  async run({ args, rawArgs }) {
    if (!isSetupClient(args.client)) {
      throw new TypeError(`Unknown setup client ${args.client}; choose ${SETUP_CLIENTS.join(', ')}`)
    }
    assertSetupSmallModelClient(args.client, args['small-model'])
    assertSetupOutputMode({ copy: args.copy, json: args.json })
    const port = validatePort(args.port)
    if (port === null)
      throw new TypeError(`Invalid port: ${args.port}`)
    const parsedHost = validateHost(args.host)
    if (parsedHost === null)
      throw new TypeError(`Invalid host: ${args.host}`)
    if (!validateAccountType(args['account-type']))
      throw new TypeError(`Invalid account-type: ${args['account-type']}`)
    if (!isRunPresetName(args.preset))
      throw new TypeError(`Invalid preset: ${args.preset}`)
    const preset = resolveRunPreset(args.preset, {
      ...(wasRunOptionPassed(rawArgs, 'host', 'H', 'setup') && { host: parsedHost }),
    })
    if (args['proxy-env'])
      assertProxyEndpointAvailable(process.env, setupProxyRequiredTargets(args['account-type']))
    const previousConsolaStdout = consola.options.stdout
    if (args.json)
      consola.options.stdout = process.stderr
    try {
      await runSetup({
        accountType: args['account-type'],
        client: args.client,
        copy: args.copy,
        host: preset.host,
        json: args.json,
        model: args.model,
        port,
        preset,
        proxyEnv: args['proxy-env'],
        shell: args.shell,
        smallModel: args['small-model'],
      })
    }
    finally {
      consola.options.stdout = previousConsolaStdout
    }
  },
})

function assertSetupOutputMode(options: Pick<SetupOptions, 'copy' | 'json'>): void {
  if (options.json && options.copy)
    throw new TypeError('setup --copy cannot be combined with --json; choose clipboard output or machine-readable JSON.')
}

function assertCodexModelSelection(
  options: Pick<SetupOptions, 'client' | 'json' | 'model'>,
  interactive: boolean,
): void {
  if (options.client === 'codex' && !options.model?.trim() && (options.json || !interactive)) {
    throw new TypeError(
      'setup codex requires --model in --json or non-interactive mode so it never silently chooses a model missing from the Codex client catalog. Run setup interactively or pass --model <model-id>.',
    )
  }
}

function assertSetupSmallModelClient(client: SetupClient, smallModel?: string): void {
  if (smallModel !== undefined && client !== 'claude')
    throw new TypeError('setup --small-model is only supported for the claude setup client.')
}
