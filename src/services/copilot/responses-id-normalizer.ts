import type { ServerSentEventMessage } from 'fetch-event-stream'

interface ResponsesIdAliasEntry {
  expiresAt: number
  upstreamId: string
}

export interface ResponsesIdNormalizationOptions {
  clientPreviousResponseId?: string
}

export interface CopilotResponsesItemIdNormalizer {
  normalize: (event: Record<string, unknown>) => Record<string, unknown>
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
 * Copilot currently emits a different opaque item ID for successive events
 * that share one Responses output_index. Keep the first ID for each output
 * item so the client-facing stream follows the OpenAI Responses contract.
 */
export function createCopilotResponsesItemIdNormalizer(): CopilotResponsesItemIdNormalizer {
  const stableIds = new Map<number, string>()

  return {
    normalize(event) {
      let normalizedEvent = event
      const outputIndex = readOutputIndex(event.output_index)

      if (outputIndex !== undefined) {
        const item = isRecord(event.item) ? event.item : undefined
        const nestedItemId = readItemId(item?.id)
        const eventItemId = readItemId(event.item_id)
        const candidateId = nestedItemId ?? eventItemId

        if (candidateId !== undefined) {
          const stableId = stableIds.get(outputIndex) ?? candidateId
          stableIds.set(outputIndex, stableId)

          const normalizedItem = item && nestedItemId !== undefined && nestedItemId !== stableId
            ? { ...item, id: stableId }
            : item
          if (
            normalizedItem !== item
            || (eventItemId !== undefined && eventItemId !== stableId)
          ) {
            normalizedEvent = {
              ...normalizedEvent,
              ...(normalizedItem !== item && { item: normalizedItem }),
              ...(eventItemId !== undefined && eventItemId !== stableId && { item_id: stableId }),
            }
          }
        }
      }

      const response = isRecord(normalizedEvent.response)
        ? normalizedEvent.response
        : undefined
      if (!response || !Array.isArray(response.output))
        return normalizedEvent

      let outputChanged = false
      const normalizedOutput = response.output.map((item, index) => {
        if (!isRecord(item))
          return item
        const itemId = readItemId(item.id)
        if (itemId === undefined)
          return item

        const stableId = stableIds.get(index) ?? itemId
        stableIds.set(index, stableId)
        if (itemId === stableId)
          return item

        outputChanged = true
        return { ...item, id: stableId }
      })

      if (!outputChanged)
        return normalizedEvent

      return {
        ...normalizedEvent,
        response: {
          ...response,
          output: normalizedOutput,
        },
      }
    },
  }
}

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
  const itemIdNormalizer = createCopilotResponsesItemIdNormalizer()

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

    const normalizedItemEvent = itemIdNormalizer.normalize(event)
    const eventType = typeof normalizedItemEvent.type === 'string'
      ? normalizedItemEvent.type
      : message.event
    const response = isRecord(normalizedItemEvent.response) ? normalizedItemEvent.response : undefined
    const upstreamResponseId = typeof response?.id === 'string'
      ? response.id
      : undefined

    if (
      !eventType
      || !RESPONSE_LIFECYCLE_EVENTS.has(eventType)
      || !response
      || !upstreamResponseId
    ) {
      yield normalizedItemEvent === event
        ? message
        : { ...message, data: JSON.stringify(normalizedItemEvent) }
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
      yield normalizedItemEvent === event
        ? message
        : { ...message, data: JSON.stringify(normalizedItemEvent) }
      continue
    }

    yield {
      ...message,
      data: JSON.stringify({
        ...normalizedItemEvent,
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

function readItemId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readOutputIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}
