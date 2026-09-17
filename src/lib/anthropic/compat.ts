import type {
  AnthropicDocumentBlock,
  AnthropicMessagesPayload,
  AnthropicTextBlock,
  AnthropicToolResultBlock,
  AnthropicUserContentBlock,
} from './types'

import consola from 'consola'
import { JSONResponseError } from '~/lib/error'

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

  if (isDocumentBlock(block))
    assertSupportedDocumentBlock(block)

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

    if (isDocumentBlock(contentBlock))
      assertSupportedDocumentBlock(contentBlock)
  }
}

function assertSupportedDocumentBlock(
  block: AnthropicDocumentBlock,
): void {
  if (block.source.type === 'base64'
    && block.source.media_type.trim().toLowerCase() === 'application/pdf') {
    return
  }

  const sourceDescription = block.source.type === 'base64'
    ? `base64 ${block.source.media_type}`
    : block.source.type
  throwAnthropicInvalidRequestError(
    `Claude Code document compatibility supports only base64 application/pdf blocks; received ${sourceDescription}. Claude Code reads local text files into text or tool_result blocks, so the proxy does not implement text, content, URL, or Files API document adaptation.`,
  )
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
