import type { AnthropicMessagesPayload } from './types'
import type { ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import consola from 'consola'

function getAnthropicOutputFormatType(
  outputConfig: AnthropicMessagesPayload['output_config'],
): string | undefined {
  const format = outputConfig?.format
  return format && typeof format.type === 'string' ? format.type : undefined
}

export function mapAnthropicOutputFormatToChatCompletions(
  outputConfig: AnthropicMessagesPayload['output_config'],
): ChatCompletionsPayload['response_format'] | undefined {
  const formatType = getAnthropicOutputFormatType(outputConfig)

  if (formatType === 'json_object') {
    return { type: 'json_object' }
  }

  if (formatType) {
    consola.debug(`Ignoring Anthropic output_config.format.type=${formatType} on Chat Completions until Copilot support is validated.`)
  }

  return undefined
}

export function mapAnthropicOutputFormatToResponses(
  outputConfig: AnthropicMessagesPayload['output_config'],
): ResponsesPayload['text'] | undefined {
  const formatType = getAnthropicOutputFormatType(outputConfig)

  if (formatType === 'json_object') {
    return { format: { type: 'json_object' } }
  }

  if (formatType) {
    consola.debug(`Ignoring Anthropic output_config.format.type=${formatType} on Responses until Copilot support is validated.`)
  }

  return undefined
}
