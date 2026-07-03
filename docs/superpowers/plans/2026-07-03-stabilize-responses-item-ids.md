# Stabilize `/responses` Per-Item IDs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every SSE event for a given `output_index` within one `/responses` stream carry the same item `id`, so spec-strict clients (Vercel AI SDK / opencode) stop crashing on Copilot's per-event id churn.

**Architecture:** A small, pure, per-response stateful helper parses each upstream SSE chunk, pins the first-seen genuine upstream id for each `output_index`, and rewrites the `id`/`item_id` on every later event (and the final `output[]`) to that pinned value. The helper is wired into the streaming branch of `handleViaResponses`. Nothing else in the request/response path changes.

**Tech Stack:** TypeScript (strict), Bun runtime + `bun:test`, Hono (`streamSSE`), consola. Upstream stream is GitHub Copilot's native `/responses` SSE, surfaced via `fetch-event-stream`'s `events()` + `instrumentCopilotEventStream`.

## Global Constraints

- **Only ever modify the item `id`** (and the `item_id` that mirrors it on delta/part events). Copied verbatim from spec.
- **Never modify** `encrypted_content`, `content`, `summary`, or `call_id` (the function-call correlation id, distinct from `id`).
- **Do not touch** the non-streaming branch (`c.json(result.body)`) or `handleResponsesPassthrough` — both are justified no-ops.
- **Do not** forward the inbound request signal (`c.req.raw.signal`) into any upstream fetch; preserve the existing abort handling (`stream.aborted`, `stream.onAbort`, `result.cancel(...)` in `finally`) exactly.
- **Imports:** absolute `~/*` in `src/`; relative (`../src/...`) in `tests/`. No `any`. `camelCase` values, `PascalCase` types. Unused imports/vars are errors.
- **Pre-commit hook:** a `lint-staged` hook runs `bun run lint --fix` on staged files. It needs `bun` on `PATH`. If a commit fails to spawn the hook (`ENOENT` on `bun`), fix your `PATH`; only fall back to `git commit --no-verify` for docs-only commits.
- **Default proxy port is `4399`** (`--port`, env, or README). Adjust smoke commands if you run on a different port.

---

### Task 1: `normalize-responses-item-ids.ts` helper + unit tests

**Files:**
- Create: `src/lib/translation/normalize-responses-item-ids.ts`
- Test: `tests/responses-passthrough-item-ids.test.ts`

**Interfaces:**
- Consumes: `ResponsesStreamEvent` (discriminated union) from `~/services/copilot/create-responses` — already defines `output_index`, `item_id`, `item`, and `response.output[]` on the relevant variants.
- Produces: `createResponsesItemIdNormalizer(): { rewrite: <T extends { event?: string, data?: string | null }>(chunk: T) => T }`. `rewrite` mutates `chunk.data` in place (re-stringified) when it changes an id, and returns the same chunk object (so `event`/`id`/`retry` and any unknown fields are preserved). Task 2 calls `rewrite` on each upstream chunk before writing it to the client.

- [ ] **Step 1: Write the failing test file**

Create `tests/responses-passthrough-item-ids.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test'

import { createResponsesItemIdNormalizer } from '../src/lib/translation/normalize-responses-item-ids'

interface ParsedEvent {
  type?: string
  output_index?: number
  item_id?: string
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

function chunk(event: string, payload: unknown): { event: string, data: string } {
  return { event, data: JSON.stringify(payload) }
}

function parse(c: { data?: string | null }): ParsedEvent {
  return JSON.parse(c.data ?? '') as ParsedEvent
}

describe('Responses per-item id normalization', () => {
  test('stabilizes reasoning and message ids to the first-seen id per output_index', () => {
    const n = createResponsesItemIdNormalizer()
    const events = [
      chunk('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'r_added', encrypted_content: 'ENC_R', summary: [] },
      }),
      chunk('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'r_done', encrypted_content: 'ENC_R', summary: [] },
      }),
      chunk('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'm_added', role: 'assistant', content: [] },
      }),
      chunk('response.content_part.added', {
        type: 'response.content_part.added',
        output_index: 1,
        content_index: 0,
        item_id: 'm_cp_added',
        part: { type: 'output_text', text: '' },
      }),
      chunk('response.output_text.delta', {
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        item_id: 'm_txt_delta',
        delta: 'pong',
      }),
      chunk('response.output_text.done', {
        type: 'response.output_text.done',
        output_index: 1,
        content_index: 0,
        item_id: 'm_txt_done',
        text: 'pong',
      }),
      chunk('response.content_part.done', {
        type: 'response.content_part.done',
        output_index: 1,
        content_index: 0,
        item_id: 'm_cp_done',
        part: { type: 'output_text', text: 'pong' },
      }),
      chunk('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'message', id: 'm_done', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
      }),
      chunk('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          object: 'response',
          model: 'gpt-5.4',
          status: 'completed',
          output: [
            { type: 'reasoning', id: 'r_final', encrypted_content: 'ENC_R', summary: [] },
            { type: 'message', id: 'm_final', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
          ],
        },
      }),
    ].map(c => parse(n.rewrite(c)))

    // Reasoning (output_index 0) pinned to first-seen 'r_added'
    expect(events[0].item?.id).toBe('r_added')
    expect(events[1].item?.id).toBe('r_added')
    expect(events[8].response?.output?.[0].id).toBe('r_added')

    // Message (output_index 1) pinned to first-seen 'm_added' across item + item_id fields
    expect(events[2].item?.id).toBe('m_added')
    expect(events[3].item_id).toBe('m_added')
    expect(events[4].item_id).toBe('m_added')
    expect(events[5].item_id).toBe('m_added')
    expect(events[6].item_id).toBe('m_added')
    expect(events[7].item?.id).toBe('m_added')
    expect(events[8].response?.output?.[1].id).toBe('m_added')

    // Preserved fields
    expect(events[0].item?.encrypted_content).toBe('ENC_R')
    expect(events[1].item?.encrypted_content).toBe('ENC_R')
    expect(events[8].response?.output?.[0].encrypted_content).toBe('ENC_R')
    expect(events[0].item?.summary).toEqual([])
    expect(events[7].item?.content).toEqual([{ type: 'output_text', text: 'pong' }])
  })

  test('stabilizes function_call ids while leaving call_id untouched', () => {
    const n = createResponsesItemIdNormalizer()
    const events = [
      chunk('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'f_added', call_id: 'call_abc', name: 'lookup', arguments: '' },
      }),
      chunk('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'f_delta',
        delta: '{"q":1}',
      }),
      chunk('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        item_id: 'f_argsdone',
        arguments: '{"q":1}',
        item: { type: 'function_call', id: 'f_itemdone', call_id: 'call_abc', name: 'lookup', arguments: '{"q":1}' },
      }),
      chunk('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: 'f_outdone', call_id: 'call_abc', name: 'lookup', arguments: '{"q":1}' },
      }),
    ].map(c => parse(n.rewrite(c)))

    expect(events[0].item?.id).toBe('f_added')
    expect(events[1].item_id).toBe('f_added')
    expect(events[2].item_id).toBe('f_added')
    expect(events[2].item?.id).toBe('f_added')
    expect(events[3].item?.id).toBe('f_added')

    // call_id must never be rewritten
    expect(events[0].item?.call_id).toBe('call_abc')
    expect(events[2].item?.call_id).toBe('call_abc')
    expect(events[3].item?.call_id).toBe('call_abc')
  })

  test('passes through non-item events and malformed/empty chunks unchanged', () => {
    const n = createResponsesItemIdNormalizer()

    const created = chunk('response.created', {
      type: 'response.created',
      response: { id: 'resp_1', object: 'response', model: 'gpt-5.4', status: 'in_progress', output: [] },
    })
    const createdData = created.data
    expect(n.rewrite(created).data).toBe(createdData)

    const errorEvent = chunk('error', { type: 'error', error: { message: 'boom', type: 'server_error' } })
    const errorData = errorEvent.data
    expect(n.rewrite(errorEvent).data).toBe(errorData)

    const malformed = { event: 'response.output_item.added', data: 'not-json{' }
    expect(n.rewrite(malformed).data).toBe('not-json{')

    const empty = { event: 'ping', data: '' }
    expect(n.rewrite(empty).data).toBe('')

    const nullData: { event: string, data: string | null } = { event: 'ping', data: null }
    expect(n.rewrite(nullData).data).toBeNull()
  })

  test('keeps ids independent across output_index values', () => {
    const n = createResponsesItemIdNormalizer()
    const a = parse(n.rewrite(chunk('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'idx0', summary: [] },
    })))
    const b = parse(n.rewrite(chunk('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 1,
      item: { type: 'message', id: 'idx1', role: 'assistant', content: [] },
    })))
    expect(a.item?.id).toBe('idx0')
    expect(b.item?.id).toBe('idx1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/responses-passthrough-item-ids.test.ts`
Expected: FAIL — module `../src/lib/translation/normalize-responses-item-ids` cannot be resolved (`createResponsesItemIdNormalizer` is not defined).

- [ ] **Step 3: Write the helper implementation**

Create `src/lib/translation/normalize-responses-item-ids.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/responses-passthrough-item-ids.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Typecheck and lint the new files**

Run: `bun run typecheck && bun run lint --fix src/lib/translation/normalize-responses-item-ids.ts tests/responses-passthrough-item-ids.test.ts`
Expected: no type errors; lint clean (auto-fix may reformat). If `ts/no-unnecessary-condition` fires on any `typeof … === 'string'` guard, leave it — those fields are genuinely `string | undefined` in the union, so the guard is required; the rule should not fire. If it does on `event.response.output`, that is a real type nuance — do NOT add `?.`; instead confirm the variant types `response` as required (it does) and move on.

- [ ] **Step 6: Commit**

```bash
git add src/lib/translation/normalize-responses-item-ids.ts tests/responses-passthrough-item-ids.test.ts
git commit -m "feat: add per-item id normalizer for /responses passthrough"
```

---

### Task 2: Wire the normalizer into `handleViaResponses`

**Files:**
- Modify: `src/routes/responses/handler.ts` (add import; insert normalizer into the streaming loop, ~lines 140–153)

**Interfaces:**
- Consumes: `createResponsesItemIdNormalizer` from Task 1.
- Produces: no new exports. Behavior change only — the streaming `/responses` passthrough now emits stable per-item ids.

- [ ] **Step 1: Add the import**

In `src/routes/responses/handler.ts`, add this import immediately after the existing `import { translateResponsesRequestToAnthropic } from '~/lib/translation/responses-to-anthropic'` line:

```typescript
import { createResponsesItemIdNormalizer } from '~/lib/translation/normalize-responses-item-ids'
```

- [ ] **Step 2: Insert the normalizer into the streaming loop**

In `handleViaResponses`, replace this block:

```text
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    let completed = false
    stream.onAbort(() => result.cancel?.('responses client disconnected before upstream stream completed'))
    try {
      for await (const chunk of streamBody) {
        if (stream.aborted)
          break
        if (consola.level >= 4) {
          consola.debug('Responses streaming chunk:', JSON.stringify(chunk))
        }
        await stream.writeSSE(chunk as SSEMessage)
      }
      completed = !stream.aborted
    }
```

with:

```text
  const streamBody = result.body
  return streamSSE(c, async (stream) => {
    const normalizeItemIds = createResponsesItemIdNormalizer()
    let completed = false
    stream.onAbort(() => result.cancel?.('responses client disconnected before upstream stream completed'))
    try {
      for await (const chunk of streamBody) {
        if (stream.aborted)
          break
        const normalized = normalizeItemIds.rewrite(chunk)
        if (consola.level >= 4) {
          consola.debug('Responses streaming chunk:', JSON.stringify(normalized))
        }
        await stream.writeSSE(normalized as SSEMessage)
      }
      completed = !stream.aborted
    }
```

Leave everything else in the function — the `catch`/`finally`, the non-streaming branch above it, `handleResponsesPassthrough`, and `handleViaAnthropic` — untouched.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no type errors. (`normalized` is the same type as `chunk`, so the existing `as SSEMessage` cast still applies.)

- [ ] **Step 4: Run the request-signal regression + responses tests**

Run: `bun test tests/request-signal-regression.test.ts tests/create-responses.test.ts tests/responses-error.test.ts tests/stream-translation-recovery.test.ts tests/responses-passthrough-item-ids.test.ts`
Expected: PASS across all files. The request-signal regression is the highest-risk neighbor — it must stay green (we did not touch upstream fetch or signals).

- [ ] **Step 5: Run the full suite + lint**

Run: `bun test && bun run lint --fix`
Expected: full suite green; lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/routes/responses/handler.ts
git commit -m "fix: stabilize per-item ids in /responses streaming passthrough"
```

---

### Task 3: Live smokes (codex + AI-SDK) — required by AGENTS.md

This task has no code. It is the required live validation for a Responses-routing change. It needs a running local proxy authenticated to Copilot and a GPT-5 model. If you lack token access, do not skip silently — report that the smokes were not run and why.

**Files:** none.

**Interfaces:** validates Task 2's behavior end-to-end.

- [ ] **Step 1: Start the patched proxy locally**

In one terminal (needs a prior `copilot-proxy auth`):

```bash
bun run dev
```

Expected: server listening on `http://localhost:4399` (adjust if you set `--port`). Leave it running.

- [ ] **Step 2: Reproduce the upstream churn is now normalized (curl)**

```bash
curl -sS -N http://localhost:4399/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5.4","input":"Reply with the single word: pong.",
       "reasoning":{"effort":"medium","summary":"auto"},
       "store":false,"include":["reasoning.encrypted_content"],"stream":true}' \
  | grep -E '"id"|item_id' | head -40
```

Expected: within the stream, the reasoning item's `id` on `response.output_item.added` matches its `id` on `response.output_item.done` and in the final `response.completed` `output[]`; likewise the message item's `id`/`item_id` are identical across its events. (Before the fix they differed per event.)

- [ ] **Step 2b: Confirm `encrypted_content` still present and untouched**

Expected from the same stream: the reasoning item still carries a non-empty `encrypted_content` string (the id fix must not have stripped or altered it).

- [ ] **Step 3: codex CLI smoke**

Point a throwaway codex config at the local proxy. Do NOT modify `~/.codex`.

```bash
export CODEX_HOME=$(mktemp -d)
cat > "$CODEX_HOME/config.toml" <<'EOF'
model = "gpt-5.4"
model_provider = "local-proxy"

[model_providers.local-proxy]
name = "local-proxy"
base_url = "http://localhost:4399/v1"
wire_api = "responses"
EOF
codex exec "Reply with the single word: pong."
```

Expected: returns `pong` (or similar) with no error — codex was immune before and must remain clean after.

- [ ] **Step 4: AI-SDK smoke (the actual point)**

In a scratch directory with `@ai-sdk/openai` and `ai` installed (`npm i @ai-sdk/openai ai` or `bun add @ai-sdk/openai ai`):

```typescript
// smoke.ts
import { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'

const openai = createOpenAI({ baseURL: 'http://localhost:4399/v1', apiKey: 'unused' })

const result = streamText({
  model: openai.responses('gpt-5.4'),
  prompt: 'Reply with the single word: pong.',
  providerOptions: {
    openai: {
      store: false,
      include: ['reasoning.encrypted_content'],
      reasoningSummary: 'auto',
    },
  },
})

for await (const part of result.fullStream) {
  if (part.type === 'error')
    throw part.error
}
console.log('OK: no summaryParts crash; text =', await result.text)
```

Run: `bun run smoke.ts` (or `npx tsx smoke.ts`).
Expected: prints `OK: …` and the model's reply. **No `TypeError: undefined is not an object (evaluating 'S.summaryParts')`.** Running `opencode` (1.17.13) against the local proxy is an acceptable substitute for this step.

- [ ] **Step 5: Record results**

Note in the PR/description (or a follow-up comment) which smokes ran and their outcomes. If any smoke could not run (no tokens, no codex/opencode installed), state that explicitly rather than implying it passed.

---

## Notes / Out of Scope

- **Cross-turn reasoning persistence** (turn-2 replay of the reasoning item with the stable id + `encrypted_content`) is a documented follow-up, not gated on by this plan (per the spec's success bar: kill the crash).
- **Filing a `vercel/ai` upstream issue** is optional and out of scope.
- **Ship path** (context only, do not do here): bump `kura` → bump nixfiles `kura` input → redeploy the `yuki` host. Do not modify the consumer repo.

## Self-Review

**Spec coverage:**
- "Normalize proxy-side, first-seen id, per output_index" → Task 1 (`stableId` + `normalizeEvent`).
- Rewrite-rules table (all 5 event groups incl. final `output[]`) → Task 1 `normalizeEvent` switch, one case per group; verified by Task 1 tests.
- "Never modify encrypted_content/content/summary/call_id" → Task 1 tests assert `encrypted_content`, `summary`, `content`, and `call_id` preserved.
- Malformed/empty/no-`output_index` passthrough → Task 1 test 3.
- Integration in streaming branch only; abort/cancel preserved; request-signal untouched → Task 2 (surgical loop edit; Step 4 runs `request-signal-regression`).
- Non-streaming branch and `handleResponsesPassthrough` left alone → Task 2 Step 2 explicitly scopes the edit.
- Unit test modeled after existing tests → `tests/responses-passthrough-item-ids.test.ts`.
- Regression + typecheck + lint → Task 2 Steps 3–5.
- codex smoke + AI-SDK smoke (AGENTS.md requirement) → Task 3.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. No "similar to Task N".

**Type consistency:** `createResponsesItemIdNormalizer` / `rewrite` signatures match between Task 1 (definition) and Task 2 (call site). Field names (`output_index`, `item_id`, `item.id`, `response.output[].id`, `encrypted_content`, `call_id`) match the `ResponsesStreamEvent` union and `ResponsesOutputItem` in `create-responses.ts`. Test helper `parse`/`chunk` names are internally consistent.
