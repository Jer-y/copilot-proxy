/**
 * Anthropic → Responses API request translation (T7)
 */

import type {
  AnthropicAssistantMessage,
  AnthropicMessage,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
  AnthropicUserContentBlock,
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
import { logIgnoredAnthropicParameter, logLossyAnthropicCompatibility, mapAnthropicCacheControl, throwAnthropicInvalidRequestError } from './anthropic-compat'
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

  if (payload.top_k !== undefined) {
    logIgnoredAnthropicParameter(
      'top_k',
      'Responses does not expose an OpenAI-compatible top_k field.',
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
  const thinkingBlocks = msg.content.filter(block => block.type === 'thinking')

  if (thinkingBlocks.length > 0) {
    logLossyAnthropicCompatibility(
      'assistant thinking replay',
      'Responses cannot replay Anthropic thinking blocks, so only visible assistant text/tool_use content is forwarded.',
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
