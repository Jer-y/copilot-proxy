import type { ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload } from '~/services/copilot/create-responses'

import { JSONResponseError } from '~/lib/error'

export const OPENAI_EXTERNAL_IMAGE_URLS_UNSUPPORTED_MESSAGE
  = 'GitHub Copilot does not support external image URLs for OpenAI-compatible image inputs. Use base64 image data instead.'

export function throwOpenAIInvalidRequestError(message: string): never {
  throw new JSONResponseError(message, 400, {
    error: {
      type: 'invalid_request_error',
      message,
    },
  })
}

export function chatCompletionsHasExternalImageUrls(
  payload: ChatCompletionsPayload,
): boolean {
  for (const message of payload.messages) {
    if (!Array.isArray(message.content)) {
      continue
    }

    for (const part of message.content) {
      if (part.type !== 'image_url') {
        continue
      }

      const imageUrl = getImageUrlValue(part.image_url)
      if (imageUrl && !imageUrl.startsWith('data:')) {
        return true
      }
    }
  }

  return false
}

export function responsesHasExternalImageUrls(
  payload: ResponsesPayload,
): boolean {
  if (typeof payload.input === 'string' || !Array.isArray(payload.input)) {
    return false
  }

  for (const item of payload.input) {
    if (
      typeof item === 'object'
      && item !== null
      && 'type' in item
      && (item.type === 'input_image' || item.type === 'image_url')
    ) {
      const imageUrl = getImageUrlValue(item.image_url)
      if (imageUrl && !imageUrl.startsWith('data:')) {
        return true
      }
    }

    if (!('content' in item) || !Array.isArray(item.content)) {
      continue
    }

    for (const part of item.content) {
      if (part.type !== 'input_image' && part.type !== 'image_url') {
        continue
      }

      const imageUrl = getImageUrlValue(part.image_url)
      if (imageUrl && !imageUrl.startsWith('data:')) {
        return true
      }
    }
  }

  return false
}

function getImageUrlValue(imageUrl: unknown): string | undefined {
  if (typeof imageUrl === 'string') {
    return imageUrl
  }

  if (imageUrl && typeof imageUrl === 'object') {
    const imageUrlRecord = imageUrl as Record<string, unknown>
    if (typeof imageUrlRecord.url === 'string') {
      return imageUrlRecord.url
    }
  }

  return undefined
}
