import type { ResponsesStreamEvent } from '~/services/copilot/create-responses'

/** Minimal SSE chunk shape emitted by the Copilot Responses upstream stream. */
interface ResponsesSseChunk {
  event?: string
  data?: string | null
}

/**
 * Stabilizes per-item ids within a single `/responses` stream.
 *
 * GitHub Copilot emits a different opaque `id` on every SSE event for the same
 * streamed item (correlated only by `output_index`), which violates the OpenAI
 * `/responses` contract that item ids are stable within a response. This helper
 * pins the first-seen genuine upstream id for each `output_index` and rewrites
 * every later event's `id` / `item_id` on that index to the pinned value.
 *
 * Only item ids are touched. `encrypted_content`, `content`, `summary`, and
 * `call_id` are never modified. Create one normalizer per response.
 */
export function createResponsesItemIdNormalizer(): {
  rewrite: <T extends ResponsesSseChunk>(chunk: T) => T
} {
  const idByOutputIndex = new Map<number, string>()

  /** Record the first-seen id for an output_index; return the pinned id. */
  function stableId(outputIndex: number, seenId: string | undefined): string | undefined {
    if (typeof seenId === 'string' && seenId.length > 0 && !idByOutputIndex.has(outputIndex)) {
      idByOutputIndex.set(outputIndex, seenId)
    }
    return idByOutputIndex.get(outputIndex)
  }

  /** Mutate `event` in place; return true if any id changed. */
  function normalizeEvent(event: ResponsesStreamEvent): boolean {
    switch (event.type) {
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const stable = stableId(event.output_index, event.item.id)
        if (stable !== undefined && typeof event.item.id === 'string' && event.item.id !== stable) {
          event.item.id = stable
          return true
        }
        return false
      }
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_text.delta':
      case 'response.output_text.done':
      case 'response.function_call_arguments.delta': {
        const stable = stableId(event.output_index, event.item_id)
        if (stable !== undefined && typeof event.item_id === 'string' && event.item_id !== stable) {
          event.item_id = stable
          return true
        }
        return false
      }
      case 'response.function_call_arguments.done': {
        const stable = stableId(event.output_index, event.item_id)
        if (stable === undefined) {
          return false
        }
        let changed = false
        if (typeof event.item_id === 'string' && event.item_id !== stable) {
          event.item_id = stable
          changed = true
        }
        if (event.item && typeof event.item.id === 'string' && event.item.id !== stable) {
          event.item.id = stable
          changed = true
        }
        return changed
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        let changed = false
        event.response.output.forEach((item, index) => {
          const stable = stableId(index, item.id)
          if (stable !== undefined && typeof item.id === 'string' && item.id !== stable) {
            item.id = stable
            changed = true
          }
        })
        return changed
      }
      default:
        return false
    }
  }

  function rewrite<T extends ResponsesSseChunk>(chunk: T): T {
    const raw = chunk.data
    if (raw == null || raw.length === 0) {
      return chunk
    }
    try {
      const parsed = JSON.parse(raw) as ResponsesStreamEvent
      if (normalizeEvent(parsed)) {
        chunk.data = JSON.stringify(parsed)
      }
    }
    catch {
      // Malformed JSON or unexpected event shape: forward the chunk untouched.
    }
    return chunk
  }

  return { rewrite }
}
