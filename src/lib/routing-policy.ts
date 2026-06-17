import type { BackendApiType } from './model-config'

import type { AnthropicMessagesPayload } from '~/lib/translation/types'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import { isAnthropicServerTool } from './anthropic-tools'
import { formatBackendApi } from './backend-api'
import { getModelConfig } from './model-config'

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

const RESPONSES_INPUT_FILE_REJECTION_MESSAGE
  = 'input_file is only supported when routing this model directly through /responses. Use a model that supports /responses directly, or provide content that can be represented as translated text/image blocks.'
const RESPONSES_HOSTED_TOOL_REJECTION_MESSAGE
  = 'Hosted Responses tools are only supported when routing this model directly through /responses. Use a Responses-backed model or replace hosted tools with function tools.'
const ANTHROPIC_SERVER_TOOL_REJECTION_MESSAGE
  = 'Anthropic server-side tools are only supported when routing this model directly through /v1/messages. Use a Claude model with native /v1/messages support, or replace server-side tools with custom tools that can be translated.'

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
): BackendRoute {
  const supportedApis = new Set(getModelConfig(model).supportedApis)

  if (supportedApis.has(clientApi)) {
    return { backend: clientApi, kind: 'direct' }
  }

  const peer = peerInTranslatableFamily(clientApi)
  if (peer && supportedApis.has(peer)) {
    return { backend: peer, kind: 'translate' }
  }

  onLocalError(buildUnsupportedClientApiError(clientApi, model, supportedApis))
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
  return Boolean(payload.tools?.some(tool => tool.type !== 'function'))
}

function payloadHasInputFileParts(payload: ResponsesPayload): boolean {
  if (typeof payload.input === 'string' || !Array.isArray(payload.input)) {
    return false
  }

  for (const item of payload.input) {
    if ('type' in item && item.type === 'input_file') {
      return true
    }

    if (!('content' in item) || !Array.isArray(item.content)) {
      continue
    }

    for (const part of item.content) {
      if (part.type === 'input_file') {
        return true
      }
    }
  }

  return false
}

function payloadHasAnthropicServerTools(payload: AnthropicMessagesPayload): boolean {
  return Boolean(payload.tools?.some(isAnthropicServerTool))
}
