import type { AnthropicMessagesPayload, AnthropicResponse, AnthropicStreamEventData } from '~/lib/translation/types'

import consola from 'consola'
import { HTTPError } from '~/lib/error'
import { assertCopilotCompatibleAnthropicRequest, logLossyAnthropicCompatibility, throwAnthropicInvalidRequestError } from '~/lib/translation/anthropic-compat'
import { expandDocumentBlocks, normalizeLegacyDocumentTextSources } from '~/lib/translation/anthropic-documents'
import { createAnthropicMessages } from '~/services/copilot/create-anthropic-messages'

const INVALID_THINKING_SIGNATURE_PATTERN = /invalid [`'"]?signature[`'"]? in [`'"]?thinking[`'"]? block/i

export async function createAnthropicMessagesWithThinkingSignatureRetry(
  payload: AnthropicMessagesPayload,
  options?: { signal?: AbortSignal, anthropicBeta?: string },
): ReturnType<typeof createAnthropicMessages> {
  try {
    return await createAnthropicMessages(payload, options)
  }
  catch (error) {
    if (!await isInvalidThinkingSignatureError(error)) {
      throw error
    }

    const stripped = stripAssistantThinkingBlocks(payload)
    if (!stripped.stripped) {
      throw error
    }

    logLossyAnthropicCompatibility(
      'assistant thinking replay',
      'Native /v1/messages rejected a replayed assistant thinking signature, so the proxy retried once after stripping assistant thinking/redacted_thinking history.',
    )

    const requestId = error instanceof HTTPError
      ? error.response.headers.get('x-request-id')
      : null
    const requestIdSuffix = requestId ? ` (request id: ${requestId})` : ''
    const droppedSuffix = stripped.droppedAssistantMessages > 0
      ? ` and dropping ${stripped.droppedAssistantMessages} thinking-only assistant turn(s)`
      : ''

    consola.warn(
      `Native Anthropic passthrough retrying once after removing ${stripped.strippedBlocks} assistant thinking/redacted_thinking block(s)${droppedSuffix}${requestIdSuffix}.`,
    )

    if (consola.level >= 4) {
      consola.debug('Native Anthropic self-heal payload:', JSON.stringify(stripped.payload))
    }

    return await createAnthropicMessages(stripped.payload, options)
  }
}

/**
 * Minimal sanitization for the native Anthropic passthrough path.
 *
 * The Copilot backend rejects a small number of fields that Claude Code
 * sends. Rather than translating the entire payload (as the CC path does),
 * we surgically strip only the known-bad fields and leave everything else
 * intact.
 *
 * Mutates the payload in place.
 */
export function sanitizeForCopilotBackend(payload: AnthropicMessagesPayload): void {
  const payloadWithContextManagement = payload as AnthropicMessagesPayload & {
    context_management?: unknown
  }

  // 1. context_management - Copilot does not support this field (with or without beta flag)
  if ('context_management' in payloadWithContextManagement) {
    consola.debug('Stripping context_management (unsupported by Copilot backend)')
    delete payloadWithContextManagement.context_management
  }

  normalizeLegacyDocumentTextSources(payload)

  const format = payload.output_config?.format
  if (!format || typeof format !== 'object' || format.type !== 'json_schema') {
    return
  }

  const formatRecord = format as Record<string, unknown>
  const nestedJsonSchema = isRecord(formatRecord.json_schema)
    ? formatRecord.json_schema
    : undefined
  const hasFlatSchema = isRecord(formatRecord.schema)
  const hasNestedSchema = isRecord(nestedJsonSchema?.schema)

  if (hasFlatSchema && hasNestedSchema) {
    throwAnthropicInvalidRequestError(
      'Anthropic output_config.format for json_schema must use either flat "schema" or legacy "json_schema.schema", not both.',
    )
  }

  if (!hasFlatSchema && hasNestedSchema) {
    formatRecord.schema = nestedJsonSchema!.schema
  }

  if (!isRecord(formatRecord.schema)) {
    throwAnthropicInvalidRequestError(
      'Anthropic output_config.format.type="json_schema" requires an object "schema".',
    )
  }

  if ('json_schema' in formatRecord) {
    consola.debug('Flattening legacy output_config.format.json_schema to output_config.format.schema')
    delete formatRecord.json_schema
  }

  if ('name' in formatRecord) {
    consola.debug('Stripping output_config.format.name (unsupported by Copilot /v1/messages backend)')
    delete formatRecord.name
  }

  if ('strict' in formatRecord) {
    consola.debug('Stripping output_config.format.strict (unsupported by Copilot /v1/messages backend)')
    delete formatRecord.strict
  }
}

export function normalizeAnthropicThinkingForCopilot(
  payload: AnthropicMessagesPayload,
): void {
  if (!payload.thinking || typeof payload.thinking !== 'object' || !('type' in payload.thinking)) {
    return
  }

  if (payload.thinking.type !== 'adaptive') {
    return
  }

  const thinking = payload.thinking as Record<string, unknown>
  if ('budget_tokens' in thinking) {
    throwAnthropicInvalidRequestError(
      'thinking.adaptive.budget_tokens: Extra inputs are not permitted',
    )
  }

  if ('budget_tokens_max' in thinking) {
    consola.debug('Stripping budget_tokens_max from adaptive thinking (unsupported by Copilot)')
    delete thinking.budget_tokens_max
  }
}

export async function prepareAnthropicPayloadForTranslatedBackends(
  payload: AnthropicMessagesPayload,
): Promise<void> {
  normalizeLegacyDocumentTextSources(payload)
  await expandDocumentBlocks(payload)
  assertCopilotCompatibleAnthropicRequest(payload)
}

export function overrideAnthropicResponseModel(
  response: AnthropicResponse,
  requestedModel: string,
): AnthropicResponse {
  return {
    ...response,
    model: requestedModel,
  }
}

export function overrideAnthropicStreamEventModel(
  event: AnthropicStreamEventData,
  requestedModel: string,
): AnthropicStreamEventData {
  if (event.type !== 'message_start') {
    return event
  }

  return {
    ...event,
    message: {
      ...event.message,
      model: requestedModel,
    },
  }
}

async function isInvalidThinkingSignatureError(error: unknown): Promise<boolean> {
  if (!(error instanceof HTTPError) || error.response.status !== 400) {
    return false
  }

  const upstreamMessage = await readUpstreamErrorMessage(error.response)
  return typeof upstreamMessage === 'string'
    && INVALID_THINKING_SIGNATURE_PATTERN.test(upstreamMessage)
}

async function readUpstreamErrorMessage(response: Response): Promise<string | undefined> {
  let errorText: string
  try {
    errorText = await response.clone().text()
  }
  catch {
    return undefined
  }

  if (!errorText) {
    return undefined
  }

  try {
    return extractUpstreamErrorMessage(JSON.parse(errorText)) ?? errorText
  }
  catch {
    return errorText
  }
}

function extractUpstreamErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined
  }

  if (typeof payload.message === 'string') {
    return payload.message
  }

  const error = payload.error
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message
  }

  return undefined
}

function stripAssistantThinkingBlocks(
  payload: AnthropicMessagesPayload,
): {
  payload: AnthropicMessagesPayload
  stripped: boolean
  strippedBlocks: number
  droppedAssistantMessages: number
} {
  let strippedBlocks = 0
  let droppedAssistantMessages = 0

  const messages = payload.messages.flatMap((message) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return [message]
    }

    const content = message.content.filter((block) => {
      const shouldStrip = block.type === 'thinking' || block.type === 'redacted_thinking'
      if (shouldStrip) {
        strippedBlocks += 1
      }
      return !shouldStrip
    })

    if (content.length === message.content.length) {
      return [message]
    }

    if (content.length === 0) {
      droppedAssistantMessages += 1
      return []
    }

    return [{ ...message, content }]
  })

  if (strippedBlocks === 0) {
    return {
      payload,
      stripped: false,
      strippedBlocks: 0,
      droppedAssistantMessages: 0,
    }
  }

  return {
    payload: {
      ...payload,
      messages,
    },
    stripped: true,
    strippedBlocks,
    droppedAssistantMessages,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
