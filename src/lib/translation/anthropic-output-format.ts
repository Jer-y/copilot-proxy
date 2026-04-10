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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

interface NormalizedJsonSchemaFormat {
  name: string
  schema: Record<string, unknown>
  strict?: boolean
}

function normalizeAnthropicJsonSchemaFormat(
  outputConfig: AnthropicMessagesPayload['output_config'],
): NormalizedJsonSchemaFormat | undefined {
  const format = outputConfig?.format
  if (!isRecord(format)) {
    return undefined
  }

  const nestedJsonSchema = isRecord(format.json_schema)
    ? format.json_schema
    : undefined
  const schema = nestedJsonSchema?.schema ?? format.schema
  if (!isRecord(schema)) {
    return undefined
  }

  const rawName = nestedJsonSchema?.name ?? format.name
  const name = typeof rawName === 'string' && rawName.trim().length > 0
    ? rawName
    : 'response'

  const rawStrict = nestedJsonSchema?.strict ?? format.strict
  return {
    name,
    schema,
    ...(typeof rawStrict === 'boolean' && { strict: rawStrict }),
  }
}

export function mapAnthropicOutputFormatToChatCompletions(
  outputConfig: AnthropicMessagesPayload['output_config'],
): ChatCompletionsPayload['response_format'] | undefined {
  const formatType = getAnthropicOutputFormatType(outputConfig)

  if (formatType === 'json_object') {
    return { type: 'json_object' }
  }

  if (formatType === 'json_schema') {
    const normalized = normalizeAnthropicJsonSchemaFormat(outputConfig)
    if (normalized) {
      return {
        type: 'json_schema',
        json_schema: {
          name: normalized.name,
          strict: normalized.strict ?? true,
          schema: normalized.schema,
        },
      }
    }
  }

  if (formatType) {
    consola.debug(`Ignoring Anthropic output_config.format.type=${formatType} on Chat Completions — unsupported format type.`)
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

  if (formatType === 'json_schema') {
    const normalized = normalizeAnthropicJsonSchemaFormat(outputConfig)
    if (normalized) {
      return {
        format: {
          type: 'json_schema',
          name: normalized.name,
          schema: normalized.schema,
          ...(typeof normalized.strict === 'boolean' && { strict: normalized.strict }),
        },
      }
    }
  }

  if (formatType) {
    consola.debug(`Ignoring Anthropic output_config.format.type=${formatType} on Responses — unsupported format type.`)
  }

  return undefined
}
