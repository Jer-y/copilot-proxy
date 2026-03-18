import type {
  AnthropicCacheControl,
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from './types'

import consola from 'consola'
import { JSONResponseError } from '~/lib/error'

interface CopilotCacheControl {
  type: 'ephemeral'
}

export function throwAnthropicInvalidRequestError(message: string): never {
  throw new JSONResponseError(message, 400, {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message,
    },
  })
}

export function assertCopilotCompatibleAnthropicRequest(
  payload: AnthropicMessagesPayload,
): void {
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      assertSupportedUserContentBlock(block)
    }
  }
}

export function mapAnthropicCacheControl(
  cacheControl: AnthropicCacheControl | undefined,
  context: string,
): CopilotCacheControl | undefined {
  if (!cacheControl) {
    return undefined
  }

  if (cacheControl.ttl) {
    logIgnoredAnthropicParameter(
      `${context}.cache_control.ttl`,
      'Copilot only supports ephemeral cache hints without a TTL override.',
    )
  }

  return { type: 'ephemeral' }
}

export function logIgnoredAnthropicParameter(
  parameter: string,
  reason: string,
): void {
  consola.debug(`Ignoring Anthropic ${parameter}: ${reason}`)
}

export function logLossyAnthropicCompatibility(
  feature: string,
  reason: string,
): void {
  consola.debug(`Anthropic compatibility gap for ${feature}: ${reason}`)
}

function assertSupportedUserContentBlock(
  block: AnthropicUserContentBlock,
): void {
  if (isExternalImageUrl(block)) {
    throwAnthropicInvalidRequestError(
      'GitHub Copilot does not support external image URLs for Anthropic image blocks. Use base64 image data instead.',
    )
  }

  if (isDocumentBlock(block)) {
    throwAnthropicInvalidRequestError(
      'GitHub Copilot does not support Anthropic document blocks yet. Extract the document text or convert the document into supported text/image inputs before sending it through the proxy.',
    )
  }

  if (block.type === 'tool_result') {
    assertSupportedToolResultContent(block)
  }
}

function assertSupportedToolResultContent(
  block: AnthropicToolResultBlock,
): void {
  if (!Array.isArray(block.content)) {
    return
  }

  for (const contentBlock of block.content) {
    if (isExternalImageUrl(contentBlock)) {
      throwAnthropicInvalidRequestError(
        'GitHub Copilot does not support external image URLs for Anthropic image blocks. Use base64 image data instead.',
      )
    }

    if (isDocumentBlock(contentBlock)) {
      throwAnthropicInvalidRequestError(
        'GitHub Copilot does not support document blocks inside Anthropic tool_result content yet. Return extracted text or supported image data instead.',
      )
    }
  }
}

function isExternalImageUrl(
  block: AnthropicUserContentBlock | AnthropicTextBlock | AnthropicDocumentBlock,
): boolean {
  return block.type === 'image' && block.source.type === 'url'
}

function isDocumentBlock(
  block: AnthropicUserContentBlock | AnthropicTextBlock | AnthropicDocumentBlock,
): block is AnthropicDocumentBlock {
  return block.type === 'document'
}
