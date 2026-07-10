import type { AnthropicMessagesPayload } from './types'
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import { isRecord } from '~/lib/type-guards'
import { throwAnthropicInvalidRequestError } from './anthropic-compat'

function getAnthropicOutputFormatType(
  outputConfig: AnthropicMessagesPayload['output_config'],
): string | undefined {
  const format = outputConfig?.format
  return format && typeof format.type === 'string' ? format.type : undefined
}

interface NormalizedJsonSchemaFormat {
  name: string
  schema: Record<string, unknown>
  strict?: boolean
}

function normalizeAnthropicJsonSchemaFormat(
  outputConfig: AnthropicMessagesPayload['output_config'],
): NormalizedJsonSchemaFormat {
  const format = outputConfig?.format
  if (!isRecord(format)) {
    throwAnthropicInvalidRequestError(
      'Anthropic output_config.format.type="json_schema" requires an object "schema".',
    )
  }

  const nestedJsonSchema = isRecord(format.json_schema)
    ? format.json_schema
    : undefined
  const hasFlatSchema = isRecord(format.schema)
  const hasNestedSchema = isRecord(nestedJsonSchema?.schema)
  if (hasFlatSchema && hasNestedSchema) {
    throwAnthropicInvalidRequestError(
      'Anthropic output_config.format for json_schema must use either flat "schema" or legacy "json_schema.schema", not both.',
    )
  }

  const schema = hasNestedSchema ? nestedJsonSchema.schema : format.schema
  if (!isRecord(schema)) {
    throwAnthropicInvalidRequestError(
      'Anthropic output_config.format.type="json_schema" requires an object "schema".',
    )
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

export function mapAnthropicOutputFormatToResponses(
  outputConfig: AnthropicMessagesPayload['output_config'],
): ResponsesPayload['text'] | undefined {
  const formatType = getAnthropicOutputFormatType(outputConfig)

  if (formatType === 'json_object') {
    return { format: { type: 'json_object' } }
  }

  if (formatType === 'json_schema') {
    const normalized = normalizeAnthropicJsonSchemaFormat(outputConfig)
    return {
      format: {
        type: 'json_schema',
        name: normalized.name,
        schema: normalized.schema,
        ...(typeof normalized.strict === 'boolean' && { strict: normalized.strict }),
      },
    }
  }

  if (formatType) {
    throwAnthropicInvalidRequestError(
      `Anthropic output_config.format.type="${formatType}" cannot be represented on the Responses translation path.`,
    )
  }

  return undefined
}
