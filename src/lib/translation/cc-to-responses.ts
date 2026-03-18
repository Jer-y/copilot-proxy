/**
 * CC (Chat Completions) → Responses API request/response translation
 *
 * T1: translateCCRequestToResponses — request payload translation
 * T2: translateResponsesResponseToCC — non-streaming response translation
 */

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Message,
  Tool,
  ToolCall,
} from '~/services/copilot/create-chat-completions'
import type {
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesMessageInputItem,
  ResponsesOutputItem,
  ResponsesPayload,
  ResponsesResponse,
  ResponsesTool,
  ResponsesToolChoice,
} from '~/services/copilot/create-responses'

import {
  mapResponsesStatusToCCFinishReason,
  throwOpenAIErrorFromFailedResponses,
  translateCCContentPartsToResponses,
} from './utils'

// ─── T1: CC Request → Responses Request ─────────────────────────

export function translateCCRequestToResponses(payload: ChatCompletionsPayload): ResponsesPayload {
  const { instructions, input } = translateCCMessagesToResponsesInput(payload.messages)
  const tools = translateCCToolsToResponses(payload.tools)
  const toolChoice = translateCCToolChoiceToResponses(payload.tool_choice)

  return {
    model: payload.model,
    ...(instructions && { instructions }),
    input,
    stream: payload.stream ?? undefined,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_output_tokens: clampMaxOutputTokens(payload.max_tokens),
    ...(tools && { tools }),
    ...(toolChoice !== undefined && { tool_choice: toolChoice }),
    ...(payload.reasoning_effort && {
      reasoning: {
        effort: payload.reasoning_effort === 'max'
          ? 'xhigh'
          : payload.reasoning_effort,
      },
    }),
    ...(payload.response_format?.type === 'json_object' && {
      text: { format: { type: 'json_object' } },
    }),
  }
}

function translateCCMessagesToResponsesInput(messages: Array<Message>): {
  instructions: string | undefined
  input: Array<ResponsesInputItem>
} {
  const systemMessages: Array<string> = []
  const input: Array<ResponsesInputItem> = []

  for (const msg of messages) {
    switch (msg.role) {
      case 'system': {
        // Collect all system messages → merge into instructions
        if (typeof msg.content === 'string') {
          systemMessages.push(msg.content)
        }
        else if (Array.isArray(msg.content)) {
          const text = msg.content
            .filter((p): p is { type: 'text', text: string } => p.type === 'text')
            .map(p => p.text)
            .join('\n\n')
          if (text)
            systemMessages.push(text)
        }
        break
      }

      case 'developer': {
        input.push({
          role: 'developer',
          content: translateCCContentPartsToResponses(msg.content, msg.role),
        } as ResponsesMessageInputItem)
        break
      }

      case 'user': {
        input.push({
          role: 'user',
          content: translateCCContentPartsToResponses(msg.content, msg.role),
        } as ResponsesMessageInputItem)
        break
      }

      case 'assistant': {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          if (msg.content) {
            input.push({
              role: 'assistant',
              content: translateCCContentPartsToResponses(msg.content, msg.role),
            } as ResponsesMessageInputItem)
          }

          for (const tc of msg.tool_calls) {
            input.push({
              type: 'function_call',
              id: `fc_${tc.id}`,
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
              status: 'completed',
            } as ResponsesFunctionCallItem)
          }
        }
        else {
          input.push({
            role: 'assistant',
            content: translateCCContentPartsToResponses(msg.content, msg.role),
          } as ResponsesMessageInputItem)
        }
        break
      }

      case 'tool': {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id!,
          output: typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content),
        } as ResponsesFunctionCallOutputItem)
        break
      }
      // No default
    }
  }

  const instructions = systemMessages.length > 0
    ? systemMessages.join('\n\n')
    : undefined

  return { instructions, input }
}

function translateCCToolsToResponses(tools: Array<Tool> | null | undefined): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0)
    return undefined

  return tools.map(tool => ({
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters as Record<string, unknown>,
    ...(tool.copilot_cache_control && { copilot_cache_control: tool.copilot_cache_control }),
  }))
}

function translateCCToolChoiceToResponses(
  toolChoice: ChatCompletionsPayload['tool_choice'],
): ResponsesToolChoice | undefined {
  if (toolChoice === undefined || toolChoice === null)
    return undefined
  if (toolChoice === 'none')
    return 'none'
  if (toolChoice === 'auto')
    return 'auto'
  if (toolChoice === 'required')
    return 'required'
  if (typeof toolChoice === 'object' && toolChoice.type === 'function') {
    return { type: 'function', name: toolChoice.function.name }
  }
  return undefined
}

function clampMaxOutputTokens(maxTokens: number | null | undefined): number | undefined {
  if (maxTokens === null || maxTokens === undefined)
    return undefined
  // Responses API requires max_output_tokens >= 16
  return Math.max(maxTokens, 16)
}

// ─── T2: Responses Response → CC Response ───────────────────────

export function translateResponsesResponseToCC(response: ResponsesResponse): ChatCompletionResponse {
  if (response.status === 'failed') {
    throwOpenAIErrorFromFailedResponses(response)
  }

  const textContent = extractTextFromResponsesOutput(response.output)
  const toolCalls = extractToolCallsFromResponsesOutput(response.output)
  const finishReason = mapResponsesStatusToCCFinishReason(response.status, response.output)

  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: textContent,
          ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: response.usage
      ? {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens,
          ...(response.usage.input_tokens_details && {
            prompt_tokens_details: {
              cached_tokens: response.usage.input_tokens_details.cached_tokens,
            },
          }),
        }
      : undefined,
  }
}

function extractTextFromResponsesOutput(output: Array<ResponsesOutputItem>): string | null {
  const texts: Array<string> = []

  for (const item of output) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          texts.push(part.text)
        }
      }
    }
  }

  return texts.length > 0 ? texts.join('') : null
}

function extractToolCallsFromResponsesOutput(output: Array<ResponsesOutputItem>): Array<ToolCall> {
  const toolCalls: Array<ToolCall> = []

  for (const item of output) {
    if (item.type === 'function_call' && item.call_id && item.name) {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments ?? '{}',
        },
      })
    }
  }

  return toolCalls
}
