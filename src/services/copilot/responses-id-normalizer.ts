import type { ServerSentEventMessage } from 'fetch-event-stream'

interface ResponsesIdAliasEntry {
  expiresAt: number
  upstreamId: string
}

export interface ResponsesIdNormalizationOptions {
  clientPreviousResponseId?: string
}

const RESPONSE_ID_ALIAS_TTL_MS = 65 * 60 * 1000
const RESPONSE_ID_ALIAS_MAX_ENTRIES = 1024
const RESPONSE_LIFECYCLE_EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.incomplete',
])
const RESPONSE_TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
])
const responseIdAliases = new Map<string, ResponsesIdAliasEntry>()

/**
 * Resolve the stable client-facing ID emitted by a prior streaming response to
 * the terminal opaque ID expected by Copilot. Aliases are deliberately
 * in-memory and bounded: Copilot's current continuation state is transport
 * local, and response IDs must not be persisted as proxy metadata.
 */
export function resolveCopilotResponseIdAlias(
  responseId: string,
  now = Date.now(),
): string {
  pruneExpiredAliases(now)
  const entry = responseIdAliases.get(responseId)
  if (!entry)
    return responseId

  // Refresh insertion order so actively chained responses are not evicted
  // ahead of older aliases when the bounded registry reaches capacity.
  responseIdAliases.delete(responseId)
  responseIdAliases.set(responseId, entry)
  return entry.upstreamId
}

/**
 * Normalize Copilot's event-local lifecycle IDs into one stable Response ID.
 * The terminal upstream ID is retained in a bounded alias registry so a later
 * previous_response_id can be translated back before forwarding to Copilot.
 */
export async function* normalizeCopilotResponsesEventStream(
  source: AsyncIterable<ServerSentEventMessage>,
  options: ResponsesIdNormalizationOptions = {},
): AsyncIterable<ServerSentEventMessage> {
  let publicResponseId: string | undefined

  for await (const message of source) {
    if (typeof message.data !== 'string' || message.data === '[DONE]') {
      yield message
      continue
    }

    let event: Record<string, unknown>
    try {
      const parsed = JSON.parse(message.data) as unknown
      if (!isRecord(parsed)) {
        yield message
        continue
      }
      event = parsed
    }
    catch {
      yield message
      continue
    }

    const eventType = typeof event.type === 'string'
      ? event.type
      : message.event
    const response = isRecord(event.response) ? event.response : undefined
    const upstreamResponseId = typeof response?.id === 'string'
      ? response.id
      : undefined

    if (
      !eventType
      || !RESPONSE_LIFECYCLE_EVENTS.has(eventType)
      || !response
      || !upstreamResponseId
    ) {
      yield message
      continue
    }

    publicResponseId ??= upstreamResponseId
    if (RESPONSE_TERMINAL_EVENTS.has(eventType))
      rememberResponseIdAlias(publicResponseId, upstreamResponseId)

    const upstreamPreviousResponseId = typeof response.previous_response_id === 'string'
      ? response.previous_response_id
      : undefined
    const normalizedPreviousResponseId = options.clientPreviousResponseId
      && upstreamPreviousResponseId !== undefined
      ? options.clientPreviousResponseId
      : upstreamPreviousResponseId

    if (
      upstreamResponseId === publicResponseId
      && normalizedPreviousResponseId === upstreamPreviousResponseId
    ) {
      yield message
      continue
    }

    yield {
      ...message,
      data: JSON.stringify({
        ...event,
        response: {
          ...response,
          id: publicResponseId,
          ...(normalizedPreviousResponseId !== undefined && {
            previous_response_id: normalizedPreviousResponseId,
          }),
        },
      }),
    }
  }
}

export function resetCopilotResponseIdAliasesForTests(): void {
  responseIdAliases.clear()
}

function rememberResponseIdAlias(
  publicResponseId: string,
  upstreamResponseId: string,
  now = Date.now(),
): void {
  pruneExpiredAliases(now)
  responseIdAliases.delete(publicResponseId)
  responseIdAliases.set(publicResponseId, {
    expiresAt: now + RESPONSE_ID_ALIAS_TTL_MS,
    upstreamId: upstreamResponseId,
  })

  while (responseIdAliases.size > RESPONSE_ID_ALIAS_MAX_ENTRIES) {
    const oldestKey = responseIdAliases.keys().next().value
    if (oldestKey === undefined)
      break
    responseIdAliases.delete(oldestKey)
  }
}

function pruneExpiredAliases(now: number): void {
  for (const [publicResponseId, entry] of responseIdAliases) {
    if (entry.expiresAt <= now)
      responseIdAliases.delete(publicResponseId)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
