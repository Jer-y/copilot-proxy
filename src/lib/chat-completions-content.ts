import type { ChatCompletionsPayload, ContentPart, Message } from '~/services/copilot/create-chat-completions'

/**
 * Some OpenAI-compatible clients (e.g. WorkBuddy custom models) serialize a
 * message's `content` as a single content-part *object*
 * (`{ type: 'text', text: '...' }`) instead of the spec-required string or
 * array of parts. The upstream Copilot `/chat/completions` endpoint only
 * accepts `content` as a string or an array, so such requests fail schema
 * validation with `messages.N.content: Invalid input`.
 *
 * Normalize those shapes to what the upstream expects. The transformation only
 * changes structure, never semantics:
 *  - `{ type: 'text', text }` -> the plain string `text`
 *  - any other single object   -> wrapped as a one-element array `[object]`
 * Strings, arrays, and `null` are returned unchanged.
 */
export function normalizeChatCompletionContent(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const messages = payload.messages.map(normalizeMessageContent)
  return { ...payload, messages }
}

function normalizeMessageContent(message: Message): Message {
  const content = message.content as unknown

  if (content === null || typeof content === 'string' || Array.isArray(content))
    return message

  if (typeof content === 'object' && content !== null) {
    const part = content as Record<string, unknown>
    if (part.type === 'text' && typeof part.text === 'string')
      return { ...message, content: part.text }
    return { ...message, content: [content as unknown as ContentPart] }
  }

  return message
}
