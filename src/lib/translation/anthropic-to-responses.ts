/**
 * Anthropic → Responses API translation
 *
 * T7:  Anthropic request → Responses request
 * T11: Anthropic response → Responses response
 * T12: Anthropic stream event → Responses stream events
 */

import type {
  AnthropicAssistantMessage,
  AnthropicCustomTool,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicSystemMessage,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToResponsesStreamState,
  AnthropicUserContentBlock,
  AnthropicUserMessage,
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
  ResponsesToolChoice,
} from '~/services/copilot/create-responses'
import { randomUUID } from 'node:crypto'
import { isTranslatableAnthropicCustomTool } from '~/lib/anthropic-tools'
import { getModelConfig } from '~/lib/model-config'
import { logIgnoredAnthropicParameter, logLossyAnthropicCompatibility, mapAnthropicCacheControl, throwAnthropicInvalidRequestError } from './anthropic-compat'
import { mapAnthropicOutputFormatToResponses } from './anthropic-output-format'
import { mapAnthropicReasoningToResponses, resolveAnthropicReasoningEffort } from './anthropic-reasoning'

const streamCreatedAtByState = new WeakMap<AnthropicToResponsesStreamState, number>()

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, Extract<keyof T, K>> : never
type UnsequencedResponsesStreamEvent
  = | DistributiveOmit<Exclude<ResponsesStreamEvent, { type: 'error' }>, 'sequence_number'>
    | {
      type: 'error'
      code: string | null
      message: string
      param: string | null
    }

function nowUnixSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

export interface TranslateAnthropicToResponsesOptions {
  model?: string
}

export function translateAnthropicRequestToResponses(
  payload: AnthropicMessagesPayload,
  options?: TranslateAnthropicToResponsesOptions,
): ResponsesPayload {
  const model = options?.model ?? payload.model
  const modelConfig = getModelConfig(model)

  if (payload.top_k !== undefined) {
    logIgnoredAnthropicParameter(
      'top_k',
      'Responses does not expose an OpenAI-compatible top_k field.',
    )
  }

  if (payload.cache_control) {
    logIgnoredAnthropicParameter(
      'cache_control',
      'Top-level cache_control is not representable in Responses format.',
    )
  }

  if (payload.stop_sequences !== undefined) {
    logIgnoredAnthropicParameter(
      'stop_sequences',
      'Responses translation has no compatible stop_sequences field; request is forwarded without local rejection.',
    )
  }

  if (payload.service_tier !== undefined) {
    logIgnoredAnthropicParameter(
      'service_tier',
      'Copilot /responses currently rejects service_tier, so Anthropic service_tier is not forwarded on translated requests.',
    )
  }

  if (payload.speed !== undefined) {
    logIgnoredAnthropicParameter(
      'speed',
      'Anthropic speed has no Responses equivalent, so translated requests omit it.',
    )
  }

  logIgnoredMessageBlockCacheControl(payload, modelConfig.enableCacheControl === true)

  const instructions = translateSystemToInstructions(payload.system)
  const input = translateAnthropicMessagesToResponsesInput(payload.messages)
  const tools = translateAnthropicToolsToResponses(
    payload.tools,
    modelConfig.enableCacheControl === true,
  )
  const toolChoice = modelConfig.supportsToolChoice
    ? translateAnthropicToolChoiceToResponses(payload.tool_choice)
    : undefined
  const reasoning = mapAnthropicReasoningToResponses(
    resolveAnthropicReasoningEffort(payload, modelConfig),
    modelConfig,
  )
  const text = mapAnthropicOutputFormatToResponses(payload.output_config)
  const parallelToolCalls = payload.tool_choice?.disable_parallel_tool_use === true
    && modelConfig.supportsParallelToolCalls
    ? false
    : undefined

  return {
    model,
    store: false,
    ...(instructions && { instructions }),
    input,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_output_tokens: validateMaxOutputTokens(payload.max_tokens),
    ...(tools && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(reasoning && { reasoning }),
    ...(text && { text }),
    ...(parallelToolCalls !== undefined && { parallel_tool_calls: parallelToolCalls }),
    ...(payload.metadata && { metadata: payload.metadata }),
  }
}

function translateSystemToInstructions(
  system: string | Array<AnthropicTextBlock> | undefined,
): string | undefined {
  if (!system)
    return undefined

  if (typeof system === 'string')
    return system

  const cacheControlBlocks = system
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.cache_control)
  if (cacheControlBlocks.length > 0) {
    logLossyAnthropicCompatibility(
      'system cache_control',
      'Anthropic system block cache hints are collapsed into Responses instructions and cannot be forwarded precisely.',
    )
  }

  const text = system.map(block => block.text).join('\n\n')
  return text || undefined
}

function translateAnthropicMessagesToResponsesInput(
  messages: Array<AnthropicMessage>,
): Array<ResponsesInputItem> {
  const input: Array<ResponsesInputItem> = []

  for (const msg of messages) {
    if (msg.role === 'user') {
      handleUserMessage(msg, input)
    }
    else if (msg.role === 'assistant') {
      handleAssistantMessage(msg, input)
    }
    else {
      handleSystemMessage(msg, input)
    }
  }

  return input
}

function handleSystemMessage(
  msg: AnthropicSystemMessage,
  input: Array<ResponsesInputItem>,
): void {
  if (typeof msg.content === 'string') {
    input.push({
      role: 'developer',
      content: msg.content,
    } as ResponsesMessageInputItem)
    return
  }

  const cacheControlBlocks = msg.content
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.cache_control)
  if (cacheControlBlocks.length > 0) {
    logLossyAnthropicCompatibility(
      'mid-conversation system cache_control',
      'Anthropic mid-conversation system block cache hints are collapsed into a Responses developer message and cannot be forwarded precisely.',
    )
  }

  const text = msg.content.map(block => block.text).join('\n\n')
  if (!text) {
    return
  }

  input.push({
    role: 'developer',
    content: text,
  } as ResponsesMessageInputItem)
}

function handleUserMessage(
  msg: AnthropicUserMessage,
  input: Array<ResponsesInputItem>,
): void {
  if (typeof msg.content === 'string') {
    input.push({
      role: 'user',
      content: msg.content,
    } as ResponsesMessageInputItem)
    return
  }

  let pendingUserBlocks: Array<Exclude<AnthropicUserContentBlock, AnthropicToolResultBlock>> = []
  const flushUserBlocks = () => {
    if (pendingUserBlocks.length === 0) {
      return
    }

    const content = pendingUserBlocks.map(translateUserBlockToResponsesContent)
    pendingUserBlocks = []
    input.push({
      role: 'user',
      content,
    } as ResponsesMessageInputItem)
  }

  for (const block of msg.content) {
    if (block.type !== 'tool_result') {
      pendingUserBlocks.push(block)
      continue
    }

    flushUserBlocks()
    input.push({
      type: 'function_call_output',
      call_id: block.tool_use_id,
      output: serializeToolResultContent(block.content, block.is_error === true),
      ...(block.is_error === true && { status: 'incomplete' }),
    } as ResponsesFunctionCallOutputItem)
  }

  flushUserBlocks()
}

function handleAssistantMessage(
  msg: AnthropicAssistantMessage,
  input: Array<ResponsesInputItem>,
): void {
  if (typeof msg.content === 'string') {
    input.push({
      role: 'assistant',
      content: [{ type: 'output_text', text: msg.content }],
    } as ResponsesMessageInputItem)
    return
  }

  const thinkingBlocks = msg.content.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking')

  if (thinkingBlocks.length > 0) {
    logLossyAnthropicCompatibility(
      'assistant thinking replay',
      'Responses cannot replay Anthropic thinking/redacted_thinking blocks, so only visible assistant text/tool_use content is forwarded.',
    )
  }

  let pendingText: string[] = []
  const flushText = () => {
    if (pendingText.length > 0) {
      const textContent = pendingText.join('\n\n')
      pendingText = []
      if (!textContent) {
        return
      }
      input.push({
        role: 'assistant',
        content: [{ type: 'output_text', text: textContent }],
      } as ResponsesMessageInputItem)
    }
  }

  for (const block of msg.content) {
    if (block.type === 'text') {
      pendingText.push(block.text)
      continue
    }

    if (block.type === 'tool_use') {
      flushText()
      input.push({
        type: 'function_call',
        id: `fc_${block.id}`,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
        status: 'completed',
      } as ResponsesFunctionCallItem)
    }
  }

  flushText()
}

function translateAnthropicToolsToResponses(
  tools: Array<AnthropicTool> | undefined,
  enableCacheControl: boolean,
): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0)
    return undefined

  const compatibleTools = tools.filter((tool, index): tool is AnthropicCustomTool & { type?: 'custom' } => {
    if (!isTranslatableAnthropicCustomTool(tool)) {
      logIgnoredAnthropicParameter(
        `tools[${index}]`,
        'Anthropic server-side tools cannot be represented on the Copilot Responses wire format and are omitted.',
      )
      return false
    }

    return true
  })

  if (compatibleTools.length === 0)
    return undefined

  return compatibleTools.map((tool, index) => {
    if ('cache_control' in tool && tool.cache_control && !enableCacheControl) {
      logIgnoredAnthropicParameter(
        `tools[${index}].cache_control`,
        'Current Copilot cache hints are only enabled on Claude-routed models.',
      )
    }

    return {
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
      ...(typeof tool.strict === 'boolean' && { strict: tool.strict }),
      ...(enableCacheControl
        && 'cache_control' in tool
        && tool.cache_control && {
        copilot_cache_control: mapAnthropicCacheControl(
          tool.cache_control,
          `tools[${index}]`,
        ),
      }),
    }
  })
}

function translateAnthropicToolChoiceToResponses(
  toolChoice: AnthropicMessagesPayload['tool_choice'],
): ResponsesToolChoice | undefined {
  if (!toolChoice)
    return undefined

  switch (toolChoice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      if (toolChoice.name)
        return { type: 'function', name: toolChoice.name }
      return undefined
    default:
      return undefined
  }
}

function validateMaxOutputTokens(maxTokens: number | null | undefined): number | undefined {
  if (maxTokens === null || maxTokens === undefined)
    return undefined
  if (maxTokens < 16) {
    throwAnthropicInvalidRequestError(
      'Anthropic max_tokens must be at least 16 when translating the request to the Responses API; the proxy will not silently increase the client limit.',
    )
  }
  return maxTokens
}

function serializeToolResultContent(
  content: AnthropicToolResultBlock['content'],
  isError: boolean,
): string {
  const serialize = (value: AnthropicToolResultBlock['content']): string => {
    if (value === undefined) {
      return ''
    }
    if (typeof value === 'string') {
      return value
    }

    if (value.every(block => block.type === 'text')) {
      return value.map(block => block.text).join('\n\n')
    }

    // Responses function_call_output currently accepts a string payload, not rich
    // content parts, so preserve mixed/image tool results losslessly as JSON.
    return JSON.stringify(value)
  }

  const output = serialize(content)
  if (isError) {
    return JSON.stringify({
      is_error: true,
      content: output,
    })
  }

  return output
}

function translateUserBlockToResponsesContent(
  block: Exclude<AnthropicUserContentBlock, AnthropicToolResultBlock>,
) {
  switch (block.type) {
    case 'image':
      return block.source.type === 'base64'
        ? {
            type: 'input_image' as const,
            source: block.source,
          }
        : {
            type: 'input_image' as const,
            image_url: block.source.url,
          }
    case 'text':
      return { type: 'input_text' as const, text: block.text }
    case 'document':
      throwAnthropicInvalidRequestError(
        'Unexpanded document block reached Responses translation layer (safety net). This is a bug — document blocks should have been expanded to text blocks before this point.',
      )
  }
}

function logIgnoredMessageBlockCacheControl(
  payload: AnthropicMessagesPayload,
  enableCacheControl: boolean,
): void {
  for (const [messageIndex, message] of payload.messages.entries()) {
    if (!Array.isArray(message.content)) {
      continue
    }

    const hasBlockCacheControl = message.content.some((block) => {
      if ('cache_control' in block && block.cache_control) {
        return true
      }

      return block.type === 'tool_result'
        && Array.isArray(block.content)
        && block.content.some(contentBlock => 'cache_control' in contentBlock && contentBlock.cache_control)
    })

    if (hasBlockCacheControl) {
      logIgnoredAnthropicParameter(
        `messages[${messageIndex}].content[].cache_control`,
        enableCacheControl
          ? 'Fine-grained Anthropic message block cache hints cannot be represented on the Copilot Responses wire format.'
          : 'Current Copilot cache hints are only enabled on Claude-routed models.',
      )
      return
    }
  }
}

// ─── T11: Anthropic Response → Responses Response ──────────────

export function translateAnthropicResponseToResponses(
  response: AnthropicResponse,
  options?: { requestedModel?: string },
): ResponsesResponse {
  const createdAt = nowUnixSeconds()
  const output: Array<ResponsesOutputItem> = []
  let currentMessageParts: Array<{ type: 'output_text', text: string, [key: string]: unknown }> = []

  function flushMessageParts(): void {
    if (currentMessageParts.length === 0)
      return
    output.push({
      type: 'message',
      id: `msg_${response.id}_${output.length}`,
      role: 'assistant',
      status: 'completed',
      content: currentMessageParts,
    })
    currentMessageParts = []
  }

  for (const block of response.content) {
    switch (block.type) {
      case 'text': {
        currentMessageParts.push({
          type: 'output_text',
          text: block.text,
          annotations: [],
          ...(block.citations && { citations: block.citations }),
        })
        break
      }

      case 'thinking': {
        flushMessageParts()
        output.push({
          type: 'reasoning',
          id: `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          summary: [{ type: 'summary_text', text: block.thinking }],
        })
        break
      }

      case 'redacted_thinking': {
        flushMessageParts()
        logLossyAnthropicCompatibility(
          'redacted_thinking',
          'Anthropic redacted_thinking blocks have no Responses equivalent and are dropped.',
        )
        break
      }

      case 'tool_use': {
        flushMessageParts()
        output.push({
          type: 'function_call',
          id: `fc_${block.id}`,
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
          status: 'completed',
        })
        break
      }
    }
  }

  flushMessageParts()

  const { status, incomplete_details } = mapAnthropicStopReasonToResponsesStatus(response.stop_reason)

  const usage = buildResponsesUsage(response.usage)

  return {
    id: response.id,
    object: 'response',
    created_at: createdAt,
    completed_at: status === 'completed' ? createdAt : null,
    model: options?.requestedModel ?? response.model,
    output,
    status,
    error: null,
    incomplete_details: incomplete_details ?? null,
    ...buildResponsesEnvelopeDefaults(),
    usage,
  }
}

function buildResponsesUsage(
  usage: AnthropicResponse['usage'],
): NonNullable<ResponsesResponse['usage']> {
  // Anthropic reports uncached, cache-write, and cache-read input tokens as
  // disjoint buckets. Responses input_tokens is the total input, with cache
  // hits represented as a subset in input_tokens_details.cached_tokens.
  const inputTokens = usage.input_tokens
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0)

  return {
    input_tokens: inputTokens,
    output_tokens: usage.output_tokens,
    total_tokens: inputTokens + usage.output_tokens,
    ...((usage.cache_read_input_tokens ?? 0) > 0
      ? { input_tokens_details: { cached_tokens: usage.cache_read_input_tokens! } }
      : undefined),
  }
}

function mapAnthropicStopReasonToResponsesStatus(
  stopReason: AnthropicResponse['stop_reason'],
): {
  status: ResponsesResponse['status']
  incomplete_details?: { reason: string }
} {
  switch (stopReason) {
    case 'end_turn':
    case 'tool_use':
    case 'stop_sequence':
      return { status: 'completed' }
    case 'max_tokens':
      return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
    case 'pause_turn':
      logLossyAnthropicCompatibility(
        'pause_turn',
        'Anthropic pause_turn has no exact Responses equivalent. It is exposed as an incomplete response without a synthetic token-limit reason.',
      )
      return { status: 'incomplete' }
    case 'refusal':
      return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }
    case null:
    default:
      return { status: 'completed' }
  }
}

function buildResponsesEnvelopeDefaults(): Pick<
  ResponsesResponse,
  | 'instructions'
  | 'max_output_tokens'
  | 'previous_response_id'
  | 'store'
  | 'text'
  | 'reasoning'
  | 'metadata'
  | 'temperature'
  | 'top_p'
  | 'parallel_tool_calls'
  | 'tool_choice'
  | 'tools'
> {
  return {
    // Anthropic responses do not provide equivalent request-echo fields.
    // Keep a stable Responses envelope with explicit null/default values.
    instructions: null,
    max_output_tokens: null,
    previous_response_id: null,
    store: false,
    text: { format: { type: 'text' } },
    reasoning: {
      effort: null,
      summary: null,
    },
    metadata: {},
    temperature: 1,
    top_p: 1,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  }
}

// ─── T12: Anthropic Stream → Responses Stream ──────────────────

export function createAnthropicToResponsesStreamState(options?: { requestedModel?: string }): AnthropicToResponsesStreamState {
  const state: AnthropicToResponsesStreamState = {
    responseId: `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    model: '',
    requestedModel: options?.requestedModel,
    createdSent: false,
    messageStopSent: false,
    nextSequenceNumber: 0,
    nextOutputIndex: 0,
    currentBlockType: null,
    currentBlockIndex: -1,
    messageOutputIndex: undefined,
    messageItemOpen: false,
    messageParts: [],
    currentPartText: '',
    contentPartIndex: 0,
    toolCalls: new Map(),
    currentThinkingText: '',
    completedOutputItems: [],
    hasAssistantOutput: false,
    stopReason: undefined,
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  }
  streamCreatedAtByState.set(state, nowUnixSeconds())
  return state
}

/**
 * Translate a single Anthropic stream event into zero or more Responses stream events.
 */
export function translateAnthropicStreamEventToResponses(
  event: AnthropicStreamEventData,
  state: AnthropicToResponsesStreamState,
): Array<ResponsesStreamEvent> {
  const events: Array<UnsequencedResponsesStreamEvent> = []

  // `messageStopSent` represents any terminal client event, including a
  // response.failed/error. Ignore late upstream events after a terminal so an
  // Anthropic error can never be followed by response.completed.
  if (state.messageStopSent) {
    return []
  }

  switch (event.type) {
    case 'message_start': {
      state.responseId = event.message.id || state.responseId
      state.model = state.requestedModel ?? event.message.model ?? state.model
      state.inputTokens = event.message.usage?.input_tokens ?? 0
      state.cacheCreationInputTokens = event.message.usage?.cache_creation_input_tokens ?? 0
      state.cacheReadInputTokens = event.message.usage?.cache_read_input_tokens ?? 0
      streamCreatedAtByState.set(state, streamCreatedAtByState.get(state) ?? nowUnixSeconds())

      const partial = buildAnthropicPartialResponse(state, 'in_progress')
      events.push({ type: 'response.created', response: partial })
      events.push({ type: 'response.in_progress', response: partial })
      state.createdSent = true
      break
    }

    case 'content_block_start': {
      state.currentBlockIndex = event.index
      const blockType = event.content_block.type

      if (blockType === 'text') {
        state.currentBlockType = 'text'
        const block = event.content_block as AnthropicTextBlock
        state.currentPartText = block.text
        openMessageIfNeeded(events, state)
        const messageItemId = getCurrentMessageItemId(state)
        events.push({
          type: 'response.content_part.added',
          item_id: messageItemId,
          output_index: state.messageOutputIndex!,
          content_index: state.contentPartIndex,
          part: { type: 'output_text', text: '', annotations: [] },
        })
        if (block.text) {
          state.hasAssistantOutput = true
          events.push({
            type: 'response.output_text.delta',
            item_id: messageItemId,
            output_index: state.messageOutputIndex!,
            content_index: state.contentPartIndex,
            delta: block.text,
            logprobs: [],
          })
        }
      }
      else if (blockType === 'tool_use') {
        state.currentBlockType = 'tool_use'
        closeMessageIfOpen(events, state)

        const block = event.content_block as { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }
        const outputIndex = state.nextOutputIndex++
        state.toolCalls.set(event.index, {
          outputIndex,
          callId: block.id,
          name: block.name,
          arguments: '',
        })

        events.push({
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            type: 'function_call',
            id: `fc_${block.id}`,
            call_id: block.id,
            name: block.name,
            arguments: '',
            status: 'in_progress',
          },
        })
      }
      else if (blockType === 'thinking') {
        state.currentBlockType = 'thinking'
        state.currentThinkingText = ''
        // Close any open message before reasoning output
        closeMessageIfOpen(events, state)
      }
      else {
        // redacted_thinking or unknown
        state.currentBlockType = 'redacted_thinking'
        logLossyAnthropicCompatibility(
          'redacted_thinking (stream)',
          'Anthropic redacted_thinking blocks have no Responses equivalent and are dropped.',
        )
      }
      break
    }

    case 'content_block_delta': {
      if (state.currentBlockType === 'text' && event.delta.type === 'text_delta') {
        state.currentPartText += event.delta.text
        if (event.delta.text) {
          state.hasAssistantOutput = true
        }
        const messageItemId = getCurrentMessageItemId(state)
        events.push({
          type: 'response.output_text.delta',
          item_id: messageItemId,
          output_index: state.messageOutputIndex!,
          content_index: state.contentPartIndex,
          delta: event.delta.text,
          logprobs: [],
        })
      }
      else if (state.currentBlockType === 'tool_use' && event.delta.type === 'input_json_delta') {
        const tc = state.toolCalls.get(state.currentBlockIndex)
        if (tc) {
          tc.arguments += event.delta.partial_json
          events.push({
            type: 'response.function_call_arguments.delta',
            output_index: tc.outputIndex,
            item_id: `fc_${tc.callId}`,
            delta: event.delta.partial_json,
          })
        }
      }
      else if (state.currentBlockType === 'thinking' && event.delta.type === 'thinking_delta') {
        state.currentThinkingText += event.delta.thinking
      }
      else if (state.currentBlockType === 'text' && event.delta.type === 'citations_delta') {
        // Native /v1/messages passthrough forwards citations_delta byte-for-byte.
        // Responses streaming has no citation delta event mapped here today.
      }
      // signature_delta — skip
      break
    }

    case 'content_block_stop': {
      if (state.currentBlockType === 'text') {
        closeCurrentTextBlock(events, state)
      }
      else if (state.currentBlockType === 'tool_use') {
        const tc = state.toolCalls.get(state.currentBlockIndex)
        if (tc) {
          const functionCallItem = {
            type: 'function_call' as const,
            id: `fc_${tc.callId}`,
            call_id: tc.callId,
            name: tc.name,
            arguments: tc.arguments,
            status: 'completed' as const,
          }
          events.push({
            type: 'response.function_call_arguments.done',
            output_index: tc.outputIndex,
            item_id: `fc_${tc.callId}`,
            arguments: tc.arguments,
            name: tc.name,
          })
          events.push({
            type: 'response.output_item.done',
            output_index: tc.outputIndex,
            item: functionCallItem,
          })
          // Preserve in completedOutputItems for buildAnthropicPartialResponse
          state.completedOutputItems.push(functionCallItem)
          state.hasAssistantOutput = true
        }
      }
      // thinking → emit reasoning output item (consistent with non-streaming T11)
      else if (state.currentBlockType === 'thinking' && state.currentThinkingText) {
        const outputIndex = state.nextOutputIndex++
        const reasoningItem = {
          type: 'reasoning' as const,
          id: `rs_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          summary: [{ type: 'summary_text' as const, text: state.currentThinkingText }],
        }
        events.push({
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: reasoningItem,
        })
        events.push({
          type: 'response.output_item.done',
          output_index: outputIndex,
          item: reasoningItem,
        })
        state.completedOutputItems.push(reasoningItem)
        state.currentThinkingText = ''
      }
      // redacted_thinking — nothing to emit

      state.currentBlockType = null
      break
    }

    case 'message_delta': {
      state.stopReason = event.delta.stop_reason ?? state.stopReason
      if (event.usage?.input_tokens !== undefined) {
        state.inputTokens = event.usage.input_tokens
      }
      if (event.usage?.cache_creation_input_tokens !== undefined) {
        state.cacheCreationInputTokens = event.usage.cache_creation_input_tokens
      }
      if (event.usage?.cache_read_input_tokens !== undefined) {
        state.cacheReadInputTokens = event.usage.cache_read_input_tokens
      }
      if (event.usage?.output_tokens !== undefined) {
        state.outputTokens = event.usage.output_tokens
      }
      break
    }

    case 'message_stop': {
      closeMessageIfOpen(events, state)

      const { status, incomplete_details } = mapAnthropicStopReasonToResponsesStatus(
        (state.stopReason as AnthropicResponse['stop_reason']) ?? null,
      )
      const terminalEventType = status === 'completed'
        ? 'response.completed'
        : 'response.incomplete'
      events.push({
        type: terminalEventType,
        response: {
          ...buildAnthropicPartialResponse(state, status),
          completed_at: status === 'completed' ? nowUnixSeconds() : null,
          incomplete_details: incomplete_details ?? null,
          usage: buildResponsesStreamUsage(state),
        },
      })
      state.messageStopSent = true
      break
    }

    case 'error': {
      if (state.createdSent) {
        events.push({
          type: 'response.failed',
          response: {
            ...buildAnthropicPartialResponse(state, 'failed'),
            completed_at: null,
            error: {
              message: event.error.message,
              type: event.error.type,
              code: event.error.type,
            },
          },
        })
      }
      else {
        events.push({
          type: 'error',
          code: event.error.type,
          message: event.error.message,
          param: null,
        })
      }
      state.messageStopSent = true
      break
    }

    case 'ping':
      break
  }

  return addResponsesSequenceNumbers(events, state)
}

export function finalizeAnthropicToResponsesStreamState(
  state: AnthropicToResponsesStreamState,
): Array<ResponsesStreamEvent> {
  const events: Array<UnsequencedResponsesStreamEvent> = []
  if (!state.createdSent || state.messageStopSent) {
    return []
  }

  events.push(buildAnthropicStreamFailureEvent(
    state,
    'Copilot Anthropic upstream stream terminated before the message_stop event.',
  ))
  state.messageStopSent = true
  return addResponsesSequenceNumbers(events, state)
}

function openMessageIfNeeded(
  events: Array<UnsequencedResponsesStreamEvent>,
  state: AnthropicToResponsesStreamState,
): void {
  if (state.messageItemOpen)
    return

  state.messageOutputIndex = state.nextOutputIndex++
  state.messageParts = []
  state.contentPartIndex = 0
  state.messageItemOpen = true

  events.push({
    type: 'response.output_item.added',
    output_index: state.messageOutputIndex,
    item: {
      type: 'message',
      id: `msg_${state.responseId}_${state.messageOutputIndex}`,
      role: 'assistant',
      status: 'in_progress',
      content: [],
    },
  })
}

function closeCurrentTextBlock(
  events: Array<UnsequencedResponsesStreamEvent>,
  state: AnthropicToResponsesStreamState,
): void {
  if (state.currentBlockType !== 'text') {
    return
  }

  const messageItemId = getCurrentMessageItemId(state)
  const text = state.currentPartText
  state.messageParts.push({ type: 'output_text', text, annotations: [] })
  events.push({
    type: 'response.output_text.done',
    item_id: messageItemId,
    output_index: state.messageOutputIndex!,
    content_index: state.contentPartIndex,
    text,
    logprobs: [],
  })
  events.push({
    type: 'response.content_part.done',
    item_id: messageItemId,
    output_index: state.messageOutputIndex!,
    content_index: state.contentPartIndex,
    part: { type: 'output_text', text, annotations: [] },
  })
  state.contentPartIndex++
  state.currentPartText = ''
  state.currentBlockType = null
}

function closeMessageIfOpen(
  events: Array<UnsequencedResponsesStreamEvent>,
  state: AnthropicToResponsesStreamState,
): void {
  if (!state.messageItemOpen)
    return

  const messageItem = {
    type: 'message' as const,
    id: `msg_${state.responseId}_${state.messageOutputIndex!}`,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: state.messageParts.length > 0 ? [...state.messageParts] : [],
  }

  events.push({
    type: 'response.output_item.done',
    output_index: state.messageOutputIndex!,
    item: messageItem,
  })

  // Preserve in completedOutputItems for buildAnthropicPartialResponse
  state.completedOutputItems.push(messageItem)

  state.messageItemOpen = false
  state.messageParts = []
  state.contentPartIndex = 0
}

function buildAnthropicPartialResponse(
  state: AnthropicToResponsesStreamState,
  status: ResponsesResponse['status'],
): ResponsesResponse {
  const createdAt = getOrInitStreamCreatedAt(state)
  // Start with all previously completed output items (messages + function_calls)
  const output: Array<ResponsesOutputItem> = [...state.completedOutputItems] as unknown as Array<ResponsesOutputItem>

  // Add currently-open message (if still in progress), including any in-flight text delta
  if (state.messageItemOpen && state.messageOutputIndex !== undefined) {
    const currentParts = [...state.messageParts]
    // Include the current in-flight text part that hasn't been flushed yet
    if (state.currentPartText) {
      currentParts.push({ type: 'output_text', text: state.currentPartText, annotations: [] })
    }
    output.push({
      type: 'message',
      id: `msg_${state.responseId}_${state.messageOutputIndex}`,
      role: 'assistant',
      status: 'in_progress',
      content: currentParts,
    })
  }

  // Include in-flight tool call arguments from toolCalls that aren't in completedOutputItems yet
  for (const tc of state.toolCalls.values()) {
    const alreadyCompleted = state.completedOutputItems.some(
      (item: Record<string, unknown>) => item.call_id === tc.callId,
    )
    if (!alreadyCompleted) {
      output.push({
        type: 'function_call',
        id: `fc_${tc.callId}`,
        call_id: tc.callId,
        name: tc.name,
        arguments: tc.arguments,
        status: 'in_progress',
      })
    }
  }

  return {
    id: state.responseId,
    object: 'response',
    created_at: createdAt,
    completed_at: status === 'completed' ? nowUnixSeconds() : null,
    model: state.model,
    output,
    status,
    error: null,
    incomplete_details: null,
    ...buildResponsesEnvelopeDefaults(),
  }
}

function buildAnthropicStreamFailureEvent(
  state: AnthropicToResponsesStreamState,
  message: string,
): UnsequencedResponsesStreamEvent {
  return {
    type: 'response.failed',
    response: {
      ...buildAnthropicPartialResponse(state, 'failed'),
      completed_at: null,
      error: {
        message,
        type: 'server_error',
        code: 'upstream_stream_terminated',
      },
      usage: buildResponsesStreamUsage(state),
    },
  }
}

function addResponsesSequenceNumbers(
  events: Array<UnsequencedResponsesStreamEvent>,
  state: AnthropicToResponsesStreamState,
): Array<ResponsesStreamEvent> {
  return events.map(event => ({
    ...event,
    sequence_number: state.nextSequenceNumber++,
  }) as ResponsesStreamEvent)
}

function buildResponsesStreamUsage(state: AnthropicToResponsesStreamState): NonNullable<ResponsesResponse['usage']> {
  const inputTokens = state.inputTokens
    + state.cacheCreationInputTokens
    + state.cacheReadInputTokens

  return {
    input_tokens: inputTokens,
    output_tokens: state.outputTokens,
    total_tokens: inputTokens + state.outputTokens,
    ...(state.cacheReadInputTokens > 0
      ? { input_tokens_details: { cached_tokens: state.cacheReadInputTokens } }
      : undefined),
  }
}

function getCurrentMessageItemId(state: AnthropicToResponsesStreamState): string {
  return `msg_${state.responseId}_${state.messageOutputIndex!}`
}

function getOrInitStreamCreatedAt(state: AnthropicToResponsesStreamState): number {
  const existing = streamCreatedAtByState.get(state)
  if (existing !== undefined) {
    return existing
  }
  const createdAt = nowUnixSeconds()
  streamCreatedAtByState.set(state, createdAt)
  return createdAt
}
