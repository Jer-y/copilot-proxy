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
  options?: {
    allowDocuments?: boolean
  },
): void {
  for (const message of payload.messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      assertSupportedUserContentBlock(block, options)
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
  options?: {
    allowDocuments?: boolean
  },
): void {
  if (isExternalImageUrl(block)) {
    throwAnthropicInvalidRequestError(
      'GitHub Copilot does not support external image URLs for Anthropic image blocks. Use base64 image data instead.',
    )
  }

  if (isFileDocument(block)) {
    throwAnthropicInvalidRequestError(
      'Files API (source.type=\'file\') is not supported by GitHub Copilot upstream. Upload document content directly using base64, text, or url source types instead.',
    )
  }

  if (isDocumentBlock(block) && options?.allowDocuments !== true) {
    throwAnthropicInvalidRequestError(
      'Unexpanded document block reached assertion layer (safety net). This is a bug — document blocks should have been expanded to text blocks before this point.',
    )
  }

  if (block.type === 'tool_result') {
    assertSupportedToolResultContent(block, options)
  }
}

function assertSupportedToolResultContent(
  block: AnthropicToolResultBlock,
  options?: {
    allowDocuments?: boolean
  },
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

    if (isFileDocument(contentBlock)) {
      throwAnthropicInvalidRequestError(
        'Files API (source.type=\'file\') is not supported by GitHub Copilot upstream. Upload document content directly using base64, text, or url source types instead.',
      )
    }

    if (isDocumentBlock(contentBlock) && options?.allowDocuments !== true) {
      throwAnthropicInvalidRequestError(
        'Unexpanded document block inside tool_result reached assertion layer (safety net). This is a bug — document blocks should have been expanded to text blocks before this point.',
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

function isFileDocument(
  block: AnthropicUserContentBlock | AnthropicTextBlock | AnthropicDocumentBlock,
): boolean {
  return block.type === 'document' && block.source.type === 'file'
}
