import type { AnthropicAssistantContentBlock, AnthropicAssistantMessage, AnthropicMessage, AnthropicMessagesPayload, AnthropicResponse, AnthropicTextBlock, AnthropicThinkingBlock, AnthropicTool, AnthropicToolResultBlock, AnthropicToolUseBlock, AnthropicUserContentBlock, AnthropicUserMessage } from './anthropic-types'

import type { ChatCompletionResponse, ChatCompletionsPayload, ContentPart, Message, TextPart, Tool, ToolCall } from '~/services/copilot/create-chat-completions'
import consola from 'consola'
import { getModelConfig } from '~/lib/model-config'
import { logIgnoredAnthropicParameter, logLossyAnthropicCompatibility, mapAnthropicCacheControl, throwAnthropicInvalidRequestError } from '~/lib/translation/anthropic-compat'
import { mapAnthropicOutputFormatToChatCompletions } from '~/lib/translation/anthropic-output-format'
import { mapAnthropicReasoningToChatCompletions, resolveAnthropicReasoningEffort } from '~/lib/translation/anthropic-reasoning'
import { mapOpenAIStopReasonToAnthropic } from './utils'

// Payload translation

export interface TranslateOptions {
  anthropicBeta?: string
}

/** Models that support Claude routing variants such as -fast and -1m. */
const MODEL_VARIANTS: Record<string, Set<string>> = {
  'claude-opus-4.6': new Set(['fast', '1m']),
}

/** Parse comma-separated anthropic-beta header into a Set of feature names */
export function parseBetaFeatures(anthropicBeta: string | undefined): Set<string> {
  if (!anthropicBeta) {
    return new Set()
  }
  return new Set(anthropicBeta.split(',').map(s => s.trim()).filter(Boolean))
}

/**
 * Resolve the Anthropic request model to the effective Copilot model ID.
 * Claude fast/1m requests stay as distinct variant IDs, but inherit the same
 * backend and capability support as the base Opus 4.6 model.
 */
export function applyModelVariant(
  model: string,
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
): string {
  const normalizedModel = translateModelName(model)
  const variants = MODEL_VARIANTS[normalizedModel]
  if (!variants) {
    return normalizedModel
  }

  const betaFeatures = parseBetaFeatures(anthropicBeta)

  // Fast mode takes priority when both signals are present.
  if (variants.has('fast')) {
    if (payload.speed === 'fast' || betaFeatures.has('fast-mode-2026-02-01')) {
      return `${normalizedModel}-fast`
    }
  }

  if (variants.has('1m')) {
    if (betaFeatures.has('context-1m-2025-08-07')) {
      return `${normalizedModel}-1m`
    }
  }

  return normalizedModel
}

export function translateToOpenAI(
  payload: AnthropicMessagesPayload,
  options?: TranslateOptions,
): ChatCompletionsPayload {
  const model = applyModelVariant(payload.model, payload, options?.anthropicBeta)
  const modelConfig = getModelConfig(model)
  const enableCacheControl = modelConfig.enableCacheControl === true

  if (payload.top_k !== undefined) {
    logIgnoredAnthropicParameter(
      'top_k',
      'Chat Completions does not expose an OpenAI-compatible top_k field.',
    )
  }

  logIgnoredMessageBlockCacheControl(payload, enableCacheControl)

  const messages = translateAnthropicMessagesToOpenAI(
    payload.messages,
    payload.system,
  )
  const explicitSystemCacheControl = resolveSystemMessageCacheControl(
    payload.system,
    enableCacheControl,
  )

  // Add copilot_cache_control to the system message for Claude models
  const systemMessage = messages.find(m => m.role === 'system')
  if (systemMessage && (enableCacheControl || explicitSystemCacheControl)) {
    systemMessage.copilot_cache_control = explicitSystemCacheControl ?? { type: 'ephemeral' }
  }

  const tools = translateAnthropicToolsToOpenAI(payload.tools, enableCacheControl)

  // Add copilot_cache_control to the last tool for Claude models
  if (enableCacheControl && tools && tools.length > 0) {
    tools[tools.length - 1].copilot_cache_control ??= { type: 'ephemeral' }
  }

  const reasoning_effort = mapAnthropicReasoningToChatCompletions(
    resolveAnthropicReasoningEffort(payload, modelConfig),
    modelConfig,
  )
  const tool_choice = modelConfig.supportsToolChoice
    ? translateAnthropicToolChoiceToOpenAI(payload.tool_choice)
    : undefined
  const response_format = mapAnthropicOutputFormatToChatCompletions(payload.output_config)
  const parallel_tool_calls = payload.tool_choice?.disable_parallel_tool_use === true
    && modelConfig.supportsParallelToolCalls
    ? false
    : undefined

  return {
    model,
    messages,
    max_tokens: payload.max_tokens,
    stop: payload.stop_sequences,
    stream: payload.stream,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.metadata?.user_id,
    tools,
    ...(response_format && { response_format }),
    ...(tool_choice !== undefined && { tool_choice }),
    ...(parallel_tool_calls !== undefined && { parallel_tool_calls }),
    snippy: { enabled: false },
    ...(reasoning_effort && { reasoning_effort }),
  }
}

function translateModelName(model: string): string {
  const datedModelMatch = model.match(/^(claude-(?:sonnet|opus|haiku)-\d+(?:\.\d+)?)-\d{8,}$/)
  if (datedModelMatch) {
    return datedModelMatch[1]
  }

  const hyphenVersionMatch = model.match(/^(claude-(?:sonnet|opus|haiku)-\d+)-(\d)(?:-\d{8,})?$/)
  if (hyphenVersionMatch) {
    return `${hyphenVersionMatch[1]}.${hyphenVersionMatch[2]}`
  }

  return model
}

function translateAnthropicMessagesToOpenAI(
  anthropicMessages: Array<AnthropicMessage>,
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  const systemMessages = handleSystemPrompt(system)

  const otherMessages = anthropicMessages.flatMap(message =>
    message.role === 'user'
      ? handleUserMessage(message)
      : handleAssistantMessage(message),
  )

  return [...systemMessages, ...otherMessages]
}

function handleSystemPrompt(
  system: string | Array<AnthropicTextBlock> | undefined,
): Array<Message> {
  if (!system) {
    return []
  }

  if (typeof system === 'string') {
    return [{ role: 'system', content: system }]
  }
  else {
    const systemText = system.map(block => block.text).join('\n\n')
    return [{ role: 'system', content: systemText }]
  }
}

function handleUserMessage(message: AnthropicUserMessage): Array<Message> {
  const newMessages: Array<Message> = []

  if (Array.isArray(message.content)) {
    const toolResultBlocks = message.content.filter(
      (block): block is AnthropicToolResultBlock =>
        block.type === 'tool_result',
    )
    const otherBlocks = message.content.filter(
      block => block.type !== 'tool_result',
    )

    // Tool results must come first to maintain protocol: tool_use -> tool_result -> user
    for (const block of toolResultBlocks) {
      newMessages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: mapContent(block.content),
      })
    }

    if (otherBlocks.length > 0) {
      newMessages.push({
        role: 'user',
        content: mapContent(otherBlocks),
      })
    }
  }
  else {
    newMessages.push({
      role: 'user',
      content: mapContent(message.content),
    })
  }

  return newMessages
}

function handleAssistantMessage(
  message: AnthropicAssistantMessage,
): Array<Message> {
  if (!Array.isArray(message.content)) {
    return [
      {
        role: 'assistant',
        content: mapContent(message.content),
      },
    ]
  }

  const toolUseBlocks = message.content.filter(
    (block): block is AnthropicToolUseBlock => block.type === 'tool_use',
  )

  const textBlocks = message.content.filter(
    (block): block is AnthropicTextBlock => block.type === 'text',
  )
  const thinkingBlocks = message.content.filter(
    (block): block is AnthropicThinkingBlock => block.type === 'thinking',
  )

  const reasoningText = extractAssistantReasoningText(thinkingBlocks)
  const reasoningOpaque = extractAssistantReasoningOpaque(thinkingBlocks)

  const visibleText = textBlocks.length > 0
    ? mapContent(textBlocks)
    : null

  return toolUseBlocks.length > 0
    ? [
        {
          role: 'assistant',
          content: visibleText,
          ...(reasoningText && { reasoning_text: reasoningText }),
          ...(reasoningOpaque && { reasoning_opaque: reasoningOpaque }),
          tool_calls: toolUseBlocks.map(toolUse => ({
            id: toolUse.id,
            type: 'function',
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input),
            },
          })),
        },
      ]
    : visibleText === null && reasoningText === null
      ? []
      : [
          {
            role: 'assistant',
            content: visibleText,
            ...(reasoningText && { reasoning_text: reasoningText }),
            ...(reasoningOpaque && { reasoning_opaque: reasoningOpaque }),
          },
        ]
}

function extractAssistantReasoningText(
  thinkingBlocks: Array<AnthropicThinkingBlock>,
): string | null {
  if (thinkingBlocks.length === 0) {
    return null
  }

  const thinkingText = thinkingBlocks
    .map(block => block.thinking)
    .filter(Boolean)
    .join('\n\n')

  if (!thinkingText) {
    return null
  }

  return thinkingText
}

function extractAssistantReasoningOpaque(
  thinkingBlocks: Array<AnthropicThinkingBlock>,
): string | null {
  const signatures = thinkingBlocks
    .map(block => block.signature)
    .filter((signature): signature is string => Boolean(signature))

  if (signatures.length === 0) {
    return null
  }

  const distinctSignatures = new Set(signatures)
  if (distinctSignatures.size > 1) {
    logLossyAnthropicCompatibility(
      'assistant thinking signatures',
      'Multiple Anthropic thinking signatures in one assistant turn are not fully representable in Copilot Chat Completions, so the latest signature is forwarded as reasoning_opaque.',
    )
  }

  return signatures[signatures.length - 1] ?? null
}

function mapContent(
  content:
    | string
    | Array<AnthropicUserContentBlock | AnthropicAssistantContentBlock>,
): string | Array<ContentPart> | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }

  if (content.some(block => block.type === 'document')) {
    throwAnthropicInvalidRequestError(
      'GitHub Copilot does not support Anthropic document blocks yet. Extract the document text or convert the document into supported text/image inputs before sending it through the proxy.',
    )
  }

  const hasImage = content.some(block => block.type === 'image')
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock =>
          block.type === 'text',
      )
      .map(block => block.text)
      .join('\n\n')
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        contentParts.push({ type: 'text', text: block.text })

        break
      }
      case 'image': {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: block.source.type === 'base64'
              ? `data:${block.source.media_type};base64,${block.source.data}`
              : block.source.url,
          },
        })

        break
      }
      // No default
    }
  }
  return contentParts
}

function translateAnthropicToolsToOpenAI(
  anthropicTools: Array<AnthropicTool> | undefined,
  enableCacheControl: boolean,
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map((tool, index) => {
    if (tool.cache_control && !enableCacheControl) {
      logIgnoredAnthropicParameter(
        `tools[${index}].cache_control`,
        'Current Copilot cache hints are only enabled on Claude-routed models.',
      )
    }

    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
      ...(enableCacheControl && tool.cache_control && {
        copilot_cache_control: mapAnthropicCacheControl(
          tool.cache_control,
          `tools[${index}]`,
        ),
      }),
    }
  })
}

function translateAnthropicToolChoiceToOpenAI(
  anthropicToolChoice: AnthropicMessagesPayload['tool_choice'],
): ChatCompletionsPayload['tool_choice'] {
  if (!anthropicToolChoice) {
    return undefined
  }

  switch (anthropicToolChoice.type) {
    case 'auto': {
      return 'auto'
    }
    case 'any': {
      return 'required'
    }
    case 'tool': {
      if (anthropicToolChoice.name) {
        return {
          type: 'function',
          function: { name: anthropicToolChoice.name },
        }
      }
      return undefined
    }
    case 'none': {
      return 'none'
    }
    default: {
      return undefined
    }
  }
}

function resolveSystemMessageCacheControl(
  system: string | Array<AnthropicTextBlock> | undefined,
  enableCacheControl: boolean,
): Message['copilot_cache_control'] | undefined {
  if (!Array.isArray(system)) {
    return undefined
  }

  const cacheControlBlocks = system
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.cache_control)

  if (cacheControlBlocks.length === 0) {
    return undefined
  }

  if (!enableCacheControl) {
    logIgnoredAnthropicParameter(
      'system[].cache_control',
      'Current Copilot cache hints are only enabled on Claude-routed models.',
    )
    return undefined
  }

  if (cacheControlBlocks.length > 1) {
    logLossyAnthropicCompatibility(
      'system cache_control',
      'Multiple Anthropic system block cache hints are collapsed into one Copilot system message hint.',
    )
  }

  const lastBlock = cacheControlBlocks[cacheControlBlocks.length - 1]
  return mapAnthropicCacheControl(
    lastBlock?.block.cache_control,
    `system[${lastBlock.index}]`,
  )
}

function logIgnoredMessageBlockCacheControl(
  payload: AnthropicMessagesPayload,
  enableCacheControl: boolean,
): void {
  let foundIgnoredCacheControl = false

  for (const [messageIndex, message] of payload.messages.entries()) {
    if (!Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      if ('cache_control' in block && block.cache_control) {
        foundIgnoredCacheControl = true
        break
      }

      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        if (block.content.some(contentBlock => 'cache_control' in contentBlock && contentBlock.cache_control)) {
          foundIgnoredCacheControl = true
          break
        }
      }
    }

    if (foundIgnoredCacheControl) {
      logIgnoredAnthropicParameter(
        `messages[${messageIndex}].content[].cache_control`,
        enableCacheControl
          ? 'Fine-grained Anthropic message block cache hints cannot be represented on the Copilot Chat Completions wire format.'
          : 'Current Copilot cache hints are only enabled on Claude-routed models.',
      )
      return
    }
  }
}

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  const allContentBlocks: Array<AnthropicResponse['content'][number]> = []
  let stopReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
    = null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  for (const choice of response.choices) {
    const thinkingBlocks = getAnthropicThinkingBlocks(
      choice.message.reasoning_text,
      choice.message.reasoning_opaque,
    )
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allContentBlocks.push(...thinkingBlocks, ...textBlocks, ...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === 'tool_calls' || stopReason === 'stop') {
      stopReason = choice.finish_reason
    }
  }

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: allContentBlocks,
    stop_reason: mapOpenAIStopReasonToAnthropic(stopReason),
    stop_sequence: null,
    usage: {
      input_tokens:
        (response.usage?.prompt_tokens ?? 0)
        - (response.usage?.prompt_tokens_details?.cached_tokens ?? 0),
      output_tokens: response.usage?.completion_tokens ?? 0,
      ...(response.usage?.prompt_tokens_details?.cached_tokens
        !== undefined && {
        cache_read_input_tokens:
          response.usage.prompt_tokens_details.cached_tokens,
      }),
    },
  }
}

function getAnthropicThinkingBlocks(
  reasoningText: Message['reasoning_text'],
  reasoningOpaque?: Message['reasoning_opaque'],
): Array<AnthropicThinkingBlock> {
  if (typeof reasoningText !== 'string' || reasoningText.length === 0) {
    return []
  }

  return [{
    type: 'thinking',
    thinking: reasoningText,
    ...(typeof reasoningOpaque === 'string' && reasoningOpaque.length > 0
      ? { signature: reasoningOpaque }
      : {}),
  }]
}

function getAnthropicTextBlocks(
  messageContent: Message['content'],
): Array<AnthropicTextBlock> {
  if (typeof messageContent === 'string') {
    return [{ type: 'text', text: messageContent }]
  }

  if (Array.isArray(messageContent)) {
    return messageContent
      .filter((part): part is TextPart => part.type === 'text')
      .map(part => ({ type: 'text', text: part.text }))
  }

  return []
}

function getAnthropicToolUseBlocks(
  toolCalls: Array<ToolCall> | undefined,
): Array<AnthropicToolUseBlock> {
  if (!toolCalls) {
    return []
  }
  return toolCalls.map((toolCall) => {
    let parsedInput: Record<string, unknown>
    try {
      parsedInput = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
    }
    catch {
      consola.warn('Failed to parse tool call arguments:', toolCall.function.arguments)
      parsedInput = {}
    }
    return {
      type: 'tool_use' as const,
      id: toolCall.id,
      name: toolCall.function.name,
      input: parsedInput,
    }
  })
}
