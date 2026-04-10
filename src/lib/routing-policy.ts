import type { BackendApiType } from './model-config'

import type { AnthropicMessagesPayload } from '~/lib/translation/types'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import { getModelConfig, resolveBackend } from './model-config'

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
  const steps = supportedSteps(
    model,
    resolvedBackend === 'responses'
      ? [{ api: 'responses' }, { api: 'chat-completions' }]
      : [{ api: 'chat-completions' }, { api: 'responses' }],
  )

  return {
    resolvedBackend,
    steps,
  }
}

export function planMessagesBackends(
  model: string,
  payload: AnthropicMessagesPayload,
): BackendRoutePolicy {
  const resolvedBackend = resolveBackend(model, 'anthropic-messages')
  const nativeAnthropicBypassReason = getMessagesNativeAnthropicBypassReason(payload)

  if (resolvedBackend === 'anthropic-messages') {
    const steps = nativeAnthropicBypassReason
      ? supportedSteps(model, [
          { api: 'chat-completions', context: nativeAnthropicBypassReason },
          { api: 'responses', context: nativeAnthropicBypassReason },
        ])
      : supportedSteps(model, [
          { api: 'anthropic-messages' },
          { api: 'chat-completions' },
          { api: 'responses' },
        ])

    return {
      resolvedBackend,
      localError: nativeAnthropicBypassReason && steps.length === 0
        ? buildNoCompatibleBackendError(model, nativeAnthropicBypassReason)
        : undefined,
      steps,
    }
  }

  if (resolvedBackend === 'responses') {
    return {
      resolvedBackend,
      steps: supportedSteps(model, [{ api: 'responses' }, { api: 'chat-completions' }]),
    }
  }

  return {
    resolvedBackend,
    steps: supportedSteps(model, [{ api: 'chat-completions' }, { api: 'responses' }]),
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
      steps: supportedSteps(model, [{ api: 'chat-completions' }, { api: 'responses' }]),
    }
  }

  if (resolvedBackend === 'anthropic-messages') {
    const steps = anthropicBypassReason
      ? supportedSteps(model, [
          { api: 'chat-completions', context: anthropicBypassReason },
          { api: 'responses', context: anthropicBypassReason },
        ])
      : supportedSteps(model, [
          { api: 'anthropic-messages' },
          { api: 'chat-completions' },
          { api: 'responses' },
        ])

    return {
      resolvedBackend,
      localError,
      exhaustedError: anthropicBypassReason
        ? buildExhaustedUnsupportedError(model, steps, anthropicBypassReason)
        : undefined,
      steps,
    }
  }

  return {
    resolvedBackend,
    steps: supportedSteps(model, [{ api: 'responses' }, { api: 'chat-completions' }]),
  }
}

function supportedSteps(
  model: string,
  steps: Array<BackendRouteStep>,
): Array<BackendRouteStep> {
  const supportedApis = new Set(getModelConfig(model).supportedApis)
  const seen = new Set<BackendApiType>()
  const filtered: Array<BackendRouteStep> = []

  for (const step of steps) {
    if (!supportedApis.has(step.api) || seen.has(step.api)) {
      continue
    }
    seen.add(step.api)
    filtered.push(step)
  }

  return filtered
}

function buildExhaustedUnsupportedError(
  model: string,
  steps: Array<BackendRouteStep>,
  context: string,
): string {
  if (steps.length === 0) {
    return buildNoCompatibleBackendError(model, context)
  }

  return `Model ${model} does not support ${joinWithOr(steps.map(step => formatBackendApi(step.api)))}${formatContext(context)}.`
}

function buildNoCompatibleBackendError(model: string, context: string): string {
  return `Model ${model} does not support any backend compatible with ${context}.`
}

function formatBackendApi(api: BackendApiType): string {
  switch (api) {
    case 'anthropic-messages':
      return '/v1/messages'
    case 'chat-completions':
      return '/chat/completions'
    case 'responses':
      return '/responses'
  }
}

function joinWithOr(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? ''
  }

  if (values.length === 2) {
    return `${values[0]} or ${values[1]}`
  }

  return `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`
}

function formatContext(context: string | undefined): string {
  return context ? ` (${context})` : ''
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
