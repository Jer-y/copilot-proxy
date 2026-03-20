import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ToolCall,
} from '~/services/copilot/create-chat-completions'

type BufferedFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

interface BufferedChoiceState {
  index: number
  content: string
  reasoningText: string
  reasoningOpaque: string | null
  toolCalls: Map<number, ToolCall>
  finishReason: BufferedFinishReason | null
}

export interface BufferedChatCompletionsState {
  id: string
  model: string
  created: number
  usage?: ChatCompletionResponse['usage']
  hasThinkingContent: boolean
  hasNonThinkingContent: boolean
  choices: Map<number, BufferedChoiceState>
}

export function createBufferedChatCompletionsState(): BufferedChatCompletionsState {
  return {
    id: '',
    model: '',
    created: 0,
    hasThinkingContent: false,
    hasNonThinkingContent: false,
    choices: new Map(),
  }
}

export function ingestChatCompletionsChunk(
  chunk: ChatCompletionChunk,
  state: BufferedChatCompletionsState,
): void {
  if (chunk.id) {
    state.id = chunk.id
  }
  if (chunk.model) {
    state.model = chunk.model
  }
  if (chunk.created) {
    state.created = chunk.created
  }
  if (chunk.usage) {
    state.usage = chunk.usage
  }

  for (const choice of chunk.choices) {
    const bufferedChoice = getOrCreateBufferedChoice(choice.index, state)
    const { delta } = choice

    if (typeof delta.reasoning_text === 'string' && delta.reasoning_text.length > 0) {
      bufferedChoice.reasoningText += delta.reasoning_text
      state.hasThinkingContent = true
    }

    if (typeof delta.reasoning_opaque === 'string' && delta.reasoning_opaque.length > 0) {
      bufferedChoice.reasoningOpaque = delta.reasoning_opaque
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      bufferedChoice.content += delta.content

      if (
        state.hasNonThinkingContent
        || bufferedChoice.content.trim().length > 0
      ) {
        state.hasNonThinkingContent = true
      }
    }

    if (delta.tool_calls) {
      for (const toolCallDelta of delta.tool_calls) {
        const toolCall = getOrCreateToolCall(toolCallDelta.index, bufferedChoice)

        if (toolCallDelta.id) {
          toolCall.id = toolCallDelta.id
        }
        if (toolCallDelta.function?.name) {
          toolCall.function.name = toolCallDelta.function.name
        }
        if (typeof toolCallDelta.function?.arguments === 'string') {
          toolCall.function.arguments += toolCallDelta.function.arguments
        }

        if (toolCall.id && toolCall.function.name) {
          state.hasNonThinkingContent = true
        }
      }
    }

    if (choice.finish_reason) {
      bufferedChoice.finishReason = choice.finish_reason
    }
  }
}

export function finalizeBufferedChatCompletions(
  state: BufferedChatCompletionsState,
): ChatCompletionResponse | null {
  if (state.choices.size === 0) {
    return null
  }

  const choices = Array.from(state.choices.values())
    .sort((a, b) => a.index - b.index)
    .map((choice) => {
      const toolCalls = Array.from(choice.toolCalls.entries())
        .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
        .map(([, toolCall]) => toolCall)
        .filter(toolCall => toolCall.id.length > 0 && toolCall.function.name.length > 0)

      return {
        index: choice.index,
        message: {
          role: 'assistant' as const,
          content: choice.content.length > 0 ? choice.content : null,
          ...(choice.reasoningText.length > 0
            ? { reasoning_text: choice.reasoningText }
            : {}),
          ...(choice.reasoningOpaque
            ? { reasoning_opaque: choice.reasoningOpaque }
            : {}),
          ...(toolCalls.length > 0
            ? { tool_calls: toolCalls }
            : {}),
        },
        logprobs: null,
        finish_reason: choice.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      }
    })

  return {
    id: state.id || 'chatcmpl_buffered',
    object: 'chat.completion',
    created: state.created || Math.floor(Date.now() / 1000),
    model: state.model || 'unknown',
    choices,
    ...(state.usage ? { usage: state.usage } : {}),
  }
}

export function hasVisibleAssistantOutput(
  response: ChatCompletionResponse,
): boolean {
  return response.choices.some((choice) => {
    const hasText = typeof choice.message.content === 'string'
      && choice.message.content.trim().length > 0
    const hasToolCalls = Array.isArray(choice.message.tool_calls)
      && choice.message.tool_calls.length > 0

    return hasText || hasToolCalls
  })
}

export function hasThinkingAssistantOutput(
  response: ChatCompletionResponse,
): boolean {
  return response.choices.some(choice =>
    typeof choice.message.reasoning_text === 'string'
    && choice.message.reasoning_text.length > 0,
  )
}

function getOrCreateBufferedChoice(
  index: number,
  state: BufferedChatCompletionsState,
): BufferedChoiceState {
  const existing = state.choices.get(index)
  if (existing) {
    return existing
  }

  const created: BufferedChoiceState = {
    index,
    content: '',
    reasoningText: '',
    reasoningOpaque: null,
    toolCalls: new Map(),
    finishReason: null,
  }
  state.choices.set(index, created)
  return created
}

function getOrCreateToolCall(
  index: number,
  choice: BufferedChoiceState,
): ToolCall {
  const existing = choice.toolCalls.get(index)
  if (existing) {
    return existing
  }

  const created: ToolCall = {
    id: '',
    type: 'function',
    function: {
      name: '',
      arguments: '',
    },
  }
  choice.toolCalls.set(index, created)
  return created
}
