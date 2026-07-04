# Generalize `/responses` item-id normalization to reasoning-summary events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `/responses` per-item id normalizer so it stabilizes ids on Copilot's churning `reasoning_summary_*` events (and any other id-bearing event), eliminating the `reasoning part …:0 not found` crash in spec-strict clients like the Vercel AI SDK / opencode.

**Architecture:** Replace the normalizer's event-type `switch` (an allowlist that missed the summary events) with two structural correlation rules in `normalizeEvent`: Rule A rewrites `item.id`/`item_id` on any event carrying a numeric `output_index`; Rule B rewrites each `response.output[i].id` on terminal snapshot events by array position. First-seen id per `output_index` still wins; the per-response `Map`, `rewrite` entry point, and handler wiring are unchanged.

**Tech Stack:** TypeScript, Bun (test + runtime), Hono streaming, ESLint (antfu config), tsc.

## Global Constraints

- **Bun is not on the default PATH.** It lives at `~/.bun/bin/bun`. Prepend `export PATH="$HOME/.bun/bin:$PATH"` in every shell that runs `bun`, `git commit` (pre-commit hook shells out to `bun run lint`), typecheck, or tests.
- **Only `item.id` and `item_id` may be rewritten.** Never modify `encrypted_content`, `call_id`, `summary`, `content`, `summary_index`, or any payload field (`delta`, `text`, `part`, `arguments`).
- **No handler / config / flag changes.** The `normalizeOpenAIResponsesItemIds` flag stays opt-in and off by default. Do not touch `src/routes/responses/handler.ts`, `src/lib/state.ts`, `src/start.ts`, or the daemon config.
- **Preserve per-request scoping.** The `Map` stays inside the factory closure; one normalizer per response.
- **Keep every existing test in `tests/responses-passthrough-item-ids.test.ts` green.** They encode behavior Rule A/B must preserve.
- **The generic normalizer must not depend on the `ResponsesStreamEvent` union being exhaustive** — parse to a loose structural type instead.

---

## File Structure

- `src/lib/translation/normalize-responses-item-ids.ts` — **modify.** Replace the `switch`-based `normalizeEvent` with the two-rule structural version; add a loose `NormalizableEvent` interface; drop the now-unused `ResponsesStreamEvent` import. `createResponsesItemIdNormalizer`, `stableId`, `rewrite`, and the `Map` stay.
- `tests/responses-passthrough-item-ids.test.ts` — **modify.** Extend the `ParsedEvent` interface with `summary_index`/`delta`/`text`/`part`; add one new test reproducing reasoning-summary id churn. Existing tests unchanged.

---

### Task 1: Generic two-rule normalizer (TDD)

**Files:**
- Modify: `src/lib/translation/normalize-responses-item-ids.ts`
- Test: `tests/responses-passthrough-item-ids.test.ts`

**Interfaces:**
- Consumes: nothing new. Reuses the exported `createResponsesItemIdNormalizer(): { rewrite: <T extends { event?: string, data?: string | null }>(chunk: T) => T }`.
- Produces: same public signature (`createResponsesItemIdNormalizer` / `rewrite`) — behavior is a strict superset (now also normalizes `reasoning_summary_*` and any event with an `output_index`). No consumer changes.

- [ ] **Step 1: Extend the test's `ParsedEvent` interface with summary-event fields**

In `tests/responses-passthrough-item-ids.test.ts`, replace the `ParsedEvent` interface (currently lines ~5–19) with:

```ts
interface ParsedEvent {
  type?: string
  output_index?: number
  item_id?: string
  summary_index?: number
  delta?: string
  text?: string
  part?: unknown
  item?: {
    id?: string
    call_id?: string
    encrypted_content?: string
    summary?: unknown
    content?: unknown
  }
  response?: {
    output?: Array<{ id?: string, encrypted_content?: string, call_id?: string }>
  }
}
```

- [ ] **Step 2: Write the failing test**

Append this test inside the `describe('Responses per-item id normalization', () => { … })` block in `tests/responses-passthrough-item-ids.test.ts` (before the closing `})` of the describe):

```ts
  test('stabilizes reasoning-summary event ids that churn per event', () => {
    const n = createResponsesItemIdNormalizer()
    const events = [
      chunk('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_real', encrypted_content: 'ENC_R', summary: [] },
      }),
      chunk('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added',
        output_index: 0,
        summary_index: 0,
        item_id: 'churn_1',
        part: { type: 'summary_text', text: '' },
      }),
      chunk('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        summary_index: 0,
        item_id: 'churn_2',
        delta: '**Answer',
      }),
      chunk('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        output_index: 0,
        summary_index: 0,
        item_id: 'churn_3',
        text: '**Answering**',
      }),
      chunk('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        output_index: 0,
        summary_index: 0,
        item_id: 'churn_4',
        part: { type: 'summary_text', text: '**Answering**' },
      }),
      chunk('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_real_done',
          encrypted_content: 'ENC_R',
          summary: [{ type: 'summary_text', text: '**Answering**' }],
        },
      }),
    ].map(c => parse(n.rewrite(c)))

    // Every reasoning-summary event collapses to the first-seen reasoning id.
    expect(events[0].item?.id).toBe('rs_real')
    expect(events[1].item_id).toBe('rs_real')
    expect(events[2].item_id).toBe('rs_real')
    expect(events[3].item_id).toBe('rs_real')
    expect(events[4].item_id).toBe('rs_real')
    expect(events[5].item?.id).toBe('rs_real')

    // Non-id fields on summary events are preserved.
    expect(events[1].summary_index).toBe(0)
    expect(events[2].summary_index).toBe(0)
    expect(events[2].delta).toBe('**Answer')
    expect(events[3].text).toBe('**Answering**')
    expect(events[1].part).toEqual({ type: 'summary_text', text: '' })
    expect(events[0].item?.encrypted_content).toBe('ENC_R')
    expect(events[5].item?.encrypted_content).toBe('ENC_R')
  })
```

- [ ] **Step 3: Run the new test and verify it FAILS**

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/ning/github/copilot-proxy
bun test tests/responses-passthrough-item-ids.test.ts -t "reasoning-summary"
```

Expected: **FAIL.** The current allowlist `switch` has no case for `reasoning_summary_*`, so `item_id` is left as `churn_1`. The failure is on `expect(events[1].item_id).toBe('rs_real')` — `Expected: "rs_real" / Received: "churn_1"`.

- [ ] **Step 4: Replace the file with the generic two-rule normalizer**

Overwrite `src/lib/translation/normalize-responses-item-ids.ts` with exactly this:

```ts
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
```

- [ ] **Step 5: Run the new test and verify it PASSES**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test tests/responses-passthrough-item-ids.test.ts -t "reasoning-summary"
```

Expected: **PASS** (1 pass).

- [ ] **Step 6: Run the whole normalizer test file and verify all existing tests still PASS**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test tests/responses-passthrough-item-ids.test.ts
```

Expected: **PASS** — all 5 tests (4 pre-existing + 1 new), 0 fail.

- [ ] **Step 7: Run the full suite + typecheck to confirm no regressions**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun test 2>&1 | tail -20
bun run typecheck
```

Expected: full `bun test` green (pay attention to `create-responses`, `responses-error`, `stream-translation-recovery`, `request-signal-regression`). `tsc` exits 0 with no output.

- [ ] **Step 8: Lint the two changed files**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run lint --fix src/lib/translation/normalize-responses-item-ids.ts tests/responses-passthrough-item-ids.test.ts
```

Expected: exits 0, no remaining errors. (Watch for `no-nested-ternary`/unused-import — the implementation above avoids both by using an `if/else if` for `seen` and dropping the `ResponsesStreamEvent` import.)

- [ ] **Step 9: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add src/lib/translation/normalize-responses-item-ids.ts tests/responses-passthrough-item-ids.test.ts
git commit -m "fix: normalize churning item_id on /responses reasoning-summary events

Replace the event-type allowlist in the /responses id normalizer with two
structural rules (per-item by output_index; terminal output[] by array index)
so Copilot's churning reasoning_summary_* item_ids collapse to the first-seen
id per output_index. Fixes 'reasoning part <id>:0 not found' in the Vercel AI
SDK / opencode."
```

Expected: commit succeeds (pre-commit lint-staged passes).

---

### Task 2: End-to-end verification against real Copilot output

> No code change and no commit — this task produces verification evidence that the fix works on real Copilot event shapes (guards against a wrong field name/ordering assumption in the unit test) and satisfies the `AGENTS.md` codex-smoke requirement for Responses-routing changes.

**Files:** none modified. Uses a throwaway script under `/tmp`.

**Interfaces:**
- Consumes: `createResponsesItemIdNormalizer` from `src/lib/translation/normalize-responses-item-ids.ts` (imported directly by a Bun script).

- [ ] **Step 1: Capture a fresh reasoning stream from the deployed instance**

`copilot.ningw.net` is LAN-only, no inbound auth. It runs the *old* normalizer, so `output_item.*` ids are already stable there but `reasoning_summary_*` ids still churn — exactly the input needed to prove the summary fix.

```bash
cd /tmp
curl -sS -N https://copilot.ningw.net/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4","input":"Carefully reason step by step, then answer: A farmer has 17 sheep, all but 9 die. How many are left? Explain your reasoning in a few sentences before answering.","reasoning":{"effort":"high","summary":"detailed"},"store":false,"include":["reasoning.encrypted_content"],"stream":true}' \
  > /tmp/verify_sse.txt
grep -c '^event: response.reasoning_summary' /tmp/verify_sse.txt
```

Expected: a non-zero count (there are `reasoning_summary_*` events to normalize). If it's 0, retry with a longer prompt — the replay is meaningless without summary events.

- [ ] **Step 2: Replay the captured stream through the patched normalizer and assert one id per output_index**

Write `/tmp/verify_normalizer.ts`:

```ts
import { readFileSync } from 'node:fs'
import { createResponsesItemIdNormalizer } from '/home/ning/github/copilot-proxy/src/lib/translation/normalize-responses-item-ids'

const n = createResponsesItemIdNormalizer()
const idsByIndex = new Map<number, Set<string>>()
let encryptedSeen = 0
let encryptedPreserved = 0

for (const block of readFileSync('/tmp/verify_sse.txt', 'utf8').split('\n\n')) {
  const eventLine = block.split('\n').find(l => l.startsWith('event:'))
  const dataLine = block.split('\n').find(l => l.startsWith('data:'))
  if (!dataLine)
    continue
  const raw = dataLine.slice('data:'.length).trim()
  if (!raw || raw === '[DONE]')
    continue
  const event = eventLine?.slice('event:'.length).trim()
  const out = n.rewrite({ event, data: raw })
  const parsed = JSON.parse(out.data as string)

  const collect = (index: unknown, id: unknown) => {
    if (typeof index === 'number' && typeof id === 'string') {
      if (!idsByIndex.has(index))
        idsByIndex.set(index, new Set())
      idsByIndex.get(index)!.add(id)
    }
  }
  collect(parsed.output_index, parsed.item_id)
  collect(parsed.output_index, parsed.item?.id)
  for (const [i, item] of (parsed.response?.output ?? []).entries())
    collect(i, item.id)

  // encrypted_content must survive untouched on reasoning items.
  const enc = parsed.item?.encrypted_content ?? parsed.response?.output?.[0]?.encrypted_content
  if (typeof enc === 'string' && enc.length > 0) {
    encryptedSeen++
    if (!enc.includes('REWRITTEN'))
      encryptedPreserved++
  }
}

let ok = true
for (const [index, ids] of idsByIndex) {
  const unique = [...ids]
  console.log(`output_index ${index}: ${unique.length} unique id(s)`)
  if (unique.length !== 1)
    ok = false
}
console.log(`encrypted_content present on ${encryptedSeen} events, all preserved: ${encryptedSeen === encryptedPreserved}`)
console.log(ok ? 'PASS: exactly one id per output_index' : 'FAIL: id churn survived')
process.exit(ok ? 0 : 1)
```

Run it:

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun run /tmp/verify_normalizer.ts
```

Expected: each `output_index` reports **1 unique id**, `encrypted_content … all preserved: true`, and a final `PASS`. Exit code 0.

- [ ] **Step 3 (requires Copilot auth): live smoke against the local patched proxy**

Only runnable if the local proxy can authenticate (the user has run the `auth` subcommand). If auth is unavailable in this environment, note that Step 2 already validates the transform on real data and defer this to the user.

Terminal 1 — start the patched proxy with normalization on:

```bash
export PATH="$HOME/.bun/bin:$PATH"
cd /home/ning/github/copilot-proxy
bun run ./src/main.ts start --normalize-openai-responses-item-ids -v -p 4399
```

Terminal 2 — reproduce the §Problem prompt and confirm the emitted summary ids are stable:

```bash
curl -sS -N http://localhost:4399/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4","input":"Carefully reason step by step, then answer: A farmer has 17 sheep, all but 9 die. How many are left? Explain your reasoning before answering.","reasoning":{"effort":"high","summary":"detailed"},"store":false,"include":["reasoning.encrypted_content"],"stream":true}' \
  | grep -o '"item_id":"[^"]*"' | sort -u | wc -l
```

Expected: the count of distinct `item_id` values equals the number of output items (e.g. `1` for a reasoning-only warmup, `2` when a message item is also present) — **not** dozens. Then stop the proxy (Ctrl-C in Terminal 1).

- [ ] **Step 4 (required by AGENTS.md, needs codex + running proxy): codex CLI smoke**

With the patched proxy from Step 3 still running, point a throwaway codex config at it (do **not** modify `~/.codex`):

```bash
mkdir -p /tmp/codex-smoke
cat > /tmp/codex-smoke/config.toml <<'TOML'
model = "gpt-5.4"
model_provider = "localproxy"
[model_providers.localproxy]
name = "localproxy"
base_url = "http://localhost:4399/v1"
wire_api = "responses"
TOML
CODEX_HOME=/tmp/codex-smoke codex exec 'Reply with the single word: pong.'
```

Expected: returns cleanly (a `pong`), no error — confirms the generic rewrite didn't regress the codex path.

---

## Self-Review

**1. Spec coverage.**
- Root-cause fix (cover `reasoning_summary_*`) → Task 1 Steps 2–4. ✅
- Generic two-rule transform replacing the allowlist → Task 1 Step 4. ✅
- Never modify `encrypted_content`/`call_id`/`summary`/`content`/`summary_index`/payloads → asserted in Task 1 Step 2 (summary_index, delta, text, part, encrypted_content) and reconfirmed by existing `call_id` test kept green (Step 6) + Task 2 Step 2 (encrypted_content on real data). ✅
- Per-request scoping unchanged → no change to factory/closure; noted in Global Constraints. ✅
- TDD failing test first → Steps 2–3. ✅
- Keep existing tests green → Step 6. ✅
- `ResponsesStreamEvent` union left as-is / normalizer no longer depends on it → import dropped in Step 4; loose `NormalizableEvent` used. ✅
- Regression + typecheck + lint → Steps 7–8. ✅
- codex + AI-SDK smoke → Task 2 Steps 3–4. ✅

**2. Placeholder scan.** No TBD/TODO; every code step shows complete code; every command has expected output. ✅

**3. Type consistency.** `createResponsesItemIdNormalizer` / `rewrite` signatures unchanged and match the test's usage (`n.rewrite(chunk)` → `parse(...)`). `NormalizableEvent` fields (`output_index`, `item_id`, `item.id`, `response.output[].id`) match what `normalizeEvent` reads. Test `ParsedEvent` additions (`summary_index`, `delta`, `text`, `part`) match the fields asserted. ✅
