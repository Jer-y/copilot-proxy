/**
 * Responses API → CC (Chat Completions) request/response translation
 *
 * T4: translateResponsesRequestToCC — request payload translation
 * T5: translateCCResponseToResponses — CC response → Responses response
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
} from '~/services/copilot/create-responses'

import consola from 'consola'
import { JSONResponseError } from '~/lib/error'
import { mapCCFinishReasonToResponsesStatus, translateResponsesContentPartsToCC } from './utils'

// ─── T4: Responses Request → CC Request ─────────────────────────

export function translateResponsesRequestToCC(payload: ResponsesPayload): ChatCompletionsPayload {
  const messages = translateResponsesInputToCCMessages(
    payload.input,
    payload.instructions,
  )
  const tools = translateResponsesToolsToCC(payload.tools)
  const reasoningEffort = translateResponsesReasoningEffortToCC(payload.reasoning?.effort)

  return {
    model: payload.model,
    messages,
    stream: payload.stream ?? undefined,
    temperature: payload.temperature,
    top_p: payload.top_p,
    max_tokens: payload.max_output_tokens,
    ...(tools && { tools }),
    ...(payload.tool_choice !== undefined && {
      tool_choice: translateResponsesToCCToolChoice(payload.tool_choice),
    }),
    ...(reasoningEffort && {
      reasoning_effort: reasoningEffort,
    }),
    ...(payload.text?.format?.type === 'json_object' && {
      response_format: { type: 'json_object' as const },
    }),
  }
}

function translateResponsesReasoningEffortToCC(
  effort: NonNullable<NonNullable<ResponsesPayload['reasoning']>['effort']> | undefined,
): ChatCompletionsPayload['reasoning_effort'] | undefined {
  if (!effort || effort === 'none') {
    return undefined
  }

  if (effort === 'minimal') {
    return 'low'
  }

  if (effort === 'xhigh') {
    return 'high'
  }

  return effort
}

function translateResponsesInputToCCMessages(
  input: ResponsesPayload['input'],
  instructions: string | undefined,
): Array<Message> {
  const messages: Array<Message> = []

  if (instructions) {
    messages.push({ role: 'system', content: instructions })
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
    return messages
  }

  let pendingAssistantContent: Message['content'] | undefined
  let pendingToolCalls: Array<ToolCall> = []

  const flushPendingAssistantMessage = () => {
    if (pendingAssistantContent === undefined && pendingToolCalls.length === 0) {
      return
    }

    messages.push({
      role: 'assistant',
      content: pendingAssistantContent ?? null,
      ...(pendingToolCalls.length > 0 && { tool_calls: pendingToolCalls }),
    })

    pendingAssistantContent = undefined
    pendingToolCalls = []
  }

  for (const item of input) {
    if (isFunctionCallItem(item)) {
      pendingToolCalls.push({
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      })
      continue
    }

    if (isFunctionCallOutputItem(item)) {
      flushPendingAssistantMessage()
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: item.output,
      })
      continue
    }

    if (!isMessageInputItem(item)) {
      throwUnsupportedResponsesInputItem(item)
    }

    const role = item.role === 'developer' ? 'developer' : item.role
    if (role === 'assistant') {
      flushPendingAssistantMessage()
      pendingAssistantContent = translateResponsesContentPartsToCC(item.content, role)
      continue
    }

    flushPendingAssistantMessage()
    messages.push({
      role,
      content: translateResponsesContentPartsToCC(item.content, role),
    })
  }

  flushPendingAssistantMessage()

  return messages
}

function translateResponsesToolsToCC(tools: Array<ResponsesTool> | undefined): Array<Tool> | undefined {
  if (!tools || tools.length === 0)
    return undefined

  const functionTools = tools.filter(isResponsesFunctionTool)
  if (functionTools.length === 0)
    return undefined

  return functionTools.map(tool => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: (tool.parameters ?? {}) as Record<string, unknown>,
    },
  }))
}

function isResponsesFunctionTool(tool: ResponsesTool): tool is ResponsesTool & { type: 'function', name: string } {
  return tool.type === 'function' && typeof tool.name === 'string' && tool.name.length > 0
}

function translateResponsesToCCToolChoice(
  toolChoice: ResponsesPayload['tool_choice'],
): ChatCompletionsPayload['tool_choice'] {
  if (toolChoice === undefined || toolChoice === null)
    return undefined
  if (toolChoice === 'none')
    return 'none'
  if (toolChoice === 'auto')
    return 'auto'
  if (toolChoice === 'required')
    return 'required'
  if (typeof toolChoice === 'object' && 'name' in toolChoice) {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  return undefined
}

// ─── T5: CC Response → Responses Response ───────────────────────

export function translateCCResponseToResponses(response: ChatCompletionResponse): ResponsesResponse {
  if (response.choices.length > 1) {
    consola.warn(`CC response has ${response.choices.length} choices, only first will be used`)
  }

  const choice = response.choices[0]
  if (!choice) {
    return {
      id: response.id,
      object: 'response',
      model: response.model,
      output: [],
      status: 'failed',
      error: { message: 'No choices in response' },
    }
  }

  const output: Array<ResponsesOutputItem> = []

  if (choice.message.content) {
    output.push({
      type: 'message',
      id: `msg_${response.id}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: choice.message.content }],
    })
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      output.push({
        type: 'function_call',
        id: `fc_${tc.id}`,
        call_id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
        status: 'completed',
      } as ResponsesOutputItem)
    }
  }

  const { status, incomplete_details } = mapCCFinishReasonToResponsesStatus(choice.finish_reason)

  return {
    id: response.id,
    object: 'response',
    model: response.model,
    output,
    status,
    ...(incomplete_details && { incomplete_details }),
    usage: response.usage
      ? {
          input_tokens: response.usage.prompt_tokens,
          output_tokens: response.usage.completion_tokens,
          total_tokens: response.usage.total_tokens,
          ...(response.usage.prompt_tokens_details && {
            input_tokens_details: {
              cached_tokens: response.usage.prompt_tokens_details.cached_tokens,
            },
          }),
        }
      : undefined,
  }
}

// ─── Type guards ────────────────────────────────────────────────

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

function throwUnsupportedResponsesInputItem(item: ResponsesInputItem): never {
  const itemType = item.type ?? 'unknown'
  const message = `Unsupported Responses input item type "${itemType}" for chat-completions translation`

  throw new JSONResponseError(message, 400, {
    error: {
      message,
      type: 'invalid_request_error',
    },
  })
}
