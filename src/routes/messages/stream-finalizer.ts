import type { AnthropicStreamEventData } from '~/lib/anthropic/types'

import consola from 'consola'

export interface AnthropicEventWriter {
  writeEvent: (event: AnthropicStreamEventData) => Promise<void>
}

export interface RecoverableAnthropicOutputState {
  hasNonThinkingContent: boolean
  hasThinkingContent: boolean
}

export interface AnthropicStreamFailureOptions {
  completionTerm: string
  error: unknown
  errorLabel: string
  streamLabel: string
  state: RecoverableAnthropicOutputState
  unexpectedErrorMessage: string
  writer: AnthropicEventWriter
  finalizeRecoveredEvents: () => Array<AnthropicStreamEventData>
  canRecoverTermination?: () => boolean
  clientAborted?: () => boolean
  shouldEmitTerminationError?: () => boolean
}

export function canRecoverUpstreamTerminationAsMessage(
  state: RecoverableAnthropicOutputState,
): boolean {
  // Recovering a terminated stream as a successful message is only safe once
  // we have surfaced some non-thinking assistant output. Otherwise Claude Code
  // receives an "end_turn" with no visible content and the turn appears to end
  // silently.
  return state.hasNonThinkingContent
}

export function createAnthropicErrorEvent(
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

export async function writeAnthropicEvents(
  writer: AnthropicEventWriter,
  events: Array<AnthropicStreamEventData>,
): Promise<void> {
  for (const event of events) {
    await writer.writeEvent(event)
  }
}

export async function handleAnthropicStreamFailure(
  options: AnthropicStreamFailureOptions,
): Promise<void> {
  if (options.clientAborted?.()) {
    return
  }

  const upstreamTerminated = isRecoverableUpstreamTermination(options.error)
  const recoveredEvents = upstreamTerminated && (options.canRecoverTermination?.() ?? true)
    ? options.finalizeRecoveredEvents()
    : []

  if (recoveredEvents.length > 0) {
    consola.warn(`${options.streamLabel} terminated without a ${options.completionTerm}; synthesizing Anthropic message_stop.`)
    await writeAnthropicEvents(options.writer, recoveredEvents)
    return
  }

  if (upstreamTerminated && (options.shouldEmitTerminationError?.() ?? true)) {
    consola.warn(`${options.streamLabel} terminated without recoverable assistant output; returning Anthropic error event.`)
    await options.writer.writeEvent(
      createAnthropicErrorEvent(
        getUpstreamTerminationErrorMessage(options.state),
      ),
    )
    return
  }

  const message = options.error instanceof Error
    ? options.error.message
    : options.unexpectedErrorMessage
  consola.error(`${options.errorLabel} failed:`, summarizeStreamFailure(options.error))
  await options.writer.writeEvent(createAnthropicErrorEvent(message))
}

export function getUpstreamTerminationErrorMessage(
  state: RecoverableAnthropicOutputState,
): string {
  return state.hasThinkingContent && !state.hasNonThinkingContent
    ? 'Upstream Copilot connection terminated after reasoning output, before any assistant text or tool call was produced.'
    : 'Upstream Copilot connection terminated before the response completed.'
}

function isRecoverableUpstreamTermination(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  if (error.message === 'terminated' || String(error).includes('terminated')) {
    return true
  }

  const cause = error.cause
  if (!cause || typeof cause !== 'object') {
    return false
  }

  const code = 'code' in cause ? cause.code : undefined
  const message = 'message' in cause ? cause.message : undefined

  return code === 'UND_ERR_SOCKET' || message === 'other side closed'
}

type NativeAnthropicBlockType = string

export interface NativeAnthropicPassthroughState extends RecoverableAnthropicOutputState {
  currentBlockIndex: number | null
  currentBlockType: NativeAnthropicBlockType | null
  errorSeen: boolean
  messageDeltaSeen: boolean
  messageStartSeen: boolean
  messageStopSeen: boolean
  outputTokens: number
}

export function createNativeAnthropicPassthroughState(): NativeAnthropicPassthroughState {
  return {
    currentBlockIndex: null,
    currentBlockType: null,
    errorSeen: false,
    hasNonThinkingContent: false,
    hasThinkingContent: false,
    messageDeltaSeen: false,
    messageStartSeen: false,
    messageStopSeen: false,
    outputTokens: 0,
  }
}

export function updateNativeAnthropicPassthroughState(
  state: NativeAnthropicPassthroughState,
  event: AnthropicStreamEventData,
): void {
  switch (event.type) {
    case 'message_start': {
      state.messageStartSeen = true
      state.outputTokens = event.message.usage.output_tokens
      return
    }

    case 'content_block_start': {
      state.currentBlockIndex = event.index
      state.currentBlockType = event.content_block.type

      if (event.content_block.type === 'thinking') {
        state.hasThinkingContent ||= event.content_block.thinking.length > 0
      }
      else if (event.content_block.type === 'redacted_thinking') {
        state.hasThinkingContent ||= event.content_block.data.length > 0
      }
      else if (event.content_block.type === 'text') {
        state.hasNonThinkingContent ||= event.content_block.text.length > 0
      }
      else {
        // tool_use, server_tool_use, and hosted-tool result blocks are all
        // client-visible assistant output. Native passthrough must not assume
        // every non-thinking block carries a `text` field.
        state.hasNonThinkingContent = true
      }
      return
    }

    case 'content_block_delta': {
      if (event.delta.type === 'thinking_delta' || event.delta.type === 'signature_delta') {
        const content = event.delta.type === 'thinking_delta'
          ? event.delta.thinking
          : event.delta.signature
        state.hasThinkingContent ||= content.length > 0
      }
      else if (event.delta.type === 'text_delta') {
        state.hasNonThinkingContent ||= event.delta.text.length > 0
      }
      else if (event.delta.type === 'input_json_delta') {
        state.hasNonThinkingContent ||= event.delta.partial_json.length > 0
      }
      return
    }

    case 'content_block_stop': {
      if (state.currentBlockIndex === event.index) {
        state.currentBlockIndex = null
        state.currentBlockType = null
      }
      return
    }

    case 'message_delta': {
      state.messageDeltaSeen = true
      state.outputTokens = event.usage?.output_tokens ?? state.outputTokens
      return
    }

    case 'message_stop': {
      state.messageStopSeen = true
      return
    }

    case 'error': {
      state.errorSeen = true
      break
    }

    case 'ping': {
      break
    }
  }
}

export function finalizeNativeAnthropicPassthroughState(
  state: NativeAnthropicPassthroughState,
): Array<AnthropicStreamEventData> {
  if (!state.messageStartSeen || state.messageStopSeen || state.errorSeen || !state.hasNonThinkingContent) {
    return []
  }

  if (state.currentBlockType === 'tool_use' || state.currentBlockType === 'server_tool_use') {
    return []
  }

  const events: Array<AnthropicStreamEventData> = []

  if (state.currentBlockIndex !== null) {
    events.push({
      type: 'content_block_stop',
      index: state.currentBlockIndex,
    })
    state.currentBlockIndex = null
    state.currentBlockType = null
  }

  if (!state.messageDeltaSeen) {
    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      usage: {
        output_tokens: state.outputTokens,
      },
    })
  }

  events.push({ type: 'message_stop' })
  state.messageStopSeen = true
  return events
}

export function shouldEmitNativeAnthropicTerminationError(
  state: NativeAnthropicPassthroughState,
): boolean {
  return state.messageStartSeen && !state.messageStopSeen && !state.errorSeen
}

function summarizeStreamFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { kind: typeof error }
  }

  const cause = error.cause && typeof error.cause === 'object'
    ? error.cause as Record<string, unknown>
    : undefined

  return {
    name: error.name,
    messageChars: error.message.length,
    ...(typeof cause?.code === 'string' && { causeCode: cause.code }),
  }
}
