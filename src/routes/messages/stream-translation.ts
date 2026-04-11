import type { AnthropicResponse, AnthropicStreamEventData, AnthropicStreamState } from './anthropic-types'

import type { ChatCompletionChunk } from '~/services/copilot/create-chat-completions'
import { mapOpenAIStopReasonToAnthropic } from './utils'

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

  events.push({
    type: 'content_block_stop',
    index: state.contentBlockIndex,
  })
  state.contentBlockIndex++
  state.contentBlockOpen = false
  state.currentBlockType = null
  state.thinkingSignature = null
}

function isBeforeFirstContentBlock(state: AnthropicStreamState): boolean {
  return state.contentBlockIndex === 0 && !state.contentBlockOpen
}

function flushPendingLeadingText(
  events: Array<AnthropicStreamEventData>,
  state: AnthropicStreamState,
): void {
  if (!state.pendingLeadingText) {
    return
  }

  ensureTextBlockOpen(events, state)
  events.push({
    type: 'content_block_delta',
    index: state.contentBlockIndex,
    delta: {
      type: 'text_delta',
      text: state.pendingLeadingText,
    },
  })
  state.pendingLeadingText = ''
}

function ensureTextBlockOpen(
  events: Array<AnthropicStreamEventData>,
  state: AnthropicStreamState,
): void {
  if (state.contentBlockOpen && state.currentBlockType !== 'text') {
    closeOpenAnthropicBlock(events, state)
  }

  if (!state.contentBlockOpen) {
    events.push({
      type: 'content_block_start',
      index: state.contentBlockIndex,
      content_block: {
        type: 'text',
        text: '',
      },
    })
    state.contentBlockOpen = true
    state.currentBlockType = 'text'
  }
}

export function canRecoverUpstreamTerminationAsMessage(
  state: AnthropicStreamState,
): boolean {
  // Recovering a terminated stream as a successful message is only safe once
  // we have surfaced some non-thinking assistant output. Otherwise Claude Code
  // receives an "end_turn" with no visible content and the turn appears to end
  // silently.
  return state.hasNonThinkingContent
}

export function finalizeAnthropicStreamFromState(
  state: AnthropicStreamState,
  options?: {
    stopReason?: AnthropicResponse['stop_reason']
    outputTokens?: number
  },
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (!state.messageStartSent || state.messageStopSent) {
    return events
  }

  if (state.pendingLeadingText) {
    flushPendingLeadingText(events, state)
  }

  if (isToolBlockOpen(state)) {
    return events
  }

  if (state.contentBlockOpen) {
    closeOpenAnthropicBlock(events, state)
  }

  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: options?.stopReason ?? 'end_turn',
        stop_sequence: null,
      },
      usage: {
        output_tokens: options?.outputTokens ?? 0,
      },
    },
    {
      type: 'message_stop',
    },
  )
  state.messageStopSent = true

  return events
}

export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice

  if (!state.messageStartSent) {
    events.push({
      type: 'message_start',
      message: {
        id: chunk.id,
        type: 'message',
        role: 'assistant',
        content: [],
        model: state.requestedModel ?? chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          // Many OpenAI-compatible streaming backends only emit usage on the
          // final chunk, so message_start may have 0 input tokens here.
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0, // Will be updated in message_delta when finished
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
    })
    state.messageStartSent = true
  }

  if (typeof delta.reasoning_text === 'string' && delta.reasoning_text.length > 0) {
    // Copilot chat-completions reasoning cannot be replayed as Anthropic
    // thinking because native /v1/messages requires Anthropic-issued
    // signatures for assistant thinking history. Keep tracking that reasoning
    // occurred for recovery/error handling, but omit translated thinking
    // events so follow-up turns stay valid.
    state.hasThinkingContent = true
  }

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    if (
      isBeforeFirstContentBlock(state)
      && state.pendingLeadingText === ''
      && delta.content.trim().length === 0
    ) {
      state.pendingLeadingText = delta.content
    }
    else {
      if (state.pendingLeadingText) {
        flushPendingLeadingText(events, state)
      }

      if (isToolBlockOpen(state)) {
        // A tool block was open, so close it before starting a text block.
        closeOpenAnthropicBlock(events, state)
      }

      ensureTextBlockOpen(events, state)
      state.hasNonThinkingContent = true

      events.push({
        type: 'content_block_delta',
        index: state.contentBlockIndex,
        delta: {
          type: 'text_delta',
          text: delta.content,
        },
      })
    }
  }

  if (delta.tool_calls) {
    if (isBeforeFirstContentBlock(state)) {
      state.pendingLeadingText = ''
    }

    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting.
        if (state.contentBlockOpen) {
          // Close any previously open block.
          closeOpenAnthropicBlock(events, state)
        }

        const anthropicBlockIndex = state.contentBlockIndex
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex,
        }

        events.push({
          type: 'content_block_start',
          index: anthropicBlockIndex,
          content_block: {
            type: 'tool_use',
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        })
        state.contentBlockOpen = true
        state.currentBlockType = 'tool_use'
        state.hasNonThinkingContent = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        // Tool call can still be empty
        if (toolCallInfo) {
          events.push({
            type: 'content_block_delta',
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    if (state.pendingLeadingText) {
      flushPendingLeadingText(events, state)
    }

    if (isToolBlockOpen(state)) {
      // A tool block was open, so close it before starting a text block.
      closeOpenAnthropicBlock(events, state)
    }
    if (state.contentBlockOpen) {
      closeOpenAnthropicBlock(events, state)
    }

    events.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason: mapOpenAIStopReasonToAnthropic(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: chunk.usage?.completion_tokens ?? 0,
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
      {
        type: 'message_stop',
      },
    )
    state.messageStopSent = true
  }

  return events
}

export function translateErrorToAnthropicErrorEvent(
  message?: string,
): AnthropicStreamEventData {
  return {
    type: 'error',
    error: {
      type: 'api_error',
      message: message ?? 'An unexpected error occurred during streaming.',
    },
  }
}
