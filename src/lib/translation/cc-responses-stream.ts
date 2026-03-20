/**
 * CC ↔ Responses streaming translation
 *
 * T3: Responses stream events → CC stream chunks
 * T6: CC stream chunks → Responses stream events
 */

import type { AnthropicStreamEventData, AnthropicStreamState } from './types'
import type { ChatCompletionChunk } from '~/services/copilot/create-chat-completions'
import type {
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesResponseError,
  ResponsesStreamEvent,
} from '~/services/copilot/create-responses'

import { randomUUID } from 'node:crypto'
import { JSONResponseError } from '~/lib/error'
import {
  createAnthropicErrorPayloadFromResponses,
  createOpenAIErrorPayloadFromResponses,
  getResponsesErrorMessage,
  mapCCFinishReasonToResponsesStatus,
  mapResponsesStatusToAnthropicStopReason,
  mapResponsesStatusToCCFinishReason,
} from './utils'

// ─── T3: Responses Stream → CC Stream ───────────────────────────

export interface ResponsesToCCStreamState {
  responseId: string
  model: string
  /** Tracks function_call items by output_index for tool_calls mapping */
  functionCalls: Map<number, { id: string, call_id: string, name: string, ccIndex: number }>
  nextCCToolIndex: number
  createdSent: boolean
}

export function createResponsesToCCStreamState(): ResponsesToCCStreamState {
  return {
    responseId: '',
    model: '',
    functionCalls: new Map(),
    nextCCToolIndex: 0,
    createdSent: false,
  }
}

/**
 * Translate a single Responses stream event into zero or more CC chunks.
 */
export function translateResponsesStreamEventToCC(
  event: ResponsesStreamEvent,
  state: ResponsesToCCStreamState,
): Array<ChatCompletionChunk> {
  const chunks: Array<ChatCompletionChunk> = []

  switch (event.type) {
    case 'response.created': {
      state.responseId = event.response.id
      state.model = event.response.model
      if (!state.createdSent) {
        chunks.push(createCCChunk(state, { role: 'assistant' }))
        state.createdSent = true
      }
      break
    }

    case 'response.output_text.delta': {
      chunks.push(createCCChunk(state, { content: event.delta }))
      break
    }

    case 'response.output_item.added': {
      if (event.item.type === 'function_call' && event.item.call_id && event.item.name) {
        const ccIndex = state.nextCCToolIndex++
        state.functionCalls.set(event.output_index, {
          id: event.item.call_id,
          call_id: event.item.call_id,
          name: event.item.name,
          ccIndex,
        })

        chunks.push(createCCChunk(state, {
          tool_calls: [{
            index: ccIndex,
            id: event.item.call_id,
            type: 'function' as const,
            function: { name: event.item.name, arguments: '' },
          }],
        }))
      }
      break
    }

    case 'response.function_call_arguments.delta': {
      const fc = state.functionCalls.get(event.output_index)
      if (fc) {
        chunks.push(createCCChunk(state, {
          tool_calls: [{
            index: fc.ccIndex,
            function: { arguments: event.delta },
          }],
        }))
      }
      break
    }

    case 'response.completed': {
      if (event.response.status === 'failed') {
        throw createResponsesStreamCCError(event.response)
      }

      chunks.push({
        id: state.responseId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: mapResponsesStatusToCCFinishReason(
            event.response.status,
            event.response.output,
            event.response.incomplete_details,
          ),
          logprobs: null,
        }],
        usage: event.response.usage
          ? {
              prompt_tokens: event.response.usage.input_tokens,
              completion_tokens: event.response.usage.output_tokens,
              total_tokens: event.response.usage.total_tokens,
            }
          : undefined,
      })
      break
    }

    case 'response.failed':
      throw createResponsesStreamCCError(event.response)

    case 'error':
      throw createResponsesStreamCCError(event.error)

    case 'response.in_progress':
    case 'response.content_part.added':
    case 'response.content_part.done':
    case 'response.output_item.done':
      break
  }

  return chunks
}

function createCCChunk(
  state: ResponsesToCCStreamState,
  delta: ChatCompletionChunk['choices'][0]['delta'],
): ChatCompletionChunk {
  return {
    id: state.responseId,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: state.model,
    choices: [{
      index: 0,
      delta,
      finish_reason: null,
      logprobs: null,
    }],
  }
}

function createResponsesStreamCCError(
  responseOrError: ResponsesResponse | ResponsesResponseError,
): JSONResponseError {
  return new JSONResponseError(
    getResponsesErrorMessage(responseOrError),
    502,
    createOpenAIErrorPayloadFromResponses(responseOrError),
  )
}

// ─── T6: CC Stream → Responses Stream ───────────────────────────

interface CCToResponsesToolCallState {
  outputIndex: number
  itemId: string
  callId: string
  name: string
  arguments: string
}

export interface CCToResponsesStreamState {
  responseId: string
  model: string
  createdSent: boolean
  messageOutputIndex: number | undefined
  messageItemDone: boolean
  messageText: string
  nextOutputIndex: number
  /** Tracks CC tool_call index → tool state */
  toolCalls: Map<number, CCToResponsesToolCallState>
}

export function createCCToResponsesStreamState(): CCToResponsesStreamState {
  return {
    responseId: `resp_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    model: '',
    createdSent: false,
    messageOutputIndex: undefined,
    messageItemDone: false,
    messageText: '',
    nextOutputIndex: 0,
    toolCalls: new Map(),
  }
}

/**
 * Translate a single CC stream chunk into zero or more Responses stream events.
 */
export function translateCCStreamChunkToResponses(
  chunk: ChatCompletionChunk,
  state: CCToResponsesStreamState,
): Array<ResponsesStreamEvent> {
  const events: Array<ResponsesStreamEvent> = []
  const choice = chunk.choices[0]
  if (!choice)
    return events

  if (!state.model && chunk.model)
    state.model = chunk.model

  if (!state.createdSent) {
    state.responseId = chunk.id || state.responseId
    const partial = buildPartialResponse(state, 'in_progress')
    events.push({
      type: 'response.created',
      response: partial,
    })
    events.push({
      type: 'response.in_progress',
      response: partial,
    })
    state.createdSent = true
  }

  const { delta } = choice

  if (delta.content) {
    ensureMessageItemOpen(events, state)
    state.messageText += delta.content
    events.push({
      type: 'response.output_text.delta',
      output_index: state.messageOutputIndex!,
      content_index: 0,
      delta: delta.content,
    })
  }

  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      if (tc.id && tc.function?.name && !state.toolCalls.has(tc.index)) {
        closeMessageItemIfNeeded(events, state)

        const toolState: CCToResponsesToolCallState = {
          outputIndex: state.nextOutputIndex++,
          itemId: `fc_${tc.id}`,
          callId: tc.id,
          name: tc.function.name,
          arguments: '',
        }
        state.toolCalls.set(tc.index, toolState)

        events.push({
          type: 'response.output_item.added',
          output_index: toolState.outputIndex,
          item: {
            type: 'function_call',
            id: toolState.itemId,
            call_id: toolState.callId,
            name: toolState.name,
            arguments: toolState.arguments,
            status: 'in_progress',
          },
        })
      }

      if (tc.function?.arguments) {
        const toolState = state.toolCalls.get(tc.index)
        if (toolState) {
          toolState.arguments += tc.function.arguments
          events.push({
            type: 'response.function_call_arguments.delta',
            output_index: toolState.outputIndex,
            item_id: toolState.itemId,
            delta: tc.function.arguments,
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    closeMessageItemIfNeeded(events, state)

    for (const toolState of getSortedToolStates(state)) {
      events.push({
        type: 'response.output_item.done',
        output_index: toolState.outputIndex,
        item: buildFunctionCallOutputItem(toolState, 'completed'),
      })
    }

    const { status, incomplete_details } = mapCCFinishReasonToResponsesStatus(choice.finish_reason)
    events.push({
      type: 'response.completed',
      response: {
        ...buildPartialResponse(state, status),
        ...(incomplete_details && { incomplete_details }),
        usage: chunk.usage
          ? {
              input_tokens: chunk.usage.prompt_tokens,
              output_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            }
          : undefined,
      },
    })
  }

  return events
}

function ensureMessageItemOpen(
  events: Array<ResponsesStreamEvent>,
  state: CCToResponsesStreamState,
): void {
  if (state.messageOutputIndex !== undefined) {
    return
  }

  state.messageOutputIndex = state.nextOutputIndex++
  events.push({
    type: 'response.output_item.added',
    output_index: state.messageOutputIndex,
    item: {
      type: 'message',
      id: `msg_${state.responseId}`,
      role: 'assistant',
      status: 'in_progress',
      content: [],
    },
  })
  events.push({
    type: 'response.content_part.added',
    output_index: state.messageOutputIndex,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  })
}

function closeMessageItemIfNeeded(
  events: Array<ResponsesStreamEvent>,
  state: CCToResponsesStreamState,
): void {
  if (state.messageOutputIndex === undefined || state.messageItemDone) {
    return
  }

  events.push({
    type: 'response.content_part.done',
    output_index: state.messageOutputIndex,
    content_index: 0,
    part: { type: 'output_text', text: state.messageText },
  })
  events.push({
    type: 'response.output_item.done',
    output_index: state.messageOutputIndex,
    item: buildMessageOutputItem(state, 'completed'),
  })
  state.messageItemDone = true
}

function buildMessageOutputItem(
  state: CCToResponsesStreamState,
  status: 'completed' | 'in_progress',
): ResponsesOutputItem {
  return {
    type: 'message',
    id: `msg_${state.responseId}`,
    role: 'assistant',
    status,
    content: state.messageText.length > 0
      ? [{ type: 'output_text', text: state.messageText }]
      : [],
  }
}

function buildFunctionCallOutputItem(
  toolState: CCToResponsesToolCallState,
  status: 'completed' | 'in_progress',
): ResponsesOutputItem {
  return {
    type: 'function_call',
    id: toolState.itemId,
    call_id: toolState.callId,
    name: toolState.name,
    arguments: toolState.arguments,
    status,
  }
}

function getSortedToolStates(state: CCToResponsesStreamState): Array<CCToResponsesToolCallState> {
  return [...state.toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)
}

function buildPartialResponse(
  state: CCToResponsesStreamState,
  status: ResponsesResponse['status'],
): ResponsesResponse {
  const output: Array<ResponsesOutputItem> = []

  if (state.messageOutputIndex !== undefined) {
    output.push(buildMessageOutputItem(state, status === 'in_progress' && !state.messageItemDone ? 'in_progress' : 'completed'))
  }

  for (const toolState of getSortedToolStates(state)) {
    output.push(buildFunctionCallOutputItem(toolState, status === 'in_progress' ? 'in_progress' : 'completed'))
  }

  return {
    id: state.responseId,
    object: 'response',
    model: state.model,
    output,
    status,
  }
}

// ─── T9: Responses Stream → Anthropic Stream ────────────────────

export function createAnthropicFromResponsesStreamState(): AnthropicStreamState {
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
            model: event.response.model,
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

    case 'response.completed': {
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
