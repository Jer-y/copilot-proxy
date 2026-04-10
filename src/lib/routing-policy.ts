import type { BackendApiType } from './model-config'

import type { AnthropicMessagesPayload } from '~/lib/translation/types'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import { resolveBackend } from './model-config'

export interface BackendRouteStep {
  api: BackendApiType
  context?: string
}

export interface BackendRoutePolicy {
  resolvedBackend: BackendApiType
  steps: Array<BackendRouteStep>
  localError?: string
  exhaustedError?: string
}

const RESPONSES_JSON_OBJECT_BYPASS_REASON = 'json_object structured output'
const RESPONSES_INPUT_FILE_REJECTION_MESSAGE = 'input_file is not supported when routing this model through native Anthropic translation. Use a model that supports /responses directly, or provide content that can be represented as translated text/image blocks.'
const MESSAGES_JSON_OBJECT_BYPASS_REASON = 'json_object requires an OpenAI-compatible backend'
const MESSAGES_URL_DOCUMENT_BYPASS_REASON = 'document.source.type="url" is expanded locally because Copilot native /v1/messages rejects URL-backed documents'

export function planChatCompletionsBackends(model: string): BackendRoutePolicy {
  const resolvedBackend = resolveBackend(model, 'chat-completions')
  return {
    resolvedBackend,
    steps: resolvedBackend === 'responses'
      ? [{ api: 'responses' }]
      : [{ api: 'chat-completions' }, { api: 'responses' }],
  }
}

export function planMessagesBackends(
  model: string,
  payload: AnthropicMessagesPayload,
): BackendRoutePolicy {
  const resolvedBackend = resolveBackend(model, 'anthropic-messages')
  const nativeAnthropicBypassReason = getMessagesNativeAnthropicBypassReason(payload)

  if (resolvedBackend === 'anthropic-messages') {
    return {
      resolvedBackend,
      steps: nativeAnthropicBypassReason
        ? [
            { api: 'chat-completions', context: nativeAnthropicBypassReason },
            { api: 'responses', context: nativeAnthropicBypassReason },
          ]
        : [
            { api: 'anthropic-messages' },
            { api: 'chat-completions' },
            { api: 'responses' },
          ],
    }
  }

  if (resolvedBackend === 'responses') {
    return {
      resolvedBackend,
      steps: [{ api: 'responses' }, { api: 'chat-completions' }],
    }
  }

  return {
    resolvedBackend,
    steps: [{ api: 'chat-completions' }, { api: 'responses' }],
  }
}

export function planResponsesBackends(
  model: string,
  payload: ResponsesPayload,
): BackendRoutePolicy {
  const resolvedBackend = resolveBackend(model, 'responses')
  const anthropicBypassReason = getResponsesAnthropicBypassReason(payload)
  const localError = resolvedBackend === 'anthropic-messages'
    ? getResponsesAnthropicTranslationRejectionReason(payload)
    : undefined

  if (resolvedBackend === 'chat-completions') {
    return {
      resolvedBackend,
      steps: [{ api: 'chat-completions' }, { api: 'responses' }],
    }
  }

  if (resolvedBackend === 'anthropic-messages') {
    return {
      resolvedBackend,
      localError,
      exhaustedError: anthropicBypassReason
        ? `Model ${model} does not support /chat/completions or /responses for ${anthropicBypassReason}.`
        : undefined,
      steps: anthropicBypassReason
        ? [
            { api: 'chat-completions', context: anthropicBypassReason },
            { api: 'responses', context: anthropicBypassReason },
          ]
        : [
            { api: 'anthropic-messages' },
            { api: 'chat-completions' },
            { api: 'responses' },
          ],
    }
  }

  return {
    resolvedBackend,
    steps: [{ api: 'responses' }, { api: 'chat-completions' }],
  }
}

function getResponsesAnthropicBypassReason(payload: ResponsesPayload): string | undefined {
  if (payload.text?.format?.type === 'json_object') {
    return RESPONSES_JSON_OBJECT_BYPASS_REASON
  }

  return undefined
}

function getResponsesAnthropicTranslationRejectionReason(payload: ResponsesPayload): string | undefined {
  if (payloadHasInputFileParts(payload)) {
    return RESPONSES_INPUT_FILE_REJECTION_MESSAGE
  }

  return undefined
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

function getMessagesNativeAnthropicBypassReason(
  payload: AnthropicMessagesPayload,
): string | undefined {
  if (getMessagesOutputFormatType(payload) === 'json_object') {
    return MESSAGES_JSON_OBJECT_BYPASS_REASON
  }

  if (payloadHasUrlDocumentSources(payload)) {
    return MESSAGES_URL_DOCUMENT_BYPASS_REASON
  }

  return undefined
}

function getMessagesOutputFormatType(
  payload: AnthropicMessagesPayload,
): string | undefined {
  const format = payload.output_config?.format
  return format && typeof format.type === 'string' ? format.type : undefined
}

function payloadHasUrlDocumentSources(payload: AnthropicMessagesPayload): boolean {
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }

    if (contentBlocksHaveUrlDocumentSource(message.content as Array<Record<string, unknown>>)) {
      return true
    }
  }

  return false
}

function contentBlocksHaveUrlDocumentSource(
  blocks: Array<Record<string, unknown>>,
): boolean {
  for (const block of blocks) {
    if (block.type === 'document') {
      const source = block.source
      if (source && typeof source === 'object' && 'type' in source && source.type === 'url') {
        return true
      }
    }

    if (
      block.type === 'tool_result'
      && Array.isArray(block.content)
      && contentBlocksHaveUrlDocumentSource(block.content as Array<Record<string, unknown>>)
    ) {
      return true
    }
  }

  return false
}
