import type { AnthropicMessagesPayload } from './types'
import type { ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload } from '~/services/copilot/create-responses'

function getAnthropicOutputFormatType(
  outputConfig: AnthropicMessagesPayload['output_config'],
): string | undefined {
  const format = outputConfig?.format
  return format && typeof format.type === 'string' ? format.type : undefined
}

export function mapAnthropicOutputFormatToChatCompletions(
  outputConfig: AnthropicMessagesPayload['output_config'],
): ChatCompletionsPayload['response_format'] | undefined {
  if (getAnthropicOutputFormatType(outputConfig) === 'json_object') {
    return { type: 'json_object' }
  }

  return undefined
}

export function mapAnthropicOutputFormatToResponses(
  outputConfig: AnthropicMessagesPayload['output_config'],
): ResponsesPayload['text'] | undefined {
  if (getAnthropicOutputFormatType(outputConfig) === 'json_object') {
    return { format: { type: 'json_object' } }
  }

  // Keep schema-like formats as a no-op until Copilot support is validated.
  return undefined
}
