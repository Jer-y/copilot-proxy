# HANDOFF — Stabilize GitHub Copilot's per-event item IDs in the `/responses` passthrough

> Kickstart prompt for an agent picking this up cold. Read the whole thing before
> touching code. The change is well-scoped but has a **policy decision** to make
> first (see §3) — don't skip it. Repo: `Jer-y/copilot-proxy` (this checkout, v0.7.15).

## 1. Symptom

A client built on the **Vercel AI SDK** (`@ai-sdk/openai`) crashes on the **first**
GPT‑5 message routed through this proxy's `/responses` (and `/v1/responses`):

```
TypeError: undefined is not an object (evaluating 'S.summaryParts')
```

The concrete client is `opencode` 1.17.13 (bundles `@ai-sdk/openai@3.0.53`), pointed at
this proxy with provider `npm: "@ai-sdk/openai"`, `baseURL` = the proxy, model `gpt-5.*`.

**`codex` (OpenAI's own CLI) works flawlessly against the identical endpoint** — same
proxy, same `wire_api: responses`, same `gpt-5.5` model at `xhigh`. Verified live:
`codex exec` returned `pong`, no error. So the endpoint is *usable*; this is a
client‑parser divergence, not a dead endpoint.

## 2. Root cause (verified, not hypothesized)

**Architecture.** For GPT models, `/responses` is a near‑verbatim **passthrough** of
GitHub Copilot's native `/responses` SSE:
`src/routes/responses/handler.ts → handleViaResponses` iterates the upstream events
(`src/services/copilot/create-responses.ts → createResponses` → `events(response)` →
`instrumentCopilotEventStream`) and re‑emits each event unchanged. copilot-proxy only
*mints* its own IDs in the **Anthropic→Responses translation** path
(`src/lib/translation/anthropic-to-responses.ts`, `rs_…`/`msg_…`/`resp_…`), which GPT
never takes.

**The upstream quirk.** GitHub Copilot emits a **different, ~408‑char, opaque `id` on
every SSE event for the *same* streamed item** — across `response.output_item.added`
and `response.output_item.done` (and the `content_part.*` / `output_text.*` /
`function_call_arguments.*` / `reasoning_summary_*` deltas), for **reasoning *and*
message** items. The stable correlation key is `output_index`, not `id`.
`encrypted_content` is returned separately (present as a string on the reasoning item).
Some captures show `summary: []` on item snapshots, while detailed-summary prompts can
also emit `reasoning_summary_*` events whose `item_id` values churn in the same way.

Captured with:

```bash
# copilot.ningw.net is the deployed instance (LAN-only, no inbound auth).
curl -sS -N https://copilot.ningw.net/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4","input":"Reply with the single word: pong.",
       "reasoning":{"effort":"medium","summary":"auto"},
       "store":false,"include":["reasoning.encrypted_content"],"stream":true}'
```

Observed (id shown as first 14 chars / total length):

| event                     | item      | id (first 14)    | id len | encrypted_content | summary |
|---------------------------|-----------|------------------|--------|-------------------|---------|
| response.output_item.added| reasoning | `gYV7Q80Tsl4Xob` | 408    | string            | `[]`    |
| response.output_item.done | reasoning | `ogWvGtU9JwXS5D` | 408    | string            | `[]`    |
| response.output_item.added| message   | `ktX0mJQtII0Ut2` | 408    | null              | —       |
| response.output_item.done | message   | `WBaGagKIoyAYsB` | 408    | null              | —       |

Note the `added` id ≠ `done` id for the **same** item (same `output_index`).

**Why it breaks the AI SDK but not codex.** The OpenAI `/responses` spec treats item
`id` as **stable within a response**. Copilot violates that.
- `@ai-sdk/openai` (client) builds an `activeReasoning[item.id]` state map at
  `output_item.added` and reads it back at `output_item.done` (then derefs
  `.summaryParts`) to stream reasoning‑summary parts incrementally. Mismatched
  `done` id ⇒ map miss ⇒ `undefined.summaryParts` ⇒ crash. (In the AI SDK's
  `src/responses/openai-responses-language-model.ts`: entry created on the `added`
  branch, read+deleted on the `done` branch — line numbers drift by version; grep
  `activeReasoning` / `summaryParts`.)
- `codex` (`codex-rs/codex-api/src/sse/responses.rs`) parses the **complete item off
  `output_item.done`** and does **no** added→done id correlation; summary deltas are
  keyed by `summary_index`. So the churning id is never used as a lookup key → immune.

**Disabling reasoning summaries does NOT fix the client** — the crash is in the
reasoning item's added→done id correlation, which the AI SDK does regardless of whether
summaries were requested (`codex` runs with `summaries: none` and still gets reasoning
items fine). So the lever is the **id**, not the summary flag.

## 3. Decision to make FIRST (do not skip)

This proxy's `AGENTS.md` → **Proxy Capability Policy** says: *treat Copilot upstream as
the source of truth; prefer transparent forwarding; do not add local massaging solely to
handle client‑compatibility gaps.* A proxy‑side id rewrite is in **genuine tension** with
that policy. Weigh both readings and get maintainer sign‑off before implementing:

- **For fixing it here (spec‑conformance framing):** stable per‑item ids *are* part of the
  OpenAI `/responses` contract this proxy advertises. A `/responses` stream that changes an
  item's `id` between `added` and `done` is arguably **malformed output**, and normalizing
  it to a consistent id per `output_index` makes the OpenAI‑compat surface *correct* — not
  a client‑specific hack. It would fix every spec‑strict AI‑SDK client, not just opencode.
- **Against (transparent‑forwarding framing):** OpenAI's own reference client (`codex`)
  consumes the stream fine, so the load‑bearing fault is the AI SDK's brittleness (keys by
  id + unguarded deref). The "purest" fix per policy is **upstream**: make `@ai-sdk/openai`
  fall back to `output_index` (file with `vercel/ai`), or fix `opencode`. The proxy stays a
  faithful relay. Downside: out of this repo's control, slower, opencode stays broken.

**Recommendation:** treat it as an OpenAI‑compat **correctness** normalization (option A),
because "same item, changing id" is not a representable‑field nuance — it's non‑spec
output that silently corrupts any id‑keyed client. But it is a judgment call; confirm with
the maintainer, and consider also filing the upstream `vercel/ai` issue regardless. If the
decision is "won't fix here," stop and instead document the incompatibility (do **not** add
a local 400 — that violates the policy too).

## 4. If you proceed — implementation sketch

Goal: within a single `/responses` response, every event that refers to a given
`output_index` carries the **same** item `id`.

- **Where:** `src/routes/responses/handler.ts → handleViaResponses` (the streaming
  `for await (const chunk of streamBody)` loop) and its non‑streaming branch. Factor the
  rewrite into a small stateful helper (e.g. `src/lib/translation/normalize-responses-item-ids.ts`)
  so it's unit‑testable and reusable. `chunk` is an SSE message whose `data` is a JSON
  string — parse, rewrite, re‑stringify (mind the `event:` field too).
- **What:** keep a per‑response `Map<number /*output_index*/, string /*id*/>`. On the
  first event that reveals an item's id for an `output_index`, record it. For **every**
  subsequent event on that `output_index`, overwrite `item.id` / `item_id` with the
  recorded value. Cover: `response.output_item.added`, `response.output_item.done`,
  `response.content_part.added/done`, `response.output_text.delta/done`,
  `response.function_call_arguments.delta/done`, and the final `response.completed`
  `response.output[]` array (rewrite each item's `id` by its index). The
  `ResponsesStreamEvent` union in `create-responses.ts:502` already types `output_index`
  and `item_id` on these — use it.
- **Prefer pinning to the first real upstream id** for that `output_index` (most
  "transparent" — you keep a genuine upstream value, just make it consistent). Only mint a
  synthetic id (mirror `anthropic-to-responses.ts`:
  `rs_${randomUUID().replace(/-/g,'').slice(0,24)}`) if there's a reason not to reuse the
  first‑seen one.
- **Never touch:** `encrypted_content` (the reasoning‑state carrier for persistence),
  `content`, `summary`, and **`call_id`** on `function_call` items (that's the tool‑call
  correlation id, distinct from `id` — leave it alone). Only normalize the item **`id`**
  (and the `item_id` that mirrors it on delta events).
- **Preserve** the existing abort handling (`stream.aborted`, `result.cancel(...)`) and do
  **not** pass the inbound request signal upstream — see the Request‑Abort policy in
  `AGENTS.md` and `tests/request-signal-regression.test.ts`.
- **Check** `handleResponsesPassthrough` (raw `c.body(response.body)` pipe, used for
  GET/DELETE/`resp_…` fetches): it does not parse, so it won't be normalized. Decide
  whether any streaming create path can reach it (opencode's create goes through
  `handleViaResponses`, so likely fine — but confirm).

## 5. Open question to validate (persistence)

The reasoning **state** rides in `encrypted_content`, not the `id`, so stabilizing the id
should not affect cross‑turn reasoning persistence. **But confirm** that on turn 2 the AI
SDK replays the reasoning item with the (now stable) id + `encrypted_content`, and Copilot
reconstructs from `encrypted_content` while ignoring the echoed id. If Copilot rejects a
non‑original id on input, persistence needs a different approach (and note that Copilot's
own capability matrix flags encrypted‑reasoning replay as *optional/uncertain* — the id fix
guarantees the crash goes away; full persistence is a separate, softer goal).

## 6. Validation plan

- **Reproduce upstream churn:** the curl in §2 (deployed instance, no auth) or against a
  locally‑run proxy (`bun run dev` after `copilot-proxy auth`).
- **New unit test** (`tests/responses-passthrough-item-ids.test.ts`): feed a mock upstream
  SSE whose item ids churn per event; assert the emitted stream has exactly one stable id
  per `output_index` across `added`/`done`/deltas and in the final `output[]`; assert
  `encrypted_content`/`call_id`/content are untouched. Model after
  `tests/stream-translation-recovery.test.ts`, `tests/translation-stream-responses.test.ts`,
  `tests/anthropic-to-responses-ids.test.ts`, `tests/create-responses.test.ts`.
- **Regression:** `bun test` (watch `create-responses`, `responses-error`,
  `stream-translation-recovery`, and **`request-signal-regression`** especially).
- **`codex` CLI smoke — REQUIRED by AGENTS.md for any Responses‑routing change.** Point a
  throwaway `CODEX_HOME=/tmp/…` config at the *local* patched proxy's `/v1/responses`,
  gpt‑5 model, confirm it still returns cleanly. Do not modify the user's `~/.codex`.
- **AI‑SDK smoke (the actual point):** a minimal `@ai-sdk/openai` `streamText` script
  (`createOpenAI({ baseURL })`, gpt‑5 model, `store:false`,
  `include:["reasoning.encrypted_content"]`, reasoning enabled) against the patched local
  proxy → **no `summaryParts` crash**. (Or run `opencode` if available.)
- `bun run typecheck` and `bun run lint --fix` before finishing.

## 7. Key files

- `src/routes/responses/handler.ts` — `handleViaResponses` (insert transform),
  `handleResponsesPassthrough` (raw pipe — assess).
- `src/services/copilot/create-responses.ts` — `createResponses`, `ResponsesStreamEvent`
  (event union w/ `output_index`/`item_id`), `ResponsesOutputItem`, `ResponsesResponse`.
- `src/lib/translation/anthropic-to-responses.ts` — existing id‑minting precedent.
- Tests listed in §6; `docs/copilot-capability-validation.md` — live‑probe how‑to.

## 8. Build / test / run (Bun project)

```bash
bun install
bun run build        # tsdown → dist/main.js
bun test             # all tests
bun test tests/create-responses.test.ts   # targeted
bun run typecheck
bun run lint --fix
bun run dev          # local server with watch (needs `copilot-proxy auth` first)
COPILOT_LIVE_TEST=1 bun run test:live:copilot   # live probes (needs token/model env)
```

## 9. Scope guardrails

- **Do not** change the consumer repo (`nixfiles`, `../nixfiles`). It is intentionally left
  as‑is: opencode's provider is `npm: "@ai-sdk/openai"` at `baseURL` = this proxy, GPT‑5,
  which triggers opencode's transform to send `store:false` +
  `include:["reasoning.encrypted_content"]` + `reasoningSummary:"auto"`. When this proxy
  change ships (→ bump the `kura` package → bump the nixfiles `kura` input → redeploy the
  `yuki` host), that config will start working without edits.
- **Do not** touch `encrypted_content`, `call_id`, or item content.
- **Do not** add a local rejection; if you don't normalize, don't 400 — document instead.
- **Do not** forward the inbound request signal to upstream fetch.

## 10. Consumer context (for understanding, not editing)

- **opencode 1.17.13** / `@ai-sdk/openai@3.0.53` — crash site described in §2. Its own
  vendored fork lives at `packages/core/src/github-copilot/responses/` (same
  `activeReasoning`/`summaryParts` shape) but the custom provider uses the *stock* npm, not
  the fork.
- **codex** (`codex-rs/codex-api/src/sse/responses.rs`) — reads the item off
  `output_item.done`; immune to id churn; works today against this proxy.
