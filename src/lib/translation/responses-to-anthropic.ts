/**
 * Responses API → Anthropic translation
 *
 * T8:  translateResponsesResponseToAnthropic  — non-stream response translation
 * T10: translateResponsesRequestToAnthropic   — request payload translation
 * T9:  translateResponsesStreamEventToAnthropic — streaming translation (state machine)
 */

import type {
  AnthropicAssistantContentBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicStreamState,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
} from './types'
import type {
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesMessageInputItem,
  ResponsesOutputItem,
  ResponsesPayload,
  ResponsesResponse,
  ResponsesStreamEvent,
  ResponsesTool,
} from '~/services/copilot/create-responses'

import { randomUUID } from 'node:crypto'
import { JSONResponseError } from '~/lib/error'
import { assertResponsesPayloadTranslatable } from '~/lib/routing-policy'
import { isRecord } from '~/lib/type-guards'
import { logLossyAnthropicCompatibility } from './anthropic-compat'
import {
  createAnthropicErrorPayloadFromResponses,
  mapResponsesStatusToAnthropicStopReason,
  throwAnthropicErrorFromFailedResponses,
} from './utils'

type AnthropicOutputConfig = NonNullable<AnthropicMessagesPayload['output_config']>
type AnthropicOutputConfigFormat = NonNullable<AnthropicOutputConfig['format']>

export function translateResponsesResponseToAnthropic(
  response: ResponsesResponse,
  options?: { requestedModel?: string },
): AnthropicResponse {
  if (response.status === 'queued' || response.status === 'in_progress' || response.status === 'cancelled') {
    const message = `Responses status "${response.status}" cannot be represented as a completed Anthropic message.`
    throw new JSONResponseError(message, 502, {
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
    })
  }

  if (response.status === 'failed') {
    throwAnthropicErrorFromFailedResponses(response)
  }

  const content = extractAnthropicContent(response.output)
  const stopReason = mapResponsesStatusToAnthropicStopReason(
    response.status,
    response.output,
    response.incomplete_details,
  )

  const cachedInputTokens = response.usage?.input_tokens_details?.cached_tokens
  const uncachedInputTokens = Math.max(
    0,
    (response.usage?.input_tokens ?? 0) - (cachedInputTokens ?? 0),
  )

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: options?.requestedModel ?? response.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: uncachedInputTokens,
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(cachedInputTokens !== undefined && {
        cache_read_input_tokens: cachedInputTokens,
      }),
    },
  }
}

function extractAnthropicContent(
  output: Array<ResponsesOutputItem>,
): Array<AnthropicAssistantContentBlock> {
  const content: Array<AnthropicAssistantContentBlock> = []
  let omittedReasoningSummary = false

  for (const item of output) {
    switch (item.type) {
      case 'message': {
        if (item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) {
              content.push({
                type: 'text',
                text: part.text,
              } as AnthropicTextBlock)
            }
          }
        }
        break
      }

      case 'function_call': {
        if (item.call_id && item.name) {
          const parsedInput = parseToolArguments(
            item.arguments,
            'response.output[].function_call.arguments',
            throwInvalidUpstreamToolArguments,
          )

          content.push({
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: parsedInput,
          } as AnthropicToolUseBlock)
        }
        break
      }

      case 'reasoning': {
        if (item.summary) {
          for (const summary of item.summary) {
            if (
              summary.type === 'summary_text'
              && summary.text
              && !omittedReasoningSummary
            ) {
              logLossyAnthropicCompatibility(
                'responses reasoning summaries',
                'Responses reasoning summaries are advisory text without Anthropic thinking signatures, so they are omitted instead of being replayed as unsigned thinking blocks.',
              )
              omittedReasoningSummary = true
            }
          }
        }
        break
      }
      // No default
    }
  }

  return content
}

// ─── T10: Responses Request → Anthropic Request ───────────────────

export function translateResponsesRequestToAnthropic(
  payload: ResponsesPayload,
  options?: { model?: string },
): AnthropicMessagesPayload {
  assertResponsesPayloadTranslatable(payload, throwInvalidRequestError)

  if (payload.prompt_cache_key !== undefined) {
    logLossyAnthropicCompatibility(
      'responses prompt_cache_key',
      'Anthropic Messages has no equivalent cache-routing key; the hint is omitted without changing response semantics.',
    )
  }
  if (payload.prompt_cache_retention !== undefined && payload.prompt_cache_retention !== null) {
    logLossyAnthropicCompatibility(
      'responses prompt_cache_retention',
      'Anthropic Messages cache retention is controlled by block-level cache_control, so the Responses retention hint is omitted.',
    )
  }
  if (payload.service_tier !== undefined && payload.service_tier !== null) {
    logLossyAnthropicCompatibility(
      'responses service_tier',
      'Responses service_tier values do not map one-to-one to Anthropic Messages service_tier and are omitted on translation.',
    )
  }

  const model = options?.model ?? payload.model
  const { messages, prefixSystemParts } = translateResponsesInputToAnthropicMessages(payload.input)
  const system = buildSystemString(
    payload.instructions,
    prefixSystemParts,
  )
  const tools = translateResponsesToolsToAnthropic(payload.tools)
  const toolChoice = translateResponsesToAnthropicToolChoice(
    payload.tool_choice,
    payload.parallel_tool_calls,
  )
  const outputConfig = buildOutputConfig(payload)
  const thinking = payload.reasoning?.effort === 'none'
    ? { type: 'disabled' as const }
    : undefined

  return {
    model,
    messages,
    ...(system !== undefined && { system }),
    ...(payload.stream != null && { stream: payload.stream }),
    ...(payload.temperature != null && { temperature: payload.temperature }),
    ...(payload.top_p != null && { top_p: payload.top_p }),
    ...(payload.max_output_tokens != null && { max_tokens: payload.max_output_tokens }),
    ...(tools && { tools }),
    ...(toolChoice && { tool_choice: toolChoice }),
    ...(thinking && { thinking }),
    ...(outputConfig && { output_config: outputConfig }),
  }
}

function translateResponsesInputToAnthropicMessages(
  input: ResponsesPayload['input'],
): { messages: Array<AnthropicMessage>, prefixSystemParts: string[] } {
  const prefixSystemParts: string[] = []
  if (typeof input === 'string') {
    return { messages: [{ role: 'user', content: input }], prefixSystemParts }
  }

  const messages: Array<AnthropicMessage> = []
  let pendingAssistantBlocks: Array<AnthropicAssistantContentBlock> = []
  let pendingUserBlocks: Array<AnthropicUserContentBlock> = []
  let conversationStarted = false

  const flushAssistant = () => {
    if (pendingAssistantBlocks.length > 0) {
      messages.push({ role: 'assistant', content: pendingAssistantBlocks })
      pendingAssistantBlocks = []
    }
  }

  const flushUser = () => {
    if (pendingUserBlocks.length > 0) {
      messages.push({ role: 'user', content: pendingUserBlocks })
      pendingUserBlocks = []
    }
  }

  for (const item of input) {
    if ('type' in item && item.type === 'reasoning') {
      throwInvalidRequestError(
        'Responses reasoning input items cannot be represented on the Anthropic Messages translation path. Use a model routed directly through /responses instead.',
      )
    }

    if (isFunctionCallItem(item)) {
      conversationStarted = true
      // tool_use → assistant side
      flushUser()
      const parsedInput = parseToolArguments(
        item.arguments,
        'input[].function_call.arguments',
        throwInvalidRequestError,
      )
      pendingAssistantBlocks.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parsedInput,
      })
      continue
    }

    if (isFunctionCallOutputItem(item)) {
      conversationStarted = true
      // tool_result → user side (don't flush user — merge multiple)
      flushAssistant()
      pendingUserBlocks.push({
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: translateFunctionCallOutputContent(item.output as unknown),
        ...(isFunctionCallOutputError(item) && { is_error: true }),
      })
      continue
    }

    if (!isMessageInputItem(item)) {
      throwUnsupportedInputItem(item)
    }

    if (item.role === 'system' || item.role === 'developer') {
      const text = flattenToString(item.content)
      if (!conversationStarted) {
        prefixSystemParts.push(text)
        continue
      }

      flushAssistant()
      flushUser()
      appendMidConversationSystemMessage(messages, text)
      continue
    }

    if (item.role === 'user') {
      conversationStarted = true
      flushAssistant()
      flushUser()
      pushUserContentBlocks(item.content, pendingUserBlocks)
      continue
    }

    if (item.role === 'assistant') {
      conversationStarted = true
      flushAssistant()
      flushUser()
      pushAssistantContentBlocks(item.content, pendingAssistantBlocks)
      continue
    }

    const unsupportedRole = (item as { role?: unknown }).role
    throwInvalidRequestError(
      `Unsupported Responses message role "${String(unsupportedRole)}"; expected one of user, assistant, system, or developer.`,
    )
  }

  flushAssistant()
  flushUser()

  validateMidConversationSystemFollowers(messages)

  return { messages, prefixSystemParts }
}

function validateMidConversationSystemFollowers(messages: Array<AnthropicMessage>): void {
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role !== 'system')
      continue

    const next = messages[index + 1]
    if (next !== undefined && next.role !== 'assistant') {
      throwInvalidRequestError(
        'A translated mid-conversation system/developer message must precede an assistant turn or end the message array.',
      )
    }
  }
}

function appendMidConversationSystemMessage(
  messages: Array<AnthropicMessage>,
  text: string,
): void {
  const previous = messages.at(-1)
  if (previous?.role === 'system') {
    const previousText = typeof previous.content === 'string'
      ? previous.content
      : previous.content.map(block => block.text).join('\n\n')
    previous.content = [previousText, text].filter(Boolean).join('\n\n')
    return
  }

  // Anthropic's mid-conversation-system beta only permits a system turn after
  // a user turn (tool results are represented as user turns too). Moving an
  // instruction across an assistant turn would change its semantics, so fail
  // explicitly instead of hoisting or sending an upstream-invalid request.
  if (previous?.role !== 'user') {
    throwInvalidRequestError(
      'Responses system/developer messages can only be translated at the start of the conversation or immediately after a user/tool-result turn.',
    )
  }

  messages.push({ role: 'system', content: text })
}

function flattenToString(content: ResponsesMessageInputItem['content']): string {
  if (typeof content === 'string') {
    return content
  }

  if (!content || content.length === 0) {
    return ''
  }

  const parts: string[] = []
  for (const part of content) {
    if (part.type === 'input_text' && typeof part.text === 'string') {
      parts.push(part.text)
    }
    else {
      throwInvalidRequestError(
        `Unsupported content part type "${part.type}" in system/developer message; only input_text is allowed`,
      )
    }
  }

  return parts.join('\n\n')
}

function parseToolArguments(
  value: string | undefined,
  context: string,
  onInvalid: (message: string) => never,
): Record<string, unknown> {
  if (!value) {
    return onInvalid(`${context} must contain a JSON object; received an empty value.`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  }
  catch {
    return onInvalid(`${context} must be valid JSON encoding an object.`)
  }

  if (isRecord(parsed)) {
    return parsed
  }
  return onInvalid(`${context} must decode to a JSON object.`)
}

function buildSystemString(
  instructions: string | null | undefined,
  prefixSystemParts: string[],
): string | undefined {
  const parts = [instructions, ...prefixSystemParts].filter(Boolean) as string[]
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function pushUserContentBlocks(
  content: ResponsesMessageInputItem['content'],
  blocks: Array<AnthropicUserContentBlock>,
): void {
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content })
    return
  }

  if (!content || content.length === 0) {
    return
  }

  for (const part of content) {
    switch (part.type) {
      case 'input_text':
      case 'output_text':
      case 'text':
        if (typeof part.text === 'string') {
          blocks.push({ type: 'text', text: part.text })
        }
        break
      case 'input_image':
      case 'image_url':
        blocks.push(translateImagePartToAnthropicBlock(part))
        break
      default:
        throwInvalidRequestError(
          `Unsupported Responses user content part type "${part.type}" for anthropic-messages translation.`,
        )
    }
  }
}

function pushAssistantContentBlocks(
  content: ResponsesMessageInputItem['content'],
  blocks: Array<AnthropicAssistantContentBlock>,
): void {
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content })
    return
  }

  if (!content || content.length === 0) {
    return
  }

  for (const part of content) {
    if (
      (part.type === 'output_text' || part.type === 'text')
      && typeof part.text === 'string'
    ) {
      blocks.push({ type: 'text', text: part.text })
    }
    else {
      throwInvalidRequestError(
        `Unsupported Responses assistant content part type "${part.type}" for anthropic-messages translation.`,
      )
    }
  }
}

function translateImagePartToAnthropicBlock(
  part: Record<string, unknown>,
): AnthropicImageBlock {
  // base64 source object (from Anthropic → Responses roundtrip)
  if (part.source != null && typeof part.source === 'object') {
    return { type: 'image', source: part.source } as AnthropicImageBlock
  }

  // URL-based image — parse data: URLs to base64 (Copilot rejects source.type='url')
  const url = resolveImageUrl(part)
  if (url) {
    const dataUrlMatch = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
    if (dataUrlMatch) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: dataUrlMatch[1],
          data: dataUrlMatch[2],
        },
      } as AnthropicImageBlock
    }
    // External URLs are not supported by Copilot's Anthropic backend
    throwInvalidRequestError(
      'GitHub Copilot does not support external image URLs for Anthropic image blocks. Use base64 image data instead.',
    )
  }

  throwInvalidRequestError('Image part has no valid image_url or base64 source')
}

function resolveImageUrl(part: Record<string, unknown>): string | undefined {
  if (typeof part.image_url === 'string') {
    return part.image_url
  }

  if (part.image_url && typeof part.image_url === 'object') {
    const urlObj = part.image_url as Record<string, unknown>
    if (typeof urlObj.url === 'string') {
      return urlObj.url
    }
  }

  return undefined
}

function translateResponsesToolsToAnthropic(
  tools: Array<ResponsesTool> | undefined,
): Array<AnthropicTool> | undefined {
  if (!tools || tools.length === 0) {
    return undefined
  }

  const functionTools = tools.filter(isResponsesFunctionTool)
  if (functionTools.length === 0) {
    return undefined
  }

  return functionTools.map(tool => ({
    name: tool.name,
    ...(tool.description && { description: tool.description }),
    input_schema: (tool.parameters ?? {}) as Record<string, unknown>,
    ...(typeof tool.strict === 'boolean' && { strict: tool.strict }),
  }))
}

function isResponsesFunctionTool(tool: ResponsesTool): tool is ResponsesTool & { type: 'function', name: string } {
  return tool.type === 'function' && typeof tool.name === 'string' && tool.name.length > 0
}

function translateResponsesToAnthropicToolChoice(
  toolChoice: ResponsesPayload['tool_choice'],
  parallelToolCalls: boolean | null | undefined,
): AnthropicMessagesPayload['tool_choice'] | undefined {
  const disableParallel = parallelToolCalls === false

  if (toolChoice === undefined || toolChoice === null) {
    if (disableParallel) {
      return { type: 'auto', disable_parallel_tool_use: true }
    }
    return undefined
  }

  let mapped: AnthropicMessagesPayload['tool_choice'] | undefined

  if (toolChoice === 'auto') {
    mapped = { type: 'auto' }
  }
  else if (toolChoice === 'required') {
    mapped = { type: 'any' }
  }
  else if (toolChoice === 'none') {
    mapped = { type: 'none' }
  }
  else if (typeof toolChoice === 'object' && toolChoice.type === 'function' && typeof toolChoice.name === 'string') {
    mapped = { type: 'tool', name: toolChoice.name }
  }

  if (mapped && disableParallel) {
    mapped.disable_parallel_tool_use = true
  }

  return mapped
}

function buildOutputConfig(
  payload: ResponsesPayload,
): AnthropicMessagesPayload['output_config'] | undefined {
  let effort: AnthropicOutputConfig['effort'] | undefined
  let format: AnthropicOutputConfigFormat | undefined

  if (payload.reasoning?.effort) {
    effort = mapResponsesReasoningEffortToAnthropic(payload.reasoning.effort)
  }

  if (payload.text?.format?.type === 'json_schema') {
    format = normalizeResponsesJsonSchemaFormat(payload.text.format)
  }
  else if (payload.text?.format?.type === 'json_object') {
    throwInvalidRequestError(
      'Responses text.format.type="json_object" cannot be represented by Anthropic native /v1/messages. Use json_schema with an explicit schema or a model routed directly through /responses.',
    )
  }
  else if (payload.text?.format?.type && payload.text.format.type !== 'text') {
    throwInvalidRequestError(
      `Unsupported Responses text.format.type="${payload.text.format.type}" for anthropic-messages translation`,
    )
  }

  if (!effort && !format) {
    return undefined
  }

  return {
    ...(effort && { effort }),
    ...(format && { format }),
  }
}

function mapResponsesReasoningEffortToAnthropic(
  effort: NonNullable<NonNullable<ResponsesPayload['reasoning']>['effort']>,
): AnthropicOutputConfig['effort'] | undefined {
  if (effort === 'none') {
    return undefined
  }

  if (effort === 'minimal') {
    return 'low'
  }

  return effort
}

function normalizeResponsesJsonSchemaFormat(
  format: NonNullable<NonNullable<ResponsesPayload['text']>['format']>,
): AnthropicOutputConfigFormat {
  if (!isRecord(format)) {
    throwInvalidRequestError('Responses text.format must be an object')
  }

  const nestedJsonSchema = isRecord(format.json_schema)
    ? format.json_schema
    : undefined

  if (nestedJsonSchema && format.schema !== undefined) {
    throwInvalidRequestError(
      'Responses text.format for json_schema must use either "schema" or "json_schema.schema", not both',
    )
  }

  if (nestedJsonSchema && format.name !== undefined) {
    throwInvalidRequestError(
      'Responses text.format for json_schema must use either "name" or "json_schema.name", not both',
    )
  }

  if (nestedJsonSchema && format.strict !== undefined) {
    throwInvalidRequestError(
      'Responses text.format for json_schema must use either "strict" or "json_schema.strict", not both',
    )
  }

  const schema = nestedJsonSchema?.schema ?? format.schema
  if (!isRecord(schema)) {
    throwInvalidRequestError(
      'Responses text.format.type="json_schema" requires an object "schema"',
    )
  }

  const name = nestedJsonSchema?.name ?? format.name
  if (name !== undefined && typeof name !== 'string') {
    throwInvalidRequestError(
      'Responses text.format.type="json_schema" expects "name" to be a string when provided',
    )
  }

  const strict = nestedJsonSchema?.strict ?? format.strict
  if (strict !== undefined && typeof strict !== 'boolean') {
    throwInvalidRequestError(
      'Responses text.format.type="json_schema" expects "strict" to be a boolean when provided',
    )
  }
  if (strict !== undefined) {
    logLossyAnthropicCompatibility(
      'responses text.format.strict',
      'Anthropic native output_config.format does not support a strict flag, so strict is ignored on anthropic-messages translation.',
    )
  }
  if (typeof name === 'string' && name.trim().length > 0) {
    logLossyAnthropicCompatibility(
      'responses text.format.name',
      'Anthropic native output_config.format does not accept a schema name, so the Responses-only name is omitted.',
    )
  }

  return {
    type: 'json_schema',
    schema,
  }
}

// ─── Type guards (T10) ─────────────────────────────────────────────

function isFunctionCallItem(item: ResponsesInputItem): item is ResponsesFunctionCallItem {
  return 'type' in item && item.type === 'function_call'
}

function isFunctionCallOutputItem(item: ResponsesInputItem): item is ResponsesFunctionCallOutputItem {
  return 'type' in item && item.type === 'function_call_output'
}

function isMessageInputItem(item: ResponsesInputItem): item is ResponsesMessageInputItem {
  return 'role' in item
    && typeof item.role === 'string'
    && 'content' in item
    && (item.type === undefined || item.type === 'message')
}

/**
 * Attempt to rehydrate a tool result output string back to structured content.
 *
 * Normal mixed/image tool results now use native rich Responses output parts.
 * This string fallback remains for legacy payloads and for the compatibility
 * envelope used to preserve Anthropic is_error semantics.
 *
 * Only rehydrates if ALL parsed elements are known Anthropic tool_result content types
 * (text, image). Returns string as-is for unknown structures to avoid sending
 * arbitrary JSON as Anthropic blocks.
 */
function translateFunctionCallOutputContent(
  output: unknown,
): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
  if (typeof output === 'string') {
    return rehydrateToolResultContent(output)
  }

  if (!Array.isArray(output)) {
    return throwInvalidRequestError(
      'Responses function_call_output.output must be a string or an array of input_text/input_image/input_file content parts.',
    )
  }

  return output.map((part, index) => {
    if (!isRecord(part) || typeof part.type !== 'string') {
      return throwInvalidRequestError(
        `Responses function_call_output.output[${index}] must be a typed content part.`,
      )
    }

    switch (part.type) {
      case 'input_text':
        if (typeof part.text !== 'string') {
          return throwInvalidRequestError(
            `Responses function_call_output.output[${index}].text must be a string.`,
          )
        }
        return { type: 'text' as const, text: part.text }

      case 'input_image':
        if (typeof part.file_id === 'string') {
          return throwInvalidRequestError(
            'Responses input_image file_id content cannot be represented on the Anthropic Messages translation path. Provide a base64 data URL instead.',
          )
        }
        return translateImagePartToAnthropicBlock(part)

      case 'input_file':
        return throwInvalidRequestError(
          'Responses input_file content cannot be represented losslessly on the Anthropic Messages translation path. Use a model routed directly through /responses.',
        )

      default:
        return throwInvalidRequestError(
          `Unsupported Responses function_call_output content part type "${part.type}" for anthropic-messages translation.`,
        )
    }
  })
}

function rehydrateToolResultContent(output: string): string | Array<AnthropicTextBlock | AnthropicImageBlock> {
  try {
    const parsed = JSON.parse(output)
    if (
      isRecord(parsed)
      && parsed.is_error === true
      && typeof parsed.content === 'string'
    ) {
      return rehydrateToolResultContent(parsed.content)
    }

    if (!Array.isArray(parsed) || parsed.length === 0)
      return output

    // Strictly validate every element is a known Anthropic tool_result content block
    const isValidAnthropicBlocks = parsed.every(
      (block: unknown) =>
        typeof block === 'object'
        && block !== null
        && 'type' in block
        && ((block as Record<string, unknown>).type === 'text'
          || (block as Record<string, unknown>).type === 'image'),
    )
    if (!isValidAnthropicBlocks)
      return output

    return parsed as Array<AnthropicTextBlock | AnthropicImageBlock>
  }
  catch {
    // Not valid JSON — return as plain string
  }
  return output
}

function isFunctionCallOutputError(item: ResponsesFunctionCallOutputItem): boolean {
  if (item.is_error === true || item.status === 'incomplete') {
    return true
  }

  const output: unknown = item.output
  if (typeof output !== 'string') {
    return false
  }

  try {
    const parsed = JSON.parse(output) as unknown
    return isRecord(parsed) && parsed.is_error === true
  }
  catch {
    return false
  }
}

function throwInvalidRequestError(message: string): never {
  throw new JSONResponseError(message, 400, {
    error: {
      message,
      type: 'invalid_request_error',
    },
  })
}

function throwInvalidUpstreamToolArguments(message: string): never {
  throw new JSONResponseError(message, 502, {
    type: 'error',
    error: {
      type: 'api_error',
      message,
    },
  })
}

function throwUnsupportedInputItem(item: ResponsesInputItem): never {
  const itemType = 'type' in item ? item.type : 'unknown'
  throwInvalidRequestError(
    `Unsupported Responses input item type "${itemType}" for anthropic-messages translation`,
  )
}

// ─── T9: Responses Stream → Anthropic Stream ────────────────────

export function createAnthropicFromResponsesStreamState(options?: { requestedModel?: string }): AnthropicStreamState {
  return {
    responseId: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    responseModel: options?.requestedModel ?? 'unknown',
    messageStartSent: false,
    messageStopSent: false,
    upstreamTerminalEventSeen: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    currentBlockType: null,
    thinkingSignature: null,
    pendingLeadingText: '',
    hasThinkingContent: false,
    hasNonThinkingContent: false,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: {},
    requestedModel: options?.requestedModel,
  }
}

/**
 * Translate a single Responses stream event into Anthropic SSE events.
 */
export function translateResponsesStreamEventToAnthropic(
  event: ResponsesStreamEvent,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (state.messageStopSent) {
    return events
  }

  switch (event.type) {
    case 'response.created': {
      rememberResponseEnvelope(state, event.response)
      ensureMessageStarted(events, state)
      break
    }

    case 'response.output_text.delta': {
      ensureMessageStarted(events, state)
      if (isToolBlockOpen(state)) {
        closeOpenAnthropicBlock(events, state)
      }

      if (!state.contentBlockOpen) {
        events.push({
          type: 'content_block_start',
          index: state.contentBlockIndex,
          content_block: { type: 'text', text: '' },
        })
        state.contentBlockOpen = true
        state.currentBlockType = 'text'
      }

      events.push({
        type: 'content_block_delta',
        index: state.contentBlockIndex,
        delta: { type: 'text_delta', text: event.delta },
      })
      state.hasNonThinkingContent = true
      break
    }

    case 'response.output_item.added': {
      if (event.item.type === 'function_call' && event.item.call_id && event.item.name) {
        ensureMessageStarted(events, state)
        if (state.contentBlockOpen) {
          closeOpenAnthropicBlock(events, state)
        }

        const blockIndex = state.contentBlockIndex
        state.toolCalls[event.output_index] = {
          id: event.item.call_id,
          name: event.item.name,
          anthropicBlockIndex: blockIndex,
        }

        events.push({
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: event.item.call_id,
            name: event.item.name,
            input: {},
          },
        })
        state.contentBlockOpen = true
        state.currentBlockType = 'tool_use'
        state.hasNonThinkingContent = true
      }
      break
    }

    case 'response.function_call_arguments.delta': {
      const tc = state.toolCalls[event.output_index]
      if (tc) {
        events.push({
          type: 'content_block_delta',
          index: tc.anthropicBlockIndex,
          delta: { type: 'input_json_delta', partial_json: event.delta },
        })
      }
      break
    }

    case 'response.output_item.done': {
      if (event.item.type === 'function_call') {
        parseToolArguments(
          event.item.arguments,
          'response.output_item.done.item.arguments',
          throwInvalidUpstreamToolArguments,
        )
      }
      if (state.contentBlockOpen) {
        closeOpenAnthropicBlock(events, state)
      }
      break
    }

    case 'response.completed':
    case 'response.incomplete': {
      state.upstreamTerminalEventSeen = true
      rememberResponseEnvelope(state, event.response)
      ensureMessageStarted(events, state)
      if (event.response.status === 'failed') {
        closeOpenAnthropicBlock(events, state)
        events.push({
          type: 'error',
          error: createAnthropicErrorPayloadFromResponses(event.response).error,
        })
        state.messageStopSent = true
        break
      }

      if (state.contentBlockOpen) {
        closeOpenAnthropicBlock(events, state)
      }

      const stopReason = mapResponsesStatusToAnthropicStopReason(
        event.response.status,
        event.response.output,
        event.response.incomplete_details,
      )

      events.push(
        {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: buildAnthropicStreamUsage(state),
        },
        { type: 'message_stop' },
      )
      state.messageStopSent = true
      break
    }

    case 'response.failed': {
      state.upstreamTerminalEventSeen = true
      rememberResponseEnvelope(state, event.response)
      closeOpenAnthropicBlock(events, state)
      events.push({
        type: 'error',
        error: createAnthropicErrorPayloadFromResponses(event.response).error,
      })
      state.messageStopSent = true
      break
    }

    case 'error': {
      state.upstreamTerminalEventSeen = true
      closeOpenAnthropicBlock(events, state)
      events.push({
        type: 'error',
        error: createAnthropicErrorPayloadFromResponses(
          normalizeResponsesStreamError(event),
        ).error,
      })
      state.messageStopSent = true
      break
    }

    case 'response.in_progress':
    case 'response.content_part.added':
    case 'response.content_part.done':
      break
  }

  return events
}

function normalizeResponsesStreamError(event: unknown): {
  message: string
  code?: string
  type?: string
} {
  const eventRecord = isRecord(event) ? event : {}
  const source = isRecord(eventRecord.error) ? eventRecord.error : eventRecord

  return {
    message: typeof source.message === 'string'
      ? source.message
      : 'Responses request failed',
    ...(typeof source.code === 'string' && { code: source.code }),
    ...(typeof source.type === 'string' && source.type !== 'error' && { type: source.type }),
  }
}

function ensureMessageStarted(
  events: Array<AnthropicStreamEventData>,
  state: AnthropicStreamState,
): void {
  if (state.messageStartSent) {
    return
  }

  events.push({
    type: 'message_start',
    message: {
      id: state.responseId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.responseModel,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: state.inputTokens,
        output_tokens: 0,
        ...(state.cacheReadInputTokens !== undefined && {
          cache_read_input_tokens: state.cacheReadInputTokens,
        }),
      },
    },
  })
  state.messageStartSent = true
}

function rememberResponseEnvelope(
  state: AnthropicStreamState,
  response: ResponsesResponse,
): void {
  state.responseId = response.id || state.responseId
  state.responseModel = state.requestedModel ?? response.model ?? state.responseModel

  if (response.usage) {
    const cachedInputTokens = response.usage.input_tokens_details?.cached_tokens
      ?? state.cacheReadInputTokens
    state.inputTokens = Math.max(
      0,
      (response.usage.input_tokens ?? state.inputTokens) - (cachedInputTokens ?? 0),
    )
    state.outputTokens = response.usage.output_tokens ?? state.outputTokens
    if (cachedInputTokens !== undefined) {
      state.cacheReadInputTokens = cachedInputTokens
    }
  }
}

function buildAnthropicStreamUsage(
  state: AnthropicStreamState,
): NonNullable<Extract<AnthropicStreamEventData, { type: 'message_delta' }>['usage']> {
  return {
    input_tokens: state.inputTokens,
    output_tokens: state.outputTokens,
    ...(state.cacheReadInputTokens !== undefined && {
      cache_read_input_tokens: state.cacheReadInputTokens,
    }),
  }
}

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  return state.contentBlockOpen && state.currentBlockType === 'tool_use'
}

function closeOpenAnthropicBlock(
  events: Array<AnthropicStreamEventData>,
  state: AnthropicStreamState,
): void {
  if (!state.contentBlockOpen) {
    return
  }

  if (state.currentBlockType === 'thinking') {
    if (typeof state.thinkingSignature === 'string' && state.thinkingSignature.length > 0) {
      events.push({
        type: 'content_block_delta',
        index: state.contentBlockIndex,
        delta: {
          type: 'signature_delta',
          signature: state.thinkingSignature,
        },
      })
    }
  }

  events.push({
    type: 'content_block_stop',
    index: state.contentBlockIndex,
  })
  state.contentBlockIndex++
  state.contentBlockOpen = false
  state.currentBlockType = null
  state.thinkingSignature = null
}
