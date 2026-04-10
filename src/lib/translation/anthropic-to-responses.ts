/**
 * Anthropic → Responses API translation
 *
 * T7:  Anthropic request → Responses request
 * T11: Anthropic response → Responses response
 * T12: Anthropic stream event → Responses stream events
 */

import type {
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicResponse,
  AnthropicStreamEventData,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
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
import { getModelConfig } from '~/lib/model-config'
import { logIgnoredAnthropicParameter, logLossyAnthropicCompatibility, mapAnthropicCacheControl, throwAnthropicInvalidRequestError } from './anthropic-compat'
import { mapAnthropicOutputFormatToResponses } from './anthropic-output-format'
import { mapAnthropicReasoningToResponses, resolveAnthropicReasoningEffort } from './anthropic-reasoning'

const streamCreatedAtByState = new WeakMap<AnthropicToResponsesStreamState, number>()

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
    ...(instructions && { instructions }),
    input,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_output_tokens: clampMaxOutputTokens(payload.max_tokens),
    ...(tools && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(reasoning && { reasoning }),
    ...(text && { text }),
    ...(parallelToolCalls !== undefined && { parallel_tool_calls: parallelToolCalls }),
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
    else {
      handleAssistantMessage(msg, input)
    }
  }

  return input
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

  const toolResults = msg.content.filter(
    (b): b is AnthropicToolResultBlock => b.type === 'tool_result',
  )
  const otherBlocks = msg.content.filter(b => b.type !== 'tool_result')

  for (const tr of toolResults) {
    input.push({
      type: 'function_call_output',
      call_id: tr.tool_use_id,
      output: serializeToolResultContent(tr.content),
    } as ResponsesFunctionCallOutputItem)
  }

  if (otherBlocks.length > 0) {
    const content = otherBlocks.map(translateUserBlockToResponsesContent)
    input.push({
      role: 'user',
      content,
    } as ResponsesMessageInputItem)
  }
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

  const toolUseBlocks = msg.content.filter(
    (b): b is AnthropicToolUseBlock => b.type === 'tool_use',
  )
  const textBlocks = msg.content.filter(
    (b): b is AnthropicTextBlock =>
      b.type === 'text',
  )
  const thinkingBlocks = msg.content.filter(block => block.type === 'thinking' || block.type === 'redacted_thinking')

  if (thinkingBlocks.length > 0) {
    logLossyAnthropicCompatibility(
      'assistant thinking replay',
      'Responses cannot replay Anthropic thinking/redacted_thinking blocks, so only visible assistant text/tool_use content is forwarded.',
    )
  }

  if (textBlocks.length > 0) {
    const textContent = textBlocks
      .map(b => b.text)
      .join('\n\n')

    if (textContent) {
      input.push({
        role: 'assistant',
        content: [{ type: 'output_text', text: textContent }],
      } as ResponsesMessageInputItem)
    }
  }

  for (const tu of toolUseBlocks) {
    input.push({
      type: 'function_call',
      id: `fc_${tu.id}`,
      call_id: tu.id,
      name: tu.name,
      arguments: JSON.stringify(tu.input),
      status: 'completed',
    } as ResponsesFunctionCallItem)
  }
}

function translateAnthropicToolsToResponses(
  tools: Array<AnthropicTool> | undefined,
  enableCacheControl: boolean,
): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0)
    return undefined

  return tools.map((tool, index) => {
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

function clampMaxOutputTokens(maxTokens: number | null | undefined): number | undefined {
  if (maxTokens === null || maxTokens === undefined)
    return undefined
  return Math.max(maxTokens, 16)
}

function serializeToolResultContent(
  content: AnthropicToolResultBlock['content'],
): string {
  if (typeof content === 'string') {
    return content
  }

  if (content.every(block => block.type === 'text')) {
    return content.map(block => block.text).join('\n\n')
  }

  // Responses function_call_output currently accepts a string payload, not rich
  // content parts, so preserve mixed/image tool results losslessly as JSON.
  return JSON.stringify(content)
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
  let currentMessageParts: Array<{ type: 'output_text', text: string }> = []

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
        currentMessageParts.push({ type: 'output_text', text: block.text })
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
    ...buildResponsesEnvelopeDefaults(output),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      ...(response.usage.cache_read_input_tokens
        ? { input_tokens_details: { cached_tokens: response.usage.cache_read_input_tokens } }
        : undefined),
    },
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

function buildResponsesEnvelopeDefaults(
  output: Array<ResponsesOutputItem>,
): Pick<
  ResponsesResponse,
  'instructions' | 'max_output_tokens' | 'previous_response_id' | 'text' | 'reasoning' | 'metadata'
> {
  const reasoningSummary = output
    .filter((item): item is ResponsesOutputItem & { type: 'reasoning', summary: Array<{ type: 'summary_text', text: string }> } =>
      item.type === 'reasoning' && Array.isArray(item.summary) && item.summary.length > 0)
    .flatMap(item => item.summary)

  return {
    // Anthropic responses do not provide equivalent request-echo fields.
    // Keep a stable Responses envelope with explicit null/default values.
    instructions: null,
    max_output_tokens: null,
    previous_response_id: null,
    text: { format: { type: 'text' } },
    reasoning: {
      effort: null,
      summary: reasoningSummary.length > 0 ? reasoningSummary : null,
    },
    metadata: {},
  }
}

// ─── T12: Anthropic Stream → Responses Stream ──────────────────

export function createAnthropicToResponsesStreamState(): AnthropicToResponsesStreamState {
  const state: AnthropicToResponsesStreamState = {
    responseId: `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    model: '',
    createdSent: false,
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
    stopReason: undefined,
    inputTokens: 0,
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
  const events: Array<ResponsesStreamEvent> = []

  switch (event.type) {
    case 'message_start': {
      state.responseId = event.message.id || state.responseId
      state.model = event.message.model || state.model
      state.inputTokens = event.message.usage?.input_tokens ?? 0
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
        state.currentPartText = ''
        openMessageIfNeeded(events, state)
        const messageItemId = getCurrentMessageItemId(state)
        events.push({
          type: 'response.content_part.added',
          item_id: messageItemId,
          output_index: state.messageOutputIndex!,
          content_index: state.contentPartIndex,
          part: { type: 'output_text', text: '' },
        })
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
        const messageItemId = getCurrentMessageItemId(state)
        events.push({
          type: 'response.output_text.delta',
          item_id: messageItemId,
          output_index: state.messageOutputIndex!,
          content_index: state.contentPartIndex,
          delta: event.delta.text,
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
      // signature_delta — skip
      break
    }

    case 'content_block_stop': {
      if (state.currentBlockType === 'text') {
        const messageItemId = getCurrentMessageItemId(state)
        state.messageParts.push({ type: 'output_text', text: state.currentPartText })
        events.push({
          type: 'response.output_text.done',
          item_id: messageItemId,
          output_index: state.messageOutputIndex!,
          content_index: state.contentPartIndex,
          text: state.currentPartText,
        })
        events.push({
          type: 'response.content_part.done',
          item_id: messageItemId,
          output_index: state.messageOutputIndex!,
          content_index: state.contentPartIndex,
          part: { type: 'output_text', text: state.currentPartText },
        })
        state.contentPartIndex++
        // Don't close message — more text blocks may follow
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
            item: functionCallItem,
          })
          events.push({
            type: 'response.output_item.done',
            output_index: tc.outputIndex,
            item: functionCallItem,
          })
          // Preserve in completedOutputItems for buildAnthropicPartialResponse
          state.completedOutputItems.push(functionCallItem)
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
          usage: {
            input_tokens: state.inputTokens,
            output_tokens: state.outputTokens,
            total_tokens: state.inputTokens + state.outputTokens,
          },
        },
      })
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
          error: {
            message: event.error.message,
            type: event.error.type,
            code: event.error.type,
          },
        })
      }
      break
    }

    case 'ping':
      break
  }

  return events
}

function openMessageIfNeeded(
  events: Array<ResponsesStreamEvent>,
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

function closeMessageIfOpen(
  events: Array<ResponsesStreamEvent>,
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
      currentParts.push({ type: 'output_text', text: state.currentPartText })
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
    ...buildResponsesEnvelopeDefaults(output),
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
