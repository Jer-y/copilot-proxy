/**
 * Anthropic → Responses API request translation (T7)
 */

import type {
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserMessage,
} from './types'
import type {
  ResponsesFunctionCallItem,
  ResponsesFunctionCallOutputItem,
  ResponsesInputItem,
  ResponsesMessageInputItem,
  ResponsesPayload,
  ResponsesTool,
  ResponsesToolChoice,
} from '~/services/copilot/create-responses'
import { getModelConfig } from '~/lib/model-config'
import { mapAnthropicOutputFormatToResponses } from './anthropic-output-format'
import { mapAnthropicReasoningToResponses, resolveAnthropicReasoningEffort } from './anthropic-reasoning'

export interface TranslateAnthropicToResponsesOptions {
  model?: string
}

export function translateAnthropicRequestToResponses(
  payload: AnthropicMessagesPayload,
  options?: TranslateAnthropicToResponsesOptions,
): ResponsesPayload {
  const model = options?.model ?? payload.model
  const modelConfig = getModelConfig(model)
  const instructions = translateSystemToInstructions(payload.system)
  const input = translateAnthropicMessagesToResponsesInput(payload.messages)
  const tools = translateAnthropicToolsToResponses(payload.tools)
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
    const content = otherBlocks.map((block) => {
      if (block.type === 'image') {
        return block.source.type === 'base64'
          ? {
              type: 'input_image' as const,
              source: block.source,
            }
          : {
              type: 'input_image' as const,
              image_url: block.source.url,
            }
      }

      return { type: 'input_text' as const, text: block.text }
    })
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
  tools: Array<{ name: string, description?: string, input_schema: Record<string, unknown> }> | undefined,
): Array<ResponsesTool> | undefined {
  if (!tools || tools.length === 0)
    return undefined

  return tools.map(tool => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }))
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
