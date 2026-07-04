# Generalize `/responses` item-id normalization to cover reasoning-summary events

**Date:** 2026-07-04
**Status:** Proposed — awaiting review
**Scope:** `src/lib/translation/normalize-responses-item-ids.ts` (rewrite the transform) + extend `tests/responses-passthrough-item-ids.test.ts`. No handler, config, or wiring changes.
**Builds on:** `docs/superpowers/specs/2026-07-03-stabilize-responses-item-ids-design.md` (the original id-normalization work, now shipped on this branch behind the `normalizeOpenAIResponsesItemIds` flag).

## Problem

The shipped normalizer stabilizes item ids on an **allowlist** of event types: `response.output_item.*`, `response.content_part.*`, `response.output_text.*`, `response.function_call_arguments.*`, and the terminal `response.completed/.incomplete/.failed` `output[]`. It fixed the trivial case (a "who are you?" prompt streams cleanly).

A real reasoning prompt still crashes the client with a **different** error:

```
reasoning part <408-char-id>:0 not found
```

### Root cause (verified against live upstream + the AI SDK source)

`HANDOFF.md` §2 asserted that Copilot "sends no `reasoning_summary_*` events even when `summary:"auto"`/`"detailed"` is requested." **That is false** — it was only true for the trivial "pong" prompt used to capture the table. A reasoning prompt (`gpt-5.4`, `effort:high`, `summary:detailed`) makes Copilot emit the full reasoning-summary event family:

| event | id field | churns per event? |
|---|---|---|
| `response.reasoning_summary_part.added` / `.done` | `item_id` | **yes** — distinct 408-char id each |
| `response.reasoning_summary_text.delta` / `.done` | `item_id` | **yes** — distinct 408-char id each |

None of these ids equals the reasoning item's real id from `response.output_item.added`, and **the shipped normalizer does not touch any of them** — they are not in its allowlist (nor in the `ResponsesStreamEvent` union). So the churn survives.

Why it crashes the Vercel AI SDK: `@ai-sdk/openai` keys reasoning state as `activeReasoning[item_id]` and derives each reasoning part id as `${item_id}:${summary_index}`. Real OpenAI keeps `item_id` **constant** across the reasoning item and all its summary events (confirmed via vercel/ai's own `openai-reasoning-encrypted-content` fixture — all equal one `rs_…`). The reasoning-start is registered from `output_item.added` (id `A1:0`); the first summary delta references a churned `item_id` (`A3:0`); the lookup misses, and the `ai` package's `stream-text.ts` emits `` `reasoning part ${part.id} not found` ``. The `:0` the user saw is `summary_index: 0` — it fails on the very first summary delta.

This is the **same failure mode** as the original `summaryParts` crash: Copilot churns the opaque id on every per-item event, and any event type the normalizer forgets to cover stays broken. The allowlist has now missed the culprit twice.

> Note on the earlier "output_item ids look stable" observation: that was captured through `copilot.ningw.net`, which already runs this branch's normalizer with the flag on. Upstream Copilot churns `output_item.*` ids too (HANDOFF §2's `added ≠ done` table was correct). The capture shows the fix working for its covered events and failing only on the uncovered summary events.

## Decision

**Replace the event-type allowlist with a generic transform**, keyed on the structural invariant that already holds across the entire stream: within one response, an item is identified by its `output_index`, and every event that refers to that item carries either a top-level `output_index` (per-item events) or lives at a known array position in a terminal `output[]` snapshot.

Rationale: the root cause *is* the allowlist. Lengthening it to four more cases fixes this symptom but leaves the identical latent gap for the next id-bearing event type Copilot adds (`reasoning_text.*`, `refusal.*`, annotation events, …). Removing the allowlist removes the failure class. This stays within the original spec's framing — we still keep a **genuine upstream id** and only make it consistent per `output_index`; we do not mint synthetic ids.

## Approach: two correlation rules, first-seen id per `output_index`

The normalizer keeps its per-response `Map<number /* output_index */, string /* id */>` and its first-seen-wins pinning. The `rewrite` entry point, per-response scoping, JSON parse/re-stringify, and malformed-chunk passthrough are unchanged. Only `normalizeEvent` changes — from a `switch` over named event types to two structural rules:

```
normalizeEvent(event):
  changed = false

  // Rule A — per-item events: correlate by the explicit output_index field.
  if (typeof event.output_index === 'number'):
      seen   = (typeof event.item?.id === 'string' ? event.item.id : undefined)
             ?? (typeof event.item_id === 'string' ? event.item_id : undefined)
      stable = pin(event.output_index, seen)          // first-seen wins
      if stable !== undefined:
          if event.item?.id is a mismatched string:  event.item.id = stable;  changed = true
          if event.item_id is a mismatched string:   event.item_id = stable;  changed = true

  // Rule B — terminal snapshots: correlate by array position.
  if (Array.isArray(event.response?.output)):
      event.response.output.forEach((item, i) =>
          stable = pin(i, item.id)
          if stable !== undefined and item.id is a mismatched string:
              item.id = stable;  changed = true)

  return changed
```

The two rules are mutually exclusive in practice — a per-item event never carries `response.output`; a terminal event never carries a top-level `output_index` — so they are two independent `if`s, not a switch and not nested. `response.created` / `response.in_progress` also match Rule B but carry an empty `output`, so they no-op.

### Worked example (ids shortened; real ids are 408-char blobs)

Reasoning item at `output_index 0` (`A*`), message item at `output_index 1` (`M*`). Upstream churns a fresh id on every event:

| # | event | `output_index` | id field | raw | after |
|---|---|---|---|---|---|
| 1 | `output_item.added` (reasoning) | 0 | `item.id` | `A1` | `A1` ← pins idx 0 |
| 2 | `reasoning_summary_part.added` | 0 | `item_id` | `A2` | **`A1`** |
| 3 | `reasoning_summary_text.delta` | 0 | `item_id` | `A3` | **`A1`** |
| 4 | `reasoning_summary_text.done` | 0 | `item_id` | `A4` | **`A1`** |
| 5 | `reasoning_summary_part.done` | 0 | `item_id` | `A5` | **`A1`** |
| 6 | `output_item.done` (reasoning) | 0 | `item.id` | `A6` | **`A1`** |
| 7 | `output_item.added` (message) | 1 | `item.id` | `M1` | `M1` ← pins idx 1 |
| 8 | `content_part.added` | 1 | `item_id` | `M2` | **`M1`** |
| 9 | `output_text.delta` | 1 | `item_id` | `M3` | **`M1`** |
| 10 | `output_text.done` | 1 | `item_id` | `M4` | **`M1`** |
| 11 | `content_part.done` | 1 | `item_id` | `M5` | **`M1`** |
| 12 | `output_item.done` (message) | 1 | `item.id` | `M6` | **`M1`** |
| 13 | `response.completed` | — | `output[0].id`/`[1].id` | `A8`/`M7` | **`A1`**/**`M1`** |

Rows 1–12 fire Rule A (row 1 sets idx 0's pin; row 7 sets idx 1's). Row 13 fires Rule B, rewriting the assembled `output[]` by position — both pins already exist from streaming, so it only reads them. Before the fix, the reasoning-start registered under `A1:0` but row 3's delta referenced `A3:0` → crash. After, start + every delta/done key on `A1:0` → clean.

## Never modified

`encrypted_content` (reasoning-state carrier for cross-turn persistence), `call_id` (tool-call correlation id on `function_call` items, distinct from `id`), `summary`, `content`, `summary_index`, `content_index`, and all payload fields (`delta`, `text`, `part.text`, `arguments`). Only `item.id` and `item_id` are rewritten. Because Rule A now touches *any* event with an `output_index`, the test suite must explicitly assert these non-id fields survive on the summary events.

## Per-request scoping (unchanged, reconfirmed)

The `Map` is created inside `createResponsesItemIdNormalizer()` (`normalize-responses-item-ids.ts`), and the factory is called once per request inside the `streamSSE` callback (`handler.ts`). One map ↔ one stream ↔ one response, GC'd when the stream ends. No module-level mutable state; concurrent requests each reusing `output_index 0` cannot collide. The generic rewrite does not change this.

## Testing

- **New failing test first (TDD)** in `tests/responses-passthrough-item-ids.test.ts`: a reasoning item whose `output_item.added` carries `rs_real`, followed by `reasoning_summary_part.added` / `reasoning_summary_text.delta` / `reasoning_summary_text.done` / `reasoning_summary_part.done` each carrying a *distinct* churned `item_id`, all on `output_index 0`. Assert every summary event's `item_id` collapses to `rs_real`, and that `summary_index`, `part.text`, `delta`/`text`, and `encrypted_content` are untouched. This test must fail against the current allowlist normalizer and pass after the rewrite.
- **Keep the existing tests green** — the reasoning/message, function-call/`call_id`, passthrough-of-non-item-events, and cross-`output_index` tests already encode the behavior Rule A/B must preserve.
- **Regression:** `bun test`, watching `create-responses`, `responses-error`, `stream-translation-recovery`, and especially `request-signal-regression`.
- **codex CLI smoke** (required by `AGENTS.md` for any Responses-routing change): throwaway `CODEX_HOME=/tmp/…` against the local patched proxy's `/v1/responses`, gpt-5 model, confirm it still returns cleanly. Do not modify `~/.codex`.
- **AI-SDK smoke** (the actual point): reproduce with the §Problem prompt against the local patched proxy with `normalizeOpenAIResponsesItemIds` on → no `reasoning part … not found`. A `@ai-sdk/openai` `streamText` script or `opencode` both work.
- `bun run typecheck` and `bun run lint --fix` before finishing.

## Out of scope

- **The `ResponsesStreamEvent` union** (`create-responses.ts`) stays a curated subset; the generic normalizer no longer depends on it being exhaustive, which was the fragile coupling. Adding the reasoning-summary event types to the union is optional documentation, not required by this fix, and is left out to keep the diff focused.
- **The flag default.** `normalizeOpenAIResponsesItemIds` stays opt-in/off-by-default; whether to flip it is a separate decision.
- **Cross-turn reasoning persistence** and **filing a `vercel/ai` upstream issue** — unchanged from the original spec's out-of-scope list.
