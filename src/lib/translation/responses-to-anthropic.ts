/**
 * Responses API → Anthropic response translation (T8)
 */

import type {
  AnthropicAssistantContentBlock,
  AnthropicResponse,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
} from './types'
import type {
  ResponsesOutputItem,
  ResponsesResponse,
} from '~/services/copilot/create-responses'

import consola from 'consola'
import { logLossyAnthropicCompatibility } from './anthropic-compat'
import {
  mapResponsesStatusToAnthropicStopReason,
  throwAnthropicErrorFromFailedResponses,
} from './utils'

export function translateResponsesResponseToAnthropic(
  response: ResponsesResponse,
): AnthropicResponse {
  if (response.status === 'failed') {
    throwAnthropicErrorFromFailedResponses(response)
  }

  const content = extractAnthropicContent(response.output)
  const stopReason = mapResponsesStatusToAnthropicStopReason(
    response.status,
    response.output,
    response.incomplete_details,
  )

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    model: response.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      ...(response.usage?.input_tokens_details?.cached_tokens !== undefined && {
        cache_read_input_tokens: response.usage.input_tokens_details.cached_tokens,
      }),
    },
  }
}

function extractAnthropicContent(
  output: Array<ResponsesOutputItem>,
): Array<AnthropicAssistantContentBlock> {
  const content: Array<AnthropicAssistantContentBlock> = []
  let omittedReasoningSummary = false

  for (const item of output) {
    switch (item.type) {
      case 'message': {
        if (item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) {
              content.push({
                type: 'text',
                text: part.text,
              } as AnthropicTextBlock)
            }
          }
        }
        break
      }

      case 'function_call': {
        if (item.call_id && item.name) {
          let parsedInput: Record<string, unknown>
          try {
            parsedInput = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>
          }
          catch {
            consola.warn('Failed to parse function_call arguments:', item.arguments)
            parsedInput = {}
          }

          content.push({
            type: 'tool_use',
            id: item.call_id,
            name: item.name,
            input: parsedInput,
          } as AnthropicToolUseBlock)
        }
        break
      }

      case 'reasoning': {
        if (item.summary) {
          for (const summary of item.summary) {
            if (
              summary.type === 'summary_text'
              && summary.text
              && !omittedReasoningSummary
            ) {
              logLossyAnthropicCompatibility(
                'responses reasoning summaries',
                'Responses reasoning summaries are advisory text without Anthropic thinking signatures, so they are omitted instead of being replayed as unsigned thinking blocks.',
              )
              omittedReasoningSummary = true
            }
          }
        }
        break
      }
      // No default
    }
  }

  return content
}
