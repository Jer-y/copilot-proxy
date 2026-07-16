import type { BackendApiType } from './model-config'

import type { AnthropicMessagesPayload } from '~/lib/translation/types'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import type { Model } from '~/services/copilot/get-models'
import { isAnthropicServerTool } from './anthropic-tools'
import { formatBackendApi } from './backend-api'
import { getModelConfig } from './model-config'
import { findModelWithFallback } from './model-utils'
import { mapAnthropicReasoningToResponses, resolveAnthropicReasoningEffort } from './translation/anthropic-reasoning'
import { isRecord } from './type-guards'

/**
 * Where the request will actually go upstream and whether the proxy translates it.
 *
 * - `direct`: client protocol equals backend protocol — forward with minimal sanitization
 * - `translate`: client protocol differs from backend protocol — apply the translation
 *   path matching (clientApi, backend). Only allowed inside the
 *   `{anthropic-messages, responses}` family.
 */
interface BackendRoute {
  backend: BackendApiType
  kind: 'direct' | 'translate'
}

type ClientApi = BackendApiType

const RESPONSES_WEBSOCKET_ENDPOINT_PATTERN = /^wss?:\/(?:v1\/)?responses\/?$/i

const RESPONSES_INPUT_FILE_REJECTION_MESSAGE
  = 'input_file is only supported when routing this model directly through /responses. Use a model that supports /responses directly, or provide content that can be represented as translated text/image blocks.'
const RESPONSES_HOSTED_TOOL_REJECTION_MESSAGE
  = 'Hosted Responses tools are only supported when routing this model directly through /responses. Use a Responses-backed model or replace hosted tools with function tools.'
const ANTHROPIC_SERVER_TOOL_REJECTION_MESSAGE
  = 'Anthropic server-side tools are only supported when routing this model directly through /v1/messages. Use a Claude model with native /v1/messages support, or replace server-side tools with custom tools that can be translated.'

const ANTHROPIC_TRANSLATION_REJECTIONS = {
  context_management: 'Anthropic context_management cannot be represented on the Responses translation path without changing conversation state. Use a model routed directly through /v1/messages.',
  mcp_servers: 'Anthropic MCP servers cannot be represented on the Responses translation path. Use a model routed directly through /v1/messages.',
  parallel_tool_calls: 'Anthropic disable_parallel_tool_use cannot be preserved because the selected Responses model does not support parallel_tool_calls.',
  reasoning: 'The requested Anthropic thinking/output_config.effort cannot be preserved by the selected Responses model.',
  server_tool_history: 'Anthropic server-tool history cannot be represented on the Responses translation path without dropping conversation state. Use a model routed directly through /v1/messages.',
  stop_sequences: 'Anthropic stop_sequences cannot be enforced by the Responses translation path. Use a model routed directly through /v1/messages.',
  task_budget: 'Anthropic output_config.task_budget cannot be represented on the Responses translation path. Use a model routed directly through /v1/messages.',
  tool_choice: 'Anthropic tool_choice cannot be preserved because the selected Responses model does not support tool_choice.',
  top_k: 'Anthropic top_k cannot be represented on the Responses translation path.',
} as const

const RESPONSES_TRANSLATION_REJECTIONS = {
  background: 'Responses background execution cannot be represented on the Anthropic Messages translation path. Use a model routed directly through /responses.',
  context_management: 'Responses context_management cannot be represented on the Anthropic Messages translation path without changing conversation state.',
  conversation: 'Responses conversation state cannot be represented on the Anthropic Messages translation path. Send the complete conversation as input instead.',
  include: 'Responses include fields cannot be returned by the Anthropic Messages translation path.',
  max_tool_calls: 'Responses max_tool_calls cannot be enforced by the Anthropic Messages translation path.',
  previous_response_id: 'Responses previous_response_id cannot be represented on the Anthropic Messages translation path. Send the complete prior context as input instead.',
  prompt: 'Stored Responses prompts cannot be resolved by the Anthropic Messages translation path. Expand the prompt into instructions and input first.',
  reasoning_summary: 'Responses reasoning summaries cannot be produced faithfully by the Anthropic Messages translation path.',
  reasoning_config: 'Responses reasoning must be an object on the Anthropic Messages translation path.',
  store: 'Responses are stored by default. The Anthropic Messages translation path is stateless, so requests routed through it must explicitly set store=false.',
  stream_options: 'Responses stream_options.include_obfuscation cannot be honored by the Anthropic Messages translation path.',
  text_config: 'Responses text must be an object on the Anthropic Messages translation path.',
  text_verbosity: 'Responses text.verbosity cannot be represented on the Anthropic Messages translation path.',
  top_logprobs: 'Responses top_logprobs cannot be returned by the Anthropic Messages translation path.',
  tool_choice: 'This Responses tool_choice value cannot be represented on the Anthropic Messages translation path.',
  truncation: 'Responses automatic truncation cannot be represented on the Anthropic Messages translation path. Use truncation="disabled" or a model routed directly through /responses.',
} as const

/**
 * Resolve the upstream backend for a (clientApi, model) pair.
 *
 * This is a pure routing decision — no payload inspection, no runtime probe,
 * no fallback chain. Payload-level compatibility checks for the Responses
 * translation path live in `assertResponsesPayloadTranslatable`, called by
 * the Responses handler after a `translate` route is resolved.
 *
 * Throws via the supplied `onLocalError` when the model lists no supported
 * backend compatible with the client protocol.
 *
 * Routing rules:
 *  1. If clientApi ∈ model.supportedApis  → `direct`.
 *  2. Else if clientApi ∈ {anthropic-messages, responses}
 *       and the other one ∈ model.supportedApis → `translate`.
 *  3. Else → 4xx via `onLocalError`.
 *
 * The proxy does NOT translate to or from `chat-completions`. Clients of the
 * Anthropic or Responses APIs cannot reach a chat-completions-only model, and
 * vice versa.
 */
export function resolveRoute(
  clientApi: ClientApi,
  model: string,
  onLocalError: (message: string) => never,
  options?: {
    models?: Array<Model>
  },
): BackendRoute {
  const supportedApis = getSupportedApisForRouting(model, options?.models)

  if (supportedApis.has(clientApi)) {
    return { backend: clientApi, kind: 'direct' }
  }

  const peer = peerInTranslatableFamily(clientApi)
  if (peer && supportedApis.has(peer)) {
    return { backend: peer, kind: 'translate' }
  }

  onLocalError(buildUnsupportedClientApiError(clientApi, model, supportedApis))
}

function getSupportedApisForRouting(
  model: string,
  models?: Array<Model>,
): Set<BackendApiType> {
  const liveModel = findModelWithFallback(model, models)
  if (liveModel?.supported_endpoints?.length) {
    return new Set(
      liveModel.supported_endpoints
        .map(endpointToBackendApi)
        .filter((api): api is BackendApiType => api !== undefined),
    )
  }

  return new Set(getModelConfig(model).supportedApis)
}

function endpointToBackendApi(endpoint: string): BackendApiType | undefined {
  const normalized = endpoint.trim().toLowerCase()

  // WebSocket endpoints are transport capabilities, not evidence that the
  // corresponding HTTP API is available. In particular, a model advertising
  // only `ws:/responses` must not be routed through POST /responses.
  if (/^wss?:/.test(normalized)) {
    return undefined
  }

  const normalizedPath = normalized
    .replace(/^\/v1\//, '/')
    .replace(/^v1\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  switch (normalizedPath) {
    case 'chat/completions':
      return 'chat-completions'
    case 'responses':
      return 'responses'
    case 'messages':
      return 'anthropic-messages'
    default:
      return undefined
  }
}

/**
 * Return whether the live Copilot model catalog explicitly advertises the
 * ordinary HTTP Responses endpoint. WebSocket metadata is intentionally not
 * treated as evidence that POST /responses is available.
 */
export function modelSupportsResponsesHttp(
  model: Pick<Model, 'supported_endpoints'> | undefined,
): boolean {
  return model?.supported_endpoints?.some(endpoint =>
    endpointToBackendApi(endpoint) === 'responses',
  ) ?? false
}

/**
 * Return whether the live Copilot model catalog explicitly advertises the
 * Responses WebSocket transport. Ordinary `/responses` support and static
 * model defaults are intentionally insufficient evidence for this capability.
 */
export function modelSupportsResponsesWebSocket(
  model: Pick<Model, 'supported_endpoints'> | undefined,
): boolean {
  return model?.supported_endpoints?.some(endpoint =>
    RESPONSES_WEBSOCKET_ENDPOINT_PATTERN.test(endpoint.trim()),
  ) ?? false
}

/**
 * Reject Responses payloads carrying features that cannot survive translation
 * to /v1/messages (hosted tools, input_file). Intended for callers that have
 * resolved a `translate` route and need to validate the payload.
 */
export function assertResponsesPayloadTranslatable(
  payload: ResponsesPayload,
  onLocalError: (message: string) => never,
): void {
  if (payloadHasHostedTools(payload)) {
    onLocalError(RESPONSES_HOSTED_TOOL_REJECTION_MESSAGE)
  }
  if (payloadHasInputFileParts(payload)) {
    onLocalError(RESPONSES_INPUT_FILE_REJECTION_MESSAGE)
  }
  if (payload.store !== false) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.store)
  }
  if (payload.previous_response_id != null) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.previous_response_id)
  }
  if (payload.background != null && payload.background !== false) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.background)
  }
  if (payload.conversation != null) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.conversation)
  }
  if (payload.prompt != null) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.prompt)
  }
  if (payload.max_tool_calls != null) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.max_tool_calls)
  }
  if (payload.context_management != null
    && (!Array.isArray(payload.context_management) || payload.context_management.length > 0)) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.context_management)
  }
  if (payload.truncation != null && payload.truncation !== 'disabled') {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.truncation)
  }
  if (payload.include != null && (!Array.isArray(payload.include) || payload.include.length > 0)) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.include)
  }
  if (payload.stream_options != null
    && (!isRecord(payload.stream_options)
      || (payload.stream_options.include_obfuscation !== undefined
        && payload.stream_options.include_obfuscation !== false))) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.stream_options)
  }
  if (payload.top_logprobs != null) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.top_logprobs)
  }
  if (payload.text != null && !isRecord(payload.text)) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.text_config)
  }
  if (isRecord(payload.text) && payload.text.verbosity != null) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.text_verbosity)
  }
  if (payload.reasoning != null && !isRecord(payload.reasoning)) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.reasoning_config)
  }
  if (isRecord(payload.reasoning)
    && ((payload.reasoning.summary != null && payload.reasoning.summary !== 'none')
      || payload.reasoning.generate_summary != null)) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.reasoning_summary)
  }
  if (!isTranslatableResponsesToolChoice(payload.tool_choice)) {
    onLocalError(RESPONSES_TRANSLATION_REJECTIONS.tool_choice)
  }
}

/**
 * Reject Anthropic Messages payloads carrying native server-side tools that
 * cannot be represented on the Responses translation path. Direct
 * /v1/messages routes intentionally leave these fields for upstream to decide.
 */
export function assertMessagesPayloadTranslatable(
  payload: AnthropicMessagesPayload,
  onLocalError: (message: string) => never,
): void {
  if (payloadHasAnthropicServerTools(payload)) {
    onLocalError(ANTHROPIC_SERVER_TOOL_REJECTION_MESSAGE)
  }

  if (payload.stop_sequences && payload.stop_sequences.length > 0) {
    onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.stop_sequences)
  }

  if (payload.top_k !== undefined) {
    onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.top_k)
  }

  const payloadRecord = payload as unknown as Record<string, unknown>
  const outputConfig = isRecord(payload.output_config)
    ? payload.output_config as Record<string, unknown>
    : undefined
  if (outputConfig?.task_budget != null) {
    onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.task_budget)
  }

  const mcpServers = payloadRecord.mcp_servers
  if (mcpServers != null && (!Array.isArray(mcpServers) || mcpServers.length > 0)) {
    onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.mcp_servers)
  }

  if (hasMeaningfulAnthropicContextManagement(payloadRecord.context_management)) {
    onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.context_management)
  }

  if (payloadHasAnthropicServerToolHistory(payload)) {
    onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.server_tool_history)
  }

  const modelConfig = getModelConfig(payload.model)
  if (payload.tool_choice !== undefined && modelConfig.supportsToolChoice !== true) {
    onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.tool_choice)
  }

  if (payload.tool_choice?.disable_parallel_tool_use === true
    && modelConfig.supportsParallelToolCalls !== true) {
    onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.parallel_tool_calls)
  }

  if (payload.thinking !== undefined || payload.output_config?.effort != null) {
    const effort = resolveAnthropicReasoningEffort(payload, modelConfig)
    if (!effort || !mapAnthropicReasoningToResponses(effort, modelConfig)) {
      onLocalError(ANTHROPIC_TRANSLATION_REJECTIONS.reasoning)
    }
  }
}

function peerInTranslatableFamily(clientApi: ClientApi): BackendApiType | undefined {
  if (clientApi === 'anthropic-messages')
    return 'responses'
  if (clientApi === 'responses')
    return 'anthropic-messages'
  return undefined
}

function buildUnsupportedClientApiError(
  clientApi: ClientApi,
  model: string,
  supportedApis: ReadonlySet<BackendApiType>,
): string {
  const supportedList = [...supportedApis].map(formatBackendApi).join(', ')
  if (supportedApis.size === 0) {
    return `Model ${model} has no supported backend API.`
  }
  return `Model ${model} cannot be reached via ${formatBackendApi(clientApi)}. Supported backend(s): ${supportedList}. The proxy does not translate between /chat/completions and other endpoints.`
}

function payloadHasHostedTools(payload: ResponsesPayload): boolean {
  return Boolean(payload.tools?.some(tool => !isRecord(tool) || tool.type !== 'function'))
}

function payloadHasInputFileParts(payload: ResponsesPayload): boolean {
  if (typeof payload.input === 'string' || !Array.isArray(payload.input)) {
    return false
  }

  for (const item of payload.input) {
    if (isRecord(item) && item.type === 'input_file') {
      return true
    }

    if (isRecord(item)
      && item.type === 'function_call_output'
      && Array.isArray(item.output)
      && item.output.some(part => isRecord(part) && part.type === 'input_file')) {
      return true
    }

    if (!isRecord(item) || !Array.isArray(item.content)) {
      continue
    }

    for (const part of item.content) {
      if (isRecord(part) && part.type === 'input_file') {
        return true
      }
    }
  }

  return false
}

function isTranslatableResponsesToolChoice(toolChoice: ResponsesPayload['tool_choice']): boolean {
  if (toolChoice === undefined || toolChoice === null) {
    return true
  }

  if (toolChoice === 'auto' || toolChoice === 'required' || toolChoice === 'none') {
    return true
  }

  return typeof toolChoice === 'object'
    && toolChoice.type === 'function'
    && typeof toolChoice.name === 'string'
    && toolChoice.name.length > 0
}

function payloadHasAnthropicServerTools(payload: AnthropicMessagesPayload): boolean {
  return Boolean(payload.tools?.some(isAnthropicServerTool))
}

function payloadHasAnthropicServerToolHistory(payload: AnthropicMessagesPayload): boolean {
  for (const message of payload.messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      if (block.type === 'server_tool_use' || block.type.endsWith('_tool_result')) {
        return true
      }
    }
  }

  return false
}

function hasMeaningfulAnthropicContextManagement(value: unknown): boolean {
  if (value == null) {
    return false
  }

  if (!isRecord(value)) {
    return true
  }

  const entries = Object.entries(value)
  if (entries.length === 0) {
    return false
  }

  return entries.some(([key, entryValue]) => key !== 'edits' || !Array.isArray(entryValue) || entryValue.length > 0)
}
