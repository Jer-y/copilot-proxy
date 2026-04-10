// Anthropic API Types

export interface AnthropicCacheControl {
  type: 'ephemeral'
  ttl?: string
}

export interface AnthropicMessagesPayload {
  model: string
  messages: Array<AnthropicMessage>
  max_tokens?: number
  system?: string | Array<AnthropicTextBlock>
  cache_control?: AnthropicCacheControl
  metadata?: {
    user_id?: string
  }
  stop_sequences?: Array<string>
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  tools?: Array<AnthropicTool>
  tool_choice?: {
    type: 'auto' | 'any' | 'tool' | 'none'
    name?: string
    disable_parallel_tool_use?: boolean
  }
  thinking?:
    | {
      type: 'enabled'
      budget_tokens?: number
    }
    | {
      type: 'adaptive'
      display?: 'summarized' | 'omitted' | null
    }
    | {
      type: 'disabled'
    }
  output_config?: {
    effort?: 'low' | 'medium' | 'high' | 'max'
    format?: AnthropicOutputConfigFormat
  }
  service_tier?: 'auto' | 'standard_only'
  speed?: 'fast' | 'normal'
}

export interface AnthropicOutputConfigJsonSchemaFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
  name?: string
}

export interface AnthropicOutputConfigJsonObjectFormat {
  type: 'json_object'
}

export type AnthropicOutputConfigFormat
  = | AnthropicOutputConfigJsonSchemaFormat
    | AnthropicOutputConfigJsonObjectFormat
    | Record<string, unknown>

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  citations?: Array<Record<string, unknown>>
  cache_control?: AnthropicCacheControl
}

export interface AnthropicImageBlock {
  type: 'image'
  source:
    | {
      type: 'base64'
      media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      data: string
    }
    | {
      type: 'url'
      url: string
    }
  cache_control?: AnthropicCacheControl
}

export interface AnthropicDocumentBlock {
  type: 'document'
  source:
    | {
      type: 'base64'
      media_type: string
      data: string
    }
    | {
      type: 'url'
      url: string
    }
    | {
      type: 'text'
      media_type: string
      text: string
    }
    | {
      type: 'content'
      content: Array<AnthropicTextBlock>
    }
    | {
      type: 'file'
      file_id: string
    }
  title?: string
  context?: string
  citations?: {
    enabled: boolean
  }
  cache_control?: AnthropicCacheControl
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<AnthropicTextBlock | AnthropicImageBlock | AnthropicDocumentBlock>
  is_error?: boolean
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export type AnthropicUserContentBlock
  = | AnthropicTextBlock
    | AnthropicImageBlock
    | AnthropicDocumentBlock
    | AnthropicToolResultBlock

export type AnthropicAssistantContentBlock
  = | AnthropicTextBlock
    | AnthropicToolUseBlock
    | AnthropicThinkingBlock
    | AnthropicRedactedThinkingBlock

export interface AnthropicUserMessage {
  role: 'user'
  content: string | Array<AnthropicUserContentBlock>
}

export interface AnthropicAssistantMessage {
  role: 'assistant'
  content: string | Array<AnthropicAssistantContentBlock>
}

export type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
  strict?: boolean
  cache_control?: AnthropicCacheControl
}

export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: Array<AnthropicAssistantContentBlock>
  model: string
  stop_reason:
    | 'end_turn'
    | 'max_tokens'
    | 'stop_sequence'
    | 'tool_use'
    | 'pause_turn'
    | 'refusal'
    | null
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: 'standard' | 'priority' | 'batch'
  }
}

export type AnthropicResponseContentBlock = AnthropicAssistantContentBlock

// Anthropic Stream Event Types
export interface AnthropicMessageStartEvent {
  type: 'message_start'
  message: Omit<
    AnthropicResponse,
    'content' | 'stop_reason' | 'stop_sequence'
  > & {
    content: []
    stop_reason: null
    stop_sequence: null
  }
}

export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block:
    | { type: 'text', text: string }
    | (Omit<AnthropicToolUseBlock, 'input'> & {
      input: Record<string, unknown>
    })
    | { type: 'thinking', thinking: string, signature?: string }
}

export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta:
    | { type: 'text_delta', text: string }
    | { type: 'input_json_delta', partial_json: string }
    | { type: 'thinking_delta', thinking: string }
    | { type: 'signature_delta', signature: string }
}

export interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: 'message_delta'
  delta: {
    stop_reason?: AnthropicResponse['stop_reason']
    stop_sequence?: string | null
  }
  usage?: {
    input_tokens?: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export interface AnthropicMessageStopEvent {
  type: 'message_stop'
}

export interface AnthropicPingEvent {
  type: 'ping'
}

export interface AnthropicErrorEvent {
  type: 'error'
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEventData
  = | AnthropicMessageStartEvent
    | AnthropicContentBlockStartEvent
    | AnthropicContentBlockDeltaEvent
    | AnthropicContentBlockStopEvent
    | AnthropicMessageDeltaEvent
    | AnthropicMessageStopEvent
    | AnthropicPingEvent
    | AnthropicErrorEvent

// State for streaming translation
export interface AnthropicStreamState {
  messageStartSent: boolean
  messageStopSent: boolean
  contentBlockIndex: number
  contentBlockOpen: boolean
  currentBlockType: 'text' | 'thinking' | 'tool_use' | null
  thinkingSignature: string | null
  pendingLeadingText: string
  hasThinkingContent: boolean
  hasNonThinkingContent: boolean
  toolCalls: {
    [openAIToolIndex: number]: {
      id: string
      name: string
      anthropicBlockIndex: number
    }
  }
  /** When set, overrides the upstream model name in translated responses. */
  requestedModel?: string
}

// State for Anthropic → Responses streaming translation (T12)
export interface AnthropicToResponsesStreamState {
  responseId: string
  model: string
  createdSent: boolean
  nextOutputIndex: number
  /** Current Anthropic content block type (needed because content_block_stop has no type info) */
  currentBlockType: 'text' | 'thinking' | 'tool_use' | 'redacted_thinking' | null
  currentBlockIndex: number
  /** Output index of the current open message item */
  messageOutputIndex: number | undefined
  messageItemOpen: boolean
  messageParts: Array<{ type: 'output_text', text: string }>
  /** Text accumulated for the current streaming text part */
  currentPartText: string
  contentPartIndex: number
  /** Tracks Anthropic content block index → tool call state */
  toolCalls: Map<number, {
    outputIndex: number
    callId: string
    name: string
    arguments: string
  }>
  /** Accumulated thinking text for current thinking block */
  currentThinkingText: string
  /** Accumulated completed output items for the final response.completed payload */
  completedOutputItems: Array<Record<string, unknown>>
  stopReason: string | undefined
  inputTokens: number
  outputTokens: number
}
