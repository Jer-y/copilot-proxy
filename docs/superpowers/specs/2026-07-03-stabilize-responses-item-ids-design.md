# Stabilize per-item IDs in the `/responses` passthrough

**Date:** 2026-07-03
**Status:** Approved — ready for implementation planning
**Scope:** `src/routes/responses/handler.ts` (streaming path) + one new helper module + one new unit test.

## Problem

For GPT models, this proxy's `/responses` (and `/v1/responses`) endpoint is a near-verbatim
passthrough of GitHub Copilot's native `/responses` SSE stream. Copilot emits a **different,
~408-char opaque `id` on every SSE event for the *same* streamed item** — across
`response.output_item.added` and `response.output_item.done`, and across the
`content_part.*` / `output_text.*` / `function_call_arguments.*` delta events — for both
reasoning and message items. The stable correlation key upstream is `output_index`, not `id`.

The OpenAI `/responses` contract treats an item `id` as **stable within a response**. Copilot
violates that. Clients differ in how they tolerate it:

- **OpenAI's `codex` CLI** reads the complete item off `output_item.done` and does no
  added→done id correlation, so it is immune and works today against this proxy.
- **The Vercel AI SDK** (`@ai-sdk/openai`) builds an `activeReasoning[item.id]` state map on
  `output_item.added` and reads it back on `output_item.done` (then dereferences
  `.summaryParts`). A mismatched `done` id causes a map miss and the client crashes with
  `TypeError: undefined is not an object (evaluating 'S.summaryParts')` on the **first**
  GPT-5 message. The concrete failing client is `opencode` 1.17.13 (bundles
  `@ai-sdk/openai@3.0.53`), pointed at this proxy.

Disabling reasoning summaries does not help: the crash is in the reasoning item's added→done
id correlation, which the AI SDK performs regardless of whether summaries were requested. The
load-bearing field is the **`id`**, not the summary flag.

## Decision

**Normalize the item `id` proxy-side, framed as OpenAI-compat correctness.**

A `/responses` stream that changes an item's `id` between `added` and `done` is malformed
output against the contract this proxy advertises. Normalizing it to a consistent id per
`output_index` makes the OpenAI-compat surface *correct* rather than adding a client-specific
hack — so it is consistent with the `AGENTS.md` Proxy Capability Policy ("treat Copilot
upstream as source of truth; prefer transparent forwarding") because we keep a **genuine
upstream id** and only make it consistent.

Two decisions were made explicitly during design:

- **Success bar = eliminate the crash.** Cross-turn reasoning persistence (turn 2 replaying
  the item with the now-stable id + `encrypted_content`) is a separate, softer,
  Copilot-dependent goal (see "Follow-up, out of scope"). This work is not gated on verifying
  persistence.
- **Filing an upstream `vercel/ai` issue is out of scope** for this change. The maintainer may
  do so independently; the proxy change stands on its own.

## Approach: pin to the first-seen upstream id

Keep a per-response `Map<number /* output_index */, string /* id */>`. The first event that
reveals an item's id for an `output_index` records that genuine upstream id; every subsequent
event on that `output_index` has its `id` / `item_id` overwritten to the recorded value. In
practice `response.output_item.added` is the first event for an item, so the `added` id is
locked — which is exactly the id the AI SDK stores in `activeReasoning[item.id]` and later
dereferences on `done`.

This was chosen over minting synthetic `rs_…`/`msg_…` ids (the pattern in
`anthropic-to-responses.ts`) because pinning keeps a real upstream value and is the most
transparent reading of "normalize for correctness." Minting would replace every id with an
invented one even though a valid one already exists.

## Component & boundary

New module: **`src/lib/translation/normalize-responses-item-ids.ts`**, exporting a factory:

```ts
export function createResponsesItemIdNormalizer(): {
  rewrite(chunk: { event?: string, data?: string | null }): { event?: string, data?: string | null }
}
```

- **What it does:** given one SSE chunk (where `data` is a JSON-encoded event string), returns
  a chunk whose item `id` / `item_id` fields have been normalized to one stable value per
  `output_index`.
- **How it's used:** `handleViaResponses` constructs one normalizer per streamed response, then
  calls `rewrite(chunk)` on each chunk before `stream.writeSSE(...)`.
- **What it depends on:** only the `ResponsesStreamEvent` shape already declared in
  `src/services/copilot/create-responses.ts` (the union types `output_index`, `item_id`, `item`,
  and `response.output[]`). No I/O; no state outside its own closure → unit-testable in isolation.

The `Map<number, string>` lives inside the closure, created fresh per response and discarded
when the stream ends. No cross-request state.

## Data flow

```
upstream SSE chunk ──▶ rewrite(chunk)
                         │  data == null/empty? ─▶ return chunk unchanged
                         │  JSON.parse throws?   ─▶ return chunk unchanged (never break the stream)
                         │  otherwise: parse ─▶ inspect .type ─▶ mutate id/item_id ─▶ re-stringify
                         ▼
                   stream.writeSSE(normalized)
```

**First-seen-wins:** the first event that reveals an id for an `output_index` records it; all
later events on that `output_index` are overwritten to the recorded id. Recording accepts an id
from either `item.id` (item events) or `item_id` (delta events), so a stream that somehow leads
with a delta still anchors correctly.

## Rewrite rules

| Event type | Field normalized | Keyed by |
|---|---|---|
| `response.output_item.added` / `response.output_item.done` | `item.id` | `output_index` |
| `response.content_part.added` / `response.content_part.done` | `item_id` | `output_index` |
| `response.output_text.delta` / `response.output_text.done` | `item_id` | `output_index` |
| `response.function_call_arguments.delta` / `response.function_call_arguments.done` | `item_id` | `output_index` |
| `response.completed` / `response.incomplete` / `response.failed` | each `response.output[i].id` | array index `i` (== `output_index`) |

**Never modified:** `encrypted_content` (the reasoning-state carrier for cross-turn
persistence), `content`, `summary`, and `call_id` on `function_call` items (the tool-call
correlation id — distinct from `id`). Events with no `output_index`
(`response.created`, `response.in_progress`, `error`) pass through untouched.

## Integration point

Inside `handleViaResponses` (`src/routes/responses/handler.ts`), in the streaming branch only:

```ts
const streamBody = result.body
return streamSSE(c, async (stream) => {
  const normalizeItemIds = createResponsesItemIdNormalizer()
  let completed = false
  stream.onAbort(() => result.cancel?.('...'))
  try {
    for await (const chunk of streamBody) {
      if (stream.aborted) break
      const normalized = normalizeItemIds.rewrite(chunk)
      if (consola.level >= 4) consola.debug('Responses streaming chunk:', JSON.stringify(normalized))
      await stream.writeSSE(normalized as SSEMessage)
    }
    completed = !stream.aborted
  }
  catch (error) { /* unchanged: writeOpenAIStreamError(...) */ }
  finally { /* unchanged: if (!completed) result.cancel?.(...) */ }
})
```

## Error handling & scope boundaries

- **Malformed chunk data** → forwarded verbatim (a parse failure returns the original chunk).
  A normalization miss never turns into a stream break.
- **Abort / cancellation** → unchanged. The `stream.aborted` check, `stream.onAbort`, and
  `result.cancel(...)` in `finally` stay exactly as they are; the normalizer is a pure
  per-chunk transform inserted inside the existing loop.
- **Request-signal policy** → unchanged. This change does not touch upstream fetch or signals,
  so `tests/request-signal-regression.test.ts` semantics are preserved.
- **Non-streaming branch** (`c.json(result.body)`) → deliberately not modified. A non-streaming
  response is a single snapshot where each item's `id` appears exactly once; there is no
  added→done churn to fix, so normalization would be a no-op.
- **`handleResponsesPassthrough`** (raw `c.body()` pipe for GET/DELETE/`resp_…` fetches) → left
  alone. opencode's create path goes through `handleViaResponses`, and the passthrough does not
  parse SSE.

## Testing

- **New unit test** `tests/responses-passthrough-item-ids.test.ts`:
  - Feed a mock upstream SSE sequence where a reasoning item and a message item each carry a
    *different* id on `added` vs `done` vs their deltas, but share `output_index`.
  - Assert the emitted stream has exactly one id per `output_index` across `added` / `done` /
    deltas, and in the final `response.completed` `output[]`.
  - Assert `encrypted_content`, `call_id`, `content`, and `summary` are byte-for-byte untouched.
  - Assert events with no `output_index` and malformed-JSON chunks pass through unchanged.
  - Model after `tests/translation-stream-responses.test.ts` and
    `tests/anthropic-to-responses-ids.test.ts`.
- **Regression:** `bun test`, watching `create-responses`, `responses-error`,
  `stream-translation-recovery`, and especially `request-signal-regression`.
- **codex CLI smoke** (required by `AGENTS.md` for any Responses-routing change): point a
  throwaway `CODEX_HOME=/tmp/…` config at the local patched proxy's `/v1/responses`, gpt-5
  model, confirm it still returns cleanly. Do not modify the user's `~/.codex`.
- **AI-SDK smoke** (the actual point): a minimal `@ai-sdk/openai` `streamText` script
  (`createOpenAI({ baseURL })`, gpt-5 model, `store:false`,
  `include:["reasoning.encrypted_content"]`, reasoning enabled) against the patched local
  proxy → no `summaryParts` crash. Running `opencode` against the local proxy is an acceptable
  substitute.
- `bun run typecheck` and `bun run lint --fix` before finishing.

## Follow-up, out of scope

- **Cross-turn reasoning persistence (HANDOFF §5).** The reasoning state rides in
  `encrypted_content`, not the `id`, so stabilizing the id should not affect it. Verifying that
  turn 2 replays the reasoning item with the stable id + `encrypted_content` and Copilot
  reconstructs correctly is a separate, softer goal, not gated on by this change.
- **Filing a `vercel/ai` upstream issue** about the id-keyed deref brittleness. Optional; the
  maintainer may pursue it independently.

## Ship path (context, not part of this change)

When this proxy change ships, bump the `kura` package → bump the nixfiles `kura` input →
redeploy the `yuki` host. The consumer config (`opencode` provider `npm: "@ai-sdk/openai"` at
`baseURL` = this proxy, GPT-5) starts working without edits. Do not modify the consumer repo.
