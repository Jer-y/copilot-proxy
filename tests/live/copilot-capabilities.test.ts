import type {
  AnthropicFilesCapabilityProbe,
  AnthropicMessagesCapabilityProbe,
  CapabilityProbe,
  CapabilityProbeEndpoint,
  CapabilityProbeExpectation,
  LiveCopilotProbeConfig,
  ProbeErrorDetails,
} from './copilot-capability-matrix'
import type { AnthropicResponse } from '~/lib/translation/types'

import type { ChatCompletionResponse } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload, ResponsesResponse } from '~/services/copilot/create-responses'

import { expect, test } from 'bun:test'
import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError, JSONResponseError } from '~/lib/error'
import { state } from '~/lib/state'
import { createAnthropicMessages } from '~/services/copilot/create-anthropic-messages'
import { createChatCompletions } from '~/services/copilot/create-chat-completions'
import { createResponses } from '~/services/copilot/create-responses'
import { copilotCapabilityProbes } from './copilot-capability-matrix'

type ProbeStatus
  = | 'supported'
    | 'unsupported'
    | 'auth_error'
    | 'rate_limited'
    | 'api_error'
    | 'network_error'
    | 'unexpected_response'

interface ProbeOutcome {
  id: string
  endpoint: CapabilityProbeEndpoint
  title: string
  status: ProbeStatus
  model: string
  durationMs: number
  httpStatus?: number
  errorCode?: string
  message?: string
}

interface LiveEnvConfig extends LiveCopilotProbeConfig {
  token: string
  accountType: string
  vsCodeVersion: string
}

const LIVE_TEST_ENABLED = process.env.COPILOT_LIVE_TEST === '1'
const LIVE_TEST_TIMEOUT_MS = parseTimeout(process.env.COPILOT_LIVE_TIMEOUT_MS)
const LIVE_TEST_RETRY_COUNT = parseRetryCount(process.env.COPILOT_LIVE_RETRY_COUNT)
const runLiveTest = LIVE_TEST_ENABLED ? test : test.skip

runLiveTest(
  'runs the GitHub Copilot upstream capability probe matrix',
  async () => {
    const config = getLiveEnvConfig()
    const outcomes: Array<ProbeOutcome> = []
    const failures: Array<string> = []

    try {
      for (const probe of copilotCapabilityProbes) {
        const outcome = await runProbeWithRetries(probe, config)
        outcomes.push(outcome)

        if (!isAcceptableOutcome(probe.expectation, outcome.status)) {
          failures.push(formatFailure(probe, outcome))
        }
      }
    }
    finally {
      printSummary(outcomes)
    }

    expect(failures).toEqual([])
  },
  { timeout: LIVE_TEST_TIMEOUT_MS },
)

function parseTimeout(rawTimeout: string | undefined): number {
  const parsed = Number.parseInt(rawTimeout ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180_000
}

function parseRetryCount(rawRetryCount: string | undefined): number {
  const parsed = Number.parseInt(rawRetryCount ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2
}

async function runProbeWithRetries(
  probe: CapabilityProbe,
  config: LiveEnvConfig,
): Promise<ProbeOutcome> {
  let outcome = await runProbe(probe, config)

  for (let attempt = 1; attempt <= LIVE_TEST_RETRY_COUNT && isRetryableProbeOutcome(outcome); attempt++) {
    process.stdout.write(
      `Retrying live probe ${probe.id} after retryable ${outcome.status}${outcome.httpStatus ? ` http=${outcome.httpStatus}` : ''} (attempt ${attempt}/${LIVE_TEST_RETRY_COUNT})\n`,
    )
    outcome = await runProbe(probe, config)
  }

  return outcome
}

function isRetryableProbeOutcome(outcome: ProbeOutcome): boolean {
  if (outcome.status === 'network_error') {
    return true
  }

  return outcome.status === 'api_error'
    && outcome.httpStatus !== undefined
    && outcome.httpStatus >= 500
}

function getLiveEnvConfig(): LiveEnvConfig {
  const token = process.env.COPILOT_TOKEN
  if (!token) {
    throw new Error('COPILOT_TOKEN is required when COPILOT_LIVE_TEST=1')
  }

  return {
    token,
    accountType: process.env.COPILOT_ACCOUNT_TYPE ?? 'individual',
    vsCodeVersion: process.env.COPILOT_VSCODE_VERSION ?? '1.104.3',
    claudeModel: process.env.COPILOT_LIVE_CLAUDE_MODEL ?? 'claude-opus-4.6',
    responsesModel: process.env.COPILOT_LIVE_RESPONSES_MODEL ?? 'gpt-5.5',
    imageUrl:
      process.env.COPILOT_LIVE_IMAGE_URL
      ?? 'https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png',
    fileUrl:
      process.env.COPILOT_LIVE_FILE_URL
      ?? 'https://www.berkshirehathaway.com/letters/2024ltr.pdf',
  }
}

async function runProbe(
  probe: CapabilityProbe,
  config: LiveEnvConfig,
): Promise<ProbeOutcome> {
  const startedAt = Date.now()

  if (probe.endpoint === 'chat-completions') {
    const payload = probe.buildPayload(config)

    try {
      const result = await withLiveCopilotState(config, async () => {
        return await createChatCompletions(payload)
      })

      if (!isChatCompletionResponse(result.body)) {
        return {
          id: probe.id,
          endpoint: probe.endpoint,
          title: probe.title,
          status: 'unexpected_response',
          model: payload.model,
          durationMs: Date.now() - startedAt,
          message: `Expected chat.completion response object, got ${describeObjectType(result.body)}`,
        }
      }

      return {
        id: probe.id,
        endpoint: probe.endpoint,
        title: probe.title,
        status: 'supported',
        model: payload.model,
        durationMs: Date.now() - startedAt,
      }
    }
    catch (error) {
      return classifyProbeError({
        error,
        probe,
        model: payload.model,
        durationMs: Date.now() - startedAt,
      })
    }
  }

  if (probe.endpoint === 'anthropic-messages') {
    const payload = (probe as AnthropicMessagesCapabilityProbe).buildPayload(config)

    try {
      const result = await withLiveCopilotState(config, async () => {
        return await createAnthropicMessages(payload)
      })

      if (!isAnthropicResponse(result.body)) {
        return {
          id: probe.id,
          endpoint: probe.endpoint,
          title: probe.title,
          status: 'unexpected_response',
          model: payload.model,
          durationMs: Date.now() - startedAt,
          message: `Expected Anthropic messages response, got ${describeObjectType(result.body)}`,
        }
      }

      return {
        id: probe.id,
        endpoint: probe.endpoint,
        title: probe.title,
        status: 'supported',
        model: payload.model,
        durationMs: Date.now() - startedAt,
      }
    }
    catch (error) {
      return classifyProbeError({
        error,
        probe,
        model: payload.model,
        durationMs: Date.now() - startedAt,
      })
    }
  }

  if (probe.endpoint === 'anthropic-files') {
    const probeConfig = (probe as AnthropicFilesCapabilityProbe).buildPayload(config)

    try {
      const result = await withLiveCopilotState(config, async () => {
        const headers: Record<string, string> = {
          ...copilotHeaders(state),
          ...(probeConfig.headers || {}),
        }
        const response = await fetch(`${copilotBaseUrl(state)}/v1/files`, {
          method: 'GET',
          headers,
        })
        return { response, body: await response.json().catch(() => null) }
      })

      if (result.response.ok) {
        return {
          id: probe.id,
          endpoint: probe.endpoint,
          title: probe.title,
          status: 'supported',
          model: 'N/A',
          durationMs: Date.now() - startedAt,
        }
      }

      // Classify as unsupported if status matches
      if (probe.isUnsupported?.({ status: result.response.status })) {
        return {
          id: probe.id,
          endpoint: probe.endpoint,
          title: probe.title,
          status: 'unsupported',
          model: 'N/A',
          durationMs: Date.now() - startedAt,
          httpStatus: result.response.status,
        }
      }

      return {
        id: probe.id,
        endpoint: probe.endpoint,
        title: probe.title,
        status: 'api_error',
        model: 'N/A',
        durationMs: Date.now() - startedAt,
        httpStatus: result.response.status,
      }
    }
    catch (error) {
      return classifyProbeError({
        error,
        probe,
        model: 'N/A',
        durationMs: Date.now() - startedAt,
      })
    }
  }

  if (probe.endpoint === 'responses-raw') {
    const request = probe.buildRequest(config)

    try {
      const result = await withLiveCopilotState(config, async () => {
        const headers: Record<string, string> = {
          ...copilotHeaders(state),
          'X-Initiator': 'user',
          ...(request.body ? { 'Content-Type': 'application/json' } : {}),
        }
        const response = await fetch(`${copilotBaseUrl(state)}${request.path}`, {
          method: request.method,
          headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        })
        return { response, bodyText: await response.text() }
      })

      if (!result.response.ok) {
        throw new HTTPError('Failed to run raw Responses probe', new Response(result.bodyText, {
          status: result.response.status,
          statusText: result.response.statusText,
          headers: result.response.headers,
        }))
      }

      const expectedBody = request.expectedBody ?? 'any'
      if (!isExpectedRawResponsesBody(result.bodyText, expectedBody)) {
        return {
          id: probe.id,
          endpoint: probe.endpoint,
          title: probe.title,
          status: 'unexpected_response',
          model: request.model ?? 'N/A',
          durationMs: Date.now() - startedAt,
          message: `Expected ${expectedBody} body from ${request.method} ${request.path}`,
        }
      }

      return {
        id: probe.id,
        endpoint: probe.endpoint,
        title: probe.title,
        status: 'supported',
        model: request.model ?? 'N/A',
        durationMs: Date.now() - startedAt,
      }
    }
    catch (error) {
      return classifyProbeError({
        error,
        probe,
        model: request.model ?? 'N/A',
        durationMs: Date.now() - startedAt,
      })
    }
  }

  const payload = probe.buildPayload(config)

  try {
    const result = await withLiveCopilotState(config, async () => {
      // The live probe intentionally exercises candidate upstream values such
      // as reasoning.effort="xhigh" before translation behavior is enabled.
      return await createResponses(payload as ResponsesPayload)
    })

    if (!isResponsesResponse(result.body)) {
      return {
        id: probe.id,
        endpoint: probe.endpoint,
        title: probe.title,
        status: 'unexpected_response',
        model: payload.model,
        durationMs: Date.now() - startedAt,
        message: `Expected response object, got ${describeObjectType(result.body)}`,
      }
    }

    return {
      id: probe.id,
      endpoint: probe.endpoint,
      title: probe.title,
      status: 'supported',
      model: payload.model,
      durationMs: Date.now() - startedAt,
    }
  }
  catch (error) {
    return classifyProbeError({
      error,
      probe,
      model: payload.model,
      durationMs: Date.now() - startedAt,
    })
  }
}

function isExpectedRawResponsesBody(
  bodyText: string,
  expectedBody: 'any' | 'response' | 'response_stream' | 'input_tokens',
): boolean {
  if (expectedBody === 'any') {
    return true
  }

  if (expectedBody === 'response_stream') {
    return bodyText.includes('event: response.created')
      && bodyText.includes('event: response.completed')
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>
  }
  catch {
    return false
  }

  if (expectedBody === 'response') {
    return parsed.object === 'response'
  }

  return parsed.object === 'response.input_tokens'
    && typeof parsed.input_tokens === 'number'
}

async function withLiveCopilotState<T>(
  config: LiveEnvConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const snapshot = { ...state }

  state.copilotToken = config.token
  state.accountType = config.accountType
  state.vsCodeVersion = config.vsCodeVersion

  try {
    return await fn()
  }
  finally {
    Object.assign(state, snapshot)
  }
}

function isChatCompletionResponse(value: unknown): value is ChatCompletionResponse {
  return !!value
    && typeof value === 'object'
    && 'choices' in value
    && Array.isArray(value.choices)
    && 'model' in value
    && typeof value.model === 'string'
}

function isResponsesResponse(value: unknown): value is ResponsesResponse {
  return !!value
    && typeof value === 'object'
    && 'object' in value
    && value.object === 'response'
}

function isAnthropicResponse(body: unknown): body is AnthropicResponse {
  return (
    typeof body === 'object'
    && body !== null
    && 'content' in body
    && Array.isArray((body as AnthropicResponse).content)
  )
}

function describeObjectType(value: unknown): string {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return 'array'
  }

  return typeof value
}

async function classifyProbeError(args: {
  error: unknown
  probe: CapabilityProbe
  model: string
  durationMs: number
}): Promise<ProbeOutcome> {
  const { error, probe, model, durationMs } = args

  if (error instanceof HTTPError) {
    const details = await extractHttpErrorDetails(error.response)
    return {
      id: probe.id,
      endpoint: probe.endpoint,
      title: probe.title,
      status: classifyHttpErrorStatus(probe, details),
      model,
      durationMs,
      httpStatus: details.status,
      errorCode: details.code,
      message: details.message,
    }
  }

  if (error instanceof JSONResponseError) {
    return {
      id: probe.id,
      endpoint: probe.endpoint,
      title: probe.title,
      status: error.status === 429 ? 'rate_limited' : 'api_error',
      model,
      durationMs,
      httpStatus: error.status,
      message: error.message,
    }
  }

  if (error instanceof Error) {
    return {
      id: probe.id,
      endpoint: probe.endpoint,
      title: probe.title,
      status: looksLikeNetworkError(error) ? 'network_error' : 'api_error',
      model,
      durationMs,
      message: error.message,
    }
  }

  return {
    id: probe.id,
    endpoint: probe.endpoint,
    title: probe.title,
    status: 'api_error',
    model,
    durationMs,
    message: String(error),
  }
}

async function extractHttpErrorDetails(response: Response): Promise<ProbeErrorDetails> {
  const rawBody = await response.text()

  let code: string | undefined
  let message: string | undefined

  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    if (parsed.error && typeof parsed.error === 'object') {
      const nestedError = parsed.error as Record<string, unknown>
      code = typeof nestedError.code === 'string' ? nestedError.code : undefined
      message = typeof nestedError.message === 'string' ? nestedError.message : undefined
    }
    else {
      code = typeof parsed.code === 'string' ? parsed.code : undefined
      message = typeof parsed.message === 'string' ? parsed.message : undefined
    }
  }
  catch {
    message = rawBody || response.statusText || undefined
  }

  return {
    status: response.status,
    code,
    message,
    rawBody,
  }
}

function classifyHttpErrorStatus(
  probe: CapabilityProbe,
  details: ProbeErrorDetails,
): ProbeStatus {
  if (details.status === 401 || details.status === 403) {
    return 'auth_error'
  }

  if (details.status === 429) {
    return 'rate_limited'
  }

  if (probe.isUnsupported?.(details)) {
    return 'unsupported'
  }

  if (details.status >= 500) {
    return 'api_error'
  }

  return 'api_error'
}

function looksLikeNetworkError(error: Error): boolean {
  const haystack = `${error.name}\n${error.message}`.toLowerCase()

  return [
    'fetch',
    'network',
    'socket',
    'connect',
    'econnreset',
    'enotfound',
    'timed out',
    'timeout',
    'tls',
  ].some(term => haystack.includes(term))
}

function isAcceptableOutcome(
  expectation: CapabilityProbeExpectation,
  status: ProbeStatus,
): boolean {
  if (expectation === 'must_support') {
    return status === 'supported'
  }

  if (expectation === 'must_be_unsupported') {
    return status === 'unsupported'
  }

  return status === 'supported' || status === 'unsupported'
}

function formatFailure(probe: CapabilityProbe, outcome: ProbeOutcome): string {
  const details = [
    probe.id,
    `expected=${probe.expectation}`,
    `actual=${outcome.status}`,
    `endpoint=${outcome.endpoint}`,
    `model=${outcome.model}`,
  ]

  if (outcome.httpStatus !== undefined) {
    details.push(`http=${outcome.httpStatus}`)
  }

  if (outcome.errorCode) {
    details.push(`code=${outcome.errorCode}`)
  }

  if (outcome.message) {
    details.push(`message=${truncate(outcome.message, 160)}`)
  }

  return details.join(' ')
}

function printSummary(outcomes: Array<ProbeOutcome>): void {
  if (outcomes.length === 0) {
    return
  }

  process.stdout.write('GitHub Copilot live capability probe summary:\n')
  for (const outcome of outcomes) {
    const parts = [
      outcome.id,
      `status=${outcome.status}`,
      `endpoint=${outcome.endpoint}`,
      `model=${outcome.model}`,
      `duration_ms=${outcome.durationMs}`,
    ]

    if (outcome.httpStatus !== undefined) {
      parts.push(`http=${outcome.httpStatus}`)
    }

    if (outcome.errorCode) {
      parts.push(`code=${outcome.errorCode}`)
    }

    if (outcome.message) {
      parts.push(`message=${truncate(outcome.message, 160)}`)
    }

    process.stdout.write(`- ${parts.join(' ')}\n`)
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 3)}...`
}
