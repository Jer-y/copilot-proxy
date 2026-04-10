/**
 * Shared utilities for protocol translation
 */

import type { AnthropicResponse } from './types'
import type { ContentPart, ImagePart, Message, TextPart } from '~/services/copilot/create-chat-completions'
import type {
  ResponsesMessageInputItem,
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesResponseError,
} from '~/services/copilot/create-responses'

import { JSONResponseError } from '~/lib/error'

type CCFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter'

type ResponsesMessageContentPart = NonNullable<Exclude<ResponsesMessageInputItem['content'], string>>[number]

/**
 * Map Responses API status + output content → CC finish_reason
 */
export function mapResponsesStatusToCCFinishReason(
  status: ResponsesResponse['status'],
  output: Array<ResponsesOutputItem>,
  incompleteDetails?: ResponsesResponse['incomplete_details'],
): CCFinishReason {
  if (status === 'failed') {
    throw new Error('Cannot map failed Responses status to chat-completions finish_reason')
  }

  if (status === 'incomplete') {
    if (incompleteDetails?.reason === 'content_filter') {
      return 'content_filter'
    }
    return 'length'
  }

  // Check if output contains function_call items
  const hasFunctionCall = output.some(item => item.type === 'function_call')
  if (hasFunctionCall) {
    return 'tool_calls'
  }

  return 'stop'
}

/**
 * Map CC finish_reason → Responses API status + incomplete_details
 */
export function mapCCFinishReasonToResponsesStatus(
  finishReason: CCFinishReason | null,
): {
  status: ResponsesResponse['status']
  incomplete_details?: { reason: string }
} {
  switch (finishReason) {
    case 'length':
      return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
    case 'content_filter':
      return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }
    case 'stop':
    case 'tool_calls':
    case null:
    default:
      return { status: 'completed' }
  }
}

/**
 * Map OpenAI/CC finish_reason → Anthropic stop_reason
 */
export function mapOpenAIStopReasonToAnthropic(
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null,
): AnthropicResponse['stop_reason'] {
  if (finishReason === null) {
    return null
  }
  const stopReasonMap = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'refusal',
  } as const
  return stopReasonMap[finishReason]
}

/**
 * Map Responses API status + output → Anthropic stop_reason
 */
export function mapResponsesStatusToAnthropicStopReason(
  status: ResponsesResponse['status'],
  output: Array<ResponsesOutputItem>,
  incompleteDetails?: ResponsesResponse['incomplete_details'],
): AnthropicResponse['stop_reason'] {
  if (status === 'failed') {
    throw new Error('Cannot map failed Responses status to Anthropic stop_reason')
  }

  if (status === 'incomplete') {
    if (incompleteDetails?.reason === 'content_filter') {
      return 'refusal'
    }
    if (incompleteDetails?.reason === 'max_output_tokens') {
      return 'max_tokens'
    }
    return 'pause_turn'
  }

  const hasFunctionCall = output.some(item => item.type === 'function_call')
  if (hasFunctionCall) {
    return 'tool_use'
  }

  return 'end_turn'
}

export function translateCCContentPartsToResponses(
  content: Message['content'],
  role: Message['role'],
): string | Array<ResponsesMessageContentPart> {
  if (typeof content === 'string') {
    return content
  }

  if (!content || content.length === 0) {
    return ''
  }

  return content.map((part) => {
    if (part.type === 'text') {
      return role === 'assistant'
        ? { type: 'output_text', text: part.text }
        : { type: 'input_text', text: part.text }
    }

    return {
      type: 'input_image',
      image_url: part.image_url.url,
      ...(part.image_url.detail && { detail: part.image_url.detail }),
    }
  })
}

export function translateResponsesContentPartsToCC(
  content: ResponsesMessageInputItem['content'],
  role: Message['role'],
): Message['content'] {
  if (typeof content === 'string') {
    return content
  }

  if (!content || content.length === 0) {
    return role === 'assistant' ? null : ''
  }

  const parts = content.flatMap(translateResponsesPartToCC)
  if (parts.length === 0) {
    return role === 'assistant' ? null : ''
  }

  const hasImage = parts.some(part => part.type === 'image_url')
  if (!hasImage && parts.every(part => part.type === 'text')) {
    return parts.map(part => (part as TextPart).text).join('')
  }

  return parts
}

function translateResponsesPartToCC(part: ResponsesMessageContentPart): Array<ContentPart> {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'text': {
      if (typeof part.text === 'string') {
        return [{ type: 'text', text: part.text } satisfies TextPart]
      }
      return []
    }

    case 'input_image': {
      const imageUrl = getResponsesImageUrl(part)
      if (!imageUrl) {
        return []
      }
      return [{
        type: 'image_url',
        image_url: imageUrl,
      } satisfies ImagePart]
    }

    case 'image_url': {
      const imageUrl = getResponsesImageUrl(part)
      if (!imageUrl) {
        return []
      }
      return [{
        type: 'image_url',
        image_url: imageUrl,
      } satisfies ImagePart]
    }

    default:
      return []
  }
}

function getResponsesImageUrl(part: ResponsesMessageContentPart): ImagePart['image_url'] | undefined {
  if (typeof part.image_url === 'string') {
    const detail = typeof part.detail === 'string' ? part.detail as ImagePart['image_url']['detail'] : undefined
    return {
      url: part.image_url,
      ...(detail && { detail }),
    }
  }

  if (part.image_url && typeof part.image_url === 'object' && 'url' in part.image_url && typeof part.image_url.url === 'string') {
    const obj = part.image_url as Record<string, unknown>
    const detail = typeof obj.detail === 'string' ? obj.detail as ImagePart['image_url']['detail'] : undefined
    return {
      url: part.image_url.url as string,
      ...(detail && { detail }),
    }
  }

  if (part.source && typeof part.source === 'object') {
    const source = part.source as Record<string, unknown>
    if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
      return {
        url: `data:${source.media_type};base64,${source.data}`,
      }
    }
  }

  return undefined
}

export function getResponsesErrorMessage(responseOrError: ResponsesResponse | ResponsesResponseError): string {
  if ('error' in responseOrError && responseOrError.error) {
    const err = responseOrError.error as ResponsesResponseError
    return err.message ?? 'Responses request failed'
  }

  if ('message' in responseOrError && typeof responseOrError.message === 'string') {
    return responseOrError.message
  }

  return 'Responses request failed'
}

export function createOpenAIErrorPayloadFromResponses(
  responseOrError: ResponsesResponse | ResponsesResponseError,
): {
  error: {
    message: string
    type: string
    code?: string
  }
} {
  let upstreamError: ResponsesResponseError | undefined | null
  if ('error' in responseOrError && responseOrError.error) {
    upstreamError = responseOrError.error as ResponsesResponseError
  }
  else if ('message' in responseOrError) {
    upstreamError = responseOrError as ResponsesResponseError
  }

  return {
    error: {
      message: getResponsesErrorMessage(responseOrError),
      type: upstreamError?.type ?? 'api_error',
      ...(upstreamError?.code && { code: upstreamError.code }),
    },
  }
}

export function createAnthropicErrorPayloadFromResponses(
  responseOrError: ResponsesResponse | ResponsesResponseError,
): {
  type: 'error'
  error: {
    type: string
    message: string
  }
} {
  return {
    type: 'error',
    error: {
      type: 'api_error',
      message: getResponsesErrorMessage(responseOrError),
    },
  }
}

export function throwOpenAIErrorFromFailedResponses(response: ResponsesResponse): never {
  throw new JSONResponseError(
    getResponsesErrorMessage(response),
    502,
    createOpenAIErrorPayloadFromResponses(response),
  )
}

export function throwAnthropicErrorFromFailedResponses(response: ResponsesResponse): never {
  throw new JSONResponseError(
    getResponsesErrorMessage(response),
    502,
    createAnthropicErrorPayloadFromResponses(response),
  )
}
