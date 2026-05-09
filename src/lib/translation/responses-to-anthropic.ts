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

import { JSONResponseError } from '~/lib/error'
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
  if (response.status === 'failed') {
    throwAnthropicErrorFromFailedResponses(response)
  }

  const content = extractAnthropicContent(response.output)
  const stopReason = mapResponsesStatusToAnthropicStopReason(
    response.status,
    response.output,
    response.incomplete_details,
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
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(response.usage?.input_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens: response.usage.input_tokens_details.cached_tokens,
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
          const parsedInput = parseToolArguments(item.arguments, 'response.output[].function_call.arguments')

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
  const model = options?.model ?? payload.model
  const { messages, systemParts } = translateResponsesInputToAnthropicMessages(payload.input)
  const system = buildSystemString(payload.instructions, systemParts)
  const tools = translateResponsesToolsToAnthropic(payload.tools)
  const toolChoice = translateResponsesToAnthropicToolChoice(
    payload.tool_choice,
    payload.parallel_tool_calls,
  )
  const outputConfig = buildOutputConfig(payload)

  return {
    model,
    messages,
    ...(system !== undefined && { system }),
    stream: payload.stream,
    ...(payload.temperature != null && { temperature: payload.temperature }),
    ...(payload.top_p != null && { top_p: payload.top_p }),
    ...(payload.max_output_tokens != null && { max_tokens: payload.max_output_tokens }),
    ...(tools && { tools }),
    ...(toolChoice && { tool_choice: toolChoice }),
    ...(outputConfig && { output_config: outputConfig }),
  }
}

function translateResponsesInputToAnthropicMessages(
  input: ResponsesPayload['input'],
): { messages: Array<AnthropicMessage>, systemParts: string[] } {
  const systemParts: string[] = []

  if (typeof input === 'string') {
    return {
      messages: [{ role: 'user', content: input }],
      systemParts,
    }
  }

  const messages: Array<AnthropicMessage> = []
  let pendingAssistantBlocks: Array<AnthropicAssistantContentBlock> = []
  let pendingUserBlocks: Array<AnthropicUserContentBlock> = []

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
    if (isFunctionCallItem(item)) {
      // tool_use → assistant side
      flushUser()
      const parsedInput = parseToolArguments(item.arguments, 'input[].function_call.arguments')
      pendingAssistantBlocks.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parsedInput,
      })
      continue
    }

    if (isFunctionCallOutputItem(item)) {
      // tool_result → user side (don't flush user — merge multiple)
      flushAssistant()
      pendingUserBlocks.push({
        type: 'tool_result',
        tool_use_id: item.call_id,
        content: rehydrateToolResultContent(item.output),
        ...(isFunctionCallOutputError(item) && { is_error: true }),
      })
      continue
    }

    if (!isMessageInputItem(item)) {
      throwUnsupportedInputItem(item)
    }

    if (item.role === 'system' || item.role === 'developer') {
      systemParts.push(flattenToString(item.content))
      continue
    }

    if (item.role === 'user') {
      flushAssistant()
      flushUser()
      pushUserContentBlocks(item.content, pendingUserBlocks)
      continue
    }

    if (item.role === 'assistant') {
      flushAssistant()
      flushUser()
      pushAssistantContentBlocks(item.content, pendingAssistantBlocks)
      continue
    }
  }

  flushAssistant()
  flushUser()

  return { messages, systemParts }
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
): Record<string, unknown> {
  if (!value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value) as unknown
    if (isRecord(parsed)) {
      return parsed
    }
    logLossyAnthropicCompatibility(
      context,
      'Tool arguments JSON did not parse to an object; forwarding an empty object for Anthropic compatibility.',
    )
  }
  catch {
    logLossyAnthropicCompatibility(
      context,
      'Tool arguments were not valid JSON; forwarding an empty object for Anthropic compatibility.',
    )
  }

  return {}
}

function stringifyUnknownContentPart(part: Record<string, unknown>): string {
  try {
    return JSON.stringify(part)
  }
  catch {
    return String(part.type ?? '[unknown content part]')
  }
}

function buildSystemString(
  instructions: string | undefined,
  systemParts: string[],
): string | undefined {
  const parts = [instructions, ...systemParts].filter(Boolean) as string[]
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
        logLossyAnthropicCompatibility(
          `Responses user content part ${part.type}`,
          'No native Anthropic content block exists for this Responses content type; preserving it as a text JSON block.',
        )
        blocks.push({ type: 'text', text: stringifyUnknownContentPart(part) })
        break
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
      logLossyAnthropicCompatibility(
        `Responses assistant content part ${part.type}`,
        'No native Anthropic assistant block exists for this Responses content type; preserving it as a text JSON block.',
      )
      blocks.push({ type: 'text', text: stringifyUnknownContentPart(part) })
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
  parallelToolCalls: boolean | undefined,
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
  else if (typeof toolChoice === 'object' && 'name' in toolChoice && typeof toolChoice.name === 'string') {
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
    logLossyAnthropicCompatibility(
      'responses text.format=json_object',
      'Anthropic native /v1/messages only accepts json_schema structured output, so json_object must use an OpenAI-compatible backend.',
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

  return {
    type: 'json_schema',
    schema,
    ...(typeof name === 'string' && name.trim().length > 0 && { name }),
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
 * The Anthropic→Responses direction (T7) uses `serializeToolResultContent()` which
 * JSON-encodes mixed/image tool_result blocks. This reverse path tries to parse
 * the JSON back to restore the original Anthropic content blocks.
 *
 * Only rehydrates if ALL parsed elements are known Anthropic tool_result content types
 * (text, image). Returns string as-is for unknown structures to avoid sending
 * arbitrary JSON as Anthropic blocks.
 */
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

  try {
    const parsed = JSON.parse(item.output) as unknown
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

function throwUnsupportedInputItem(item: ResponsesInputItem): never {
  const itemType = 'type' in item ? item.type : 'unknown'
  throwInvalidRequestError(
    `Unsupported Responses input item type "${itemType}" for anthropic-messages translation`,
  )
}

// ─── T9: Responses Stream → Anthropic Stream ────────────────────

export function createAnthropicFromResponsesStreamState(options?: { requestedModel?: string }): AnthropicStreamState {
  return {
    messageStartSent: false,
    messageStopSent: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    currentBlockType: null,
    thinkingSignature: null,
    pendingLeadingText: '',
    hasThinkingContent: false,
    hasNonThinkingContent: false,
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

  switch (event.type) {
    case 'response.created': {
      if (!state.messageStartSent) {
        events.push({
          type: 'message_start',
          message: {
            id: event.response.id,
            type: 'message',
            role: 'assistant',
            content: [],
            model: state.requestedModel ?? event.response.model,
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        })
        state.messageStartSent = true
      }
      break
    }

    case 'response.output_text.delta': {
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
      if (state.contentBlockOpen) {
        closeOpenAnthropicBlock(events, state)
      }
      break
    }

    case 'response.completed':
    case 'response.incomplete': {
      if (event.response.status === 'failed') {
        closeOpenAnthropicBlock(events, state)
        events.push({
          type: 'error',
          error: createAnthropicErrorPayloadFromResponses(event.response).error,
        })
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
          usage: {
            output_tokens: event.response.usage?.output_tokens ?? 0,
          },
        },
        { type: 'message_stop' },
      )
      state.messageStopSent = true
      break
    }

    case 'response.failed': {
      closeOpenAnthropicBlock(events, state)
      events.push({
        type: 'error',
        error: createAnthropicErrorPayloadFromResponses(event.response).error,
      })
      break
    }

    case 'error': {
      closeOpenAnthropicBlock(events, state)
      events.push({
        type: 'error',
        error: createAnthropicErrorPayloadFromResponses(event.error).error,
      })
      break
    }

    case 'response.in_progress':
    case 'response.content_part.added':
    case 'response.content_part.done':
      break
  }

  return events
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
