import type { AnthropicAssistantContentBlock, AnthropicAssistantMessage, AnthropicMessage, AnthropicMessagesPayload, AnthropicResponse, AnthropicTextBlock, AnthropicThinkingBlock, AnthropicTool, AnthropicToolResultBlock, AnthropicToolUseBlock, AnthropicUserContentBlock, AnthropicUserMessage } from './anthropic-types'

import type { ChatCompletionResponse, ChatCompletionsPayload, ContentPart, Message, TextPart, Tool, ToolCall } from '~/services/copilot/create-chat-completions'
import { getModelConfig } from '~/lib/model-config'
import { mapOpenAIStopReasonToAnthropic } from './utils'

// Payload translation

export interface TranslateOptions {
  anthropicBeta?: string
}

/** Models that support variant suffixes (e.g. -fast, -1m) */
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

/** Apply model variant suffix based on speed field and beta header signals */
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

  // Fast mode takes priority: speed body field or beta header
  if (variants.has('fast')) {
    if (payload.speed === 'fast' || betaFeatures.has('fast-mode-2026-02-01')) {
      return `${normalizedModel}-fast`
    }
  }

  // 1M context window
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

  const messages = translateAnthropicMessagesToOpenAI(
    payload.messages,
    payload.system,
  )

  // Add copilot_cache_control to the system message for Claude models
  if (enableCacheControl) {
    const systemMessage = messages.find(m => m.role === 'system')
    if (systemMessage) {
      systemMessage.copilot_cache_control = { type: 'ephemeral' }
    }
  }

  const tools = translateAnthropicToolsToOpenAI(payload.tools)

  // Add copilot_cache_control to the last tool for Claude models
  if (enableCacheControl && tools && tools.length > 0) {
    tools[tools.length - 1].copilot_cache_control = { type: 'ephemeral' }
  }

  // Map Anthropic thinking budget_tokens to reasoning_effort
  let reasoning_effort: 'low' | 'medium' | 'high' | undefined
  if (payload.thinking?.budget_tokens) {
    reasoning_effort = 'high'
  }
  else if (modelConfig.thinkingMode !== true && modelConfig.defaultReasoningEffort) {
    reasoning_effort = modelConfig.defaultReasoningEffort
  }

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
    tool_choice: translateAnthropicToolChoiceToOpenAI(payload.tool_choice),
    snippy: { enabled: false },
    ...(reasoning_effort && { reasoning_effort }),
  }
}

function translateModelName(model: string): string {
  // Claude subagent requests use specific version suffixes that Copilot doesn't support
  // e.g., claude-sonnet-4-20250514 → claude-sonnet-4
  const hyphenVersionMatch = model.match(
    /^(claude-(?:sonnet|opus|haiku)-4)-(5|6)(?:-\d{8,})?$/,
  )
  if (hyphenVersionMatch) {
    return `${hyphenVersionMatch[1]}.${hyphenVersionMatch[2]}`
  }
  const claudePatterns = [
    /^(claude-sonnet-4)-\d{8,}$/,
    /^(claude-opus-4)-\d{8,}$/,
    /^(claude-haiku-4)-\d{8,}$/,
    /^(claude-sonnet-4\.5)-\d{8,}$/,
    /^(claude-opus-4\.5)-\d{8,}$/,
    /^(claude-opus-4\.6)-\d{8,}$/,
    /^(claude-haiku-4\.5)-\d{8,}$/,
  ]

  for (const pattern of claudePatterns) {
    const match = model.match(pattern)
    if (match) {
      return match[1]
    }
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

  // Combine text and thinking blocks, as OpenAI doesn't have separate thinking blocks
  const allTextContent = [
    ...textBlocks.map(b => b.text),
    ...thinkingBlocks.map(b => b.thinking),
  ].join('\n\n')

  return toolUseBlocks.length > 0
    ? [
        {
          role: 'assistant',
          content: allTextContent || null,
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
    : [
        {
          role: 'assistant',
          content: mapContent(message.content),
        },
      ]
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

  const hasImage = content.some(block => block.type === 'image')
  if (!hasImage) {
    return content
      .filter(
        (block): block is AnthropicTextBlock | AnthropicThinkingBlock =>
          block.type === 'text' || block.type === 'thinking',
      )
      .map(block => (block.type === 'text' ? block.text : block.thinking))
      .join('\n\n')
  }

  const contentParts: Array<ContentPart> = []
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        contentParts.push({ type: 'text', text: block.text })

        break
      }
      case 'thinking': {
        contentParts.push({ type: 'text', text: block.thinking })

        break
      }
      case 'image': {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
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
): Array<Tool> | undefined {
  if (!anthropicTools) {
    return undefined
  }
  return anthropicTools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))
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

// Response translation

export function translateToAnthropic(
  response: ChatCompletionResponse,
): AnthropicResponse {
  // Merge content from all choices
  const allTextBlocks: Array<AnthropicTextBlock> = []
  const allToolUseBlocks: Array<AnthropicToolUseBlock> = []
  let stopReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
    = null // default
  stopReason = response.choices[0]?.finish_reason ?? stopReason

  // Process all choices to extract text and tool use blocks
  for (const choice of response.choices) {
    const textBlocks = getAnthropicTextBlocks(choice.message.content)
    const toolUseBlocks = getAnthropicToolUseBlocks(choice.message.tool_calls)

    allTextBlocks.push(...textBlocks)
    allToolUseBlocks.push(...toolUseBlocks)

    // Use the finish_reason from the first choice, or prioritize tool_calls
    if (choice.finish_reason === 'tool_calls' || stopReason === 'stop') {
      stopReason = choice.finish_reason
    }
  }

  // Note: GitHub Copilot doesn't generate thinking blocks, so we don't include them in responses

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content: [...allTextBlocks, ...allToolUseBlocks],
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
  return toolCalls.map(toolCall => ({
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.function.name,
    input: JSON.parse(toolCall.function.arguments) as Record<string, unknown>,
  }))
}
