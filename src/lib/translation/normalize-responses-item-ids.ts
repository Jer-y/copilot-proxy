/** Minimal SSE chunk shape emitted by the Copilot Responses upstream stream. */
interface ResponsesSseChunk {
  event?: string
  data?: string | null
}

/**
 * Loose structural view of a parsed Responses event. The upstream stream
 * carries event types beyond the curated `ResponsesStreamEvent` union — notably
 * the `response.reasoning_summary_*` family — so normalization keys off
 * structural fields (`output_index`, `item_id`, `item.id`, and the terminal
 * `response.output[]`) rather than a discriminated `type`.
 */
interface NormalizableEvent {
  output_index?: number
  item_id?: unknown
  item?: { id?: unknown } | null
  response?: { output?: Array<{ id?: unknown }> } | null
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
 * Normalization is structural — any event carrying a numeric `output_index`, or
 * a terminal `response.output[]` snapshot — so it covers reasoning, message,
 * function-call, and reasoning-summary items alike, plus any future id-bearing
 * event type. Only item ids are touched: `encrypted_content`, `content`,
 * `summary`, `summary_index`, and `call_id` are never modified. Create one
 * normalizer per response.
 */
export function createResponsesItemIdNormalizer(): {
  rewrite: <T extends ResponsesSseChunk>(chunk: T) => T
} {
  const idByOutputIndex = new Map<number, string>()

  /** Record the first-seen id for an output_index; return the pinned id. */
  function stableId(outputIndex: number, seenId: unknown): string | undefined {
    if (typeof seenId === 'string' && seenId.length > 0 && !idByOutputIndex.has(outputIndex)) {
      idByOutputIndex.set(outputIndex, seenId)
    }
    return idByOutputIndex.get(outputIndex)
  }

  /** Mutate `event` in place; return true if any id changed. */
  function normalizeEvent(event: NormalizableEvent): boolean {
    let changed = false

    // Rule A — per-item events correlate to their item via a top-level
    // `output_index`. Pin the first-seen id for that index (in practice the
    // `output_item.added` id, which is also the id id-keyed clients store), then
    // overwrite `item.id` and/or `item_id` on every later event for the index.
    // This is structural, not an event-type allowlist, so the churning
    // `reasoning_summary_*` events — and any future id-bearing event — are
    // covered.
    if (typeof event.output_index === 'number') {
      let seen: string | undefined
      if (typeof event.item?.id === 'string') {
        seen = event.item.id
      }
      else if (typeof event.item_id === 'string') {
        seen = event.item_id
      }
      const stable = stableId(event.output_index, seen)
      if (stable !== undefined) {
        if (event.item && typeof event.item.id === 'string' && event.item.id !== stable) {
          event.item.id = stable
          changed = true
        }
        if (typeof event.item_id === 'string' && event.item_id !== stable) {
          event.item_id = stable
          changed = true
        }
      }
    }

    // Rule B — terminal snapshots (`response.completed`/`.incomplete`/`.failed`)
    // carry no top-level `output_index`, so correlate each `output[]` entry by
    // its array index, relying on the OpenAI ordering guarantee that `output[i]`
    // corresponds to `output_index === i`. Streaming events run first, so this
    // usually just applies an already-pinned id to the assembled snapshot.
    const output = event.response?.output
    if (Array.isArray(output)) {
      output.forEach((item, index) => {
        const stable = stableId(index, item.id)
        if (stable !== undefined && typeof item.id === 'string' && item.id !== stable) {
          item.id = stable
          changed = true
        }
      })
    }

    return changed
  }

  function rewrite<T extends ResponsesSseChunk>(chunk: T): T {
    const raw = chunk.data
    if (raw == null || raw.length === 0) {
      return chunk
    }
    try {
      const parsed = JSON.parse(raw) as NormalizableEvent
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
