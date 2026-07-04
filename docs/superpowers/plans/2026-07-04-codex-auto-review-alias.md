# codex-auto-review Alias Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `/responses` request for `codex-auto-review` (Codex's guardian "auto-approve" reviewer) succeed by rewriting the model to a configurable Responses-capable target before routing.

**Architecture:** A pure helper (`applyCodexAutoReviewAlias`) mutates `payload.model` at the top of the `/responses` handler — before routing and before the upstream call — so both see the aliased model. The target is supplied by a new value-bearing CLI flag `--codex-auto-review-model`, threaded through the same config surfaces as the existing `--normalize-openai-responses-item-ids` flag. Unset ⇒ no alias ⇒ behavior identical to today.

**Tech Stack:** TypeScript, Hono, `bun:test`, citty (CLI), consola (logging).

**Spec:** `docs/superpowers/specs/2026-07-04-codex-auto-review-alias-design.md`

## Global Constraints

- **bun is not on PATH by default.** Run `export PATH="$HOME/.bun/bin:$PATH"` once at the start of the session. This makes `bun` available for tests **and** lets the git pre-commit hook (`bun run lint --fix`) succeed — do **not** use `git commit --no-verify` for code commits.
- **Alias target for this project:** `gpt-5.4-mini` (used in tests and docs examples; confirmed live + Responses-capable).
- **Guardian model id:** `codex-auto-review` (literal; exported as `CODEX_AUTO_REVIEW_MODEL`).
- **Default = opt-in:** when `--codex-auto-review-model` is unset, no alias fires and `codex-auto-review` returns today's `400 ... cannot be reached via /responses`.
- **Test runner:** `bun test <path>`. **Typecheck:** `bun run typecheck`. **Lint:** `bun run lint`.
- Follow existing patterns: `~` path alias in `src/`, relative `../src/...` imports in `tests/`, `bun:test` (`describe`/`test`/`expect`/`mock`).

---

### Task 1: Alias helper + unit tests

**Files:**
- Create: `src/lib/codex-auto-review-alias.ts`
- Test: `tests/codex-auto-review-alias.test.ts`

**Interfaces:**
- Consumes: `ResponsesPayload` from `~/services/copilot/create-responses` (fields used: `model: string`).
- Produces:
  - `export const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review'`
  - `export function applyCodexAutoReviewAlias(payload: ResponsesPayload, target: string | undefined): string | undefined` — mutates `payload.model` in place when it equals `CODEX_AUTO_REVIEW_MODEL` and `target` is a different truthy string; returns the applied target, else `undefined`.

- [ ] **Step 1: Write the failing test**

Create `tests/codex-auto-review-alias.test.ts`:

```ts
import type { ResponsesPayload } from '../src/services/copilot/create-responses'

import { describe, expect, test } from 'bun:test'

import { applyCodexAutoReviewAlias, CODEX_AUTO_REVIEW_MODEL } from '../src/lib/codex-auto-review-alias'

function payloadFor(model: string): ResponsesPayload {
  return { model, input: 'ping' }
}

describe('applyCodexAutoReviewAlias', () => {
  test('rewrites codex-auto-review to the configured target', () => {
    const payload = payloadFor(CODEX_AUTO_REVIEW_MODEL)
    const applied = applyCodexAutoReviewAlias(payload, 'gpt-5.4-mini')
    expect(applied).toBe('gpt-5.4-mini')
    expect(payload.model).toBe('gpt-5.4-mini')
  })

  test('is a no-op when the target is undefined', () => {
    const payload = payloadFor(CODEX_AUTO_REVIEW_MODEL)
    const applied = applyCodexAutoReviewAlias(payload, undefined)
    expect(applied).toBeUndefined()
    expect(payload.model).toBe(CODEX_AUTO_REVIEW_MODEL)
  })

  test('leaves other models unchanged', () => {
    const payload = payloadFor('gpt-5.5')
    const applied = applyCodexAutoReviewAlias(payload, 'gpt-5.4-mini')
    expect(applied).toBeUndefined()
    expect(payload.model).toBe('gpt-5.5')
  })

  test('does not alias the guardian model to itself', () => {
    const payload = payloadFor(CODEX_AUTO_REVIEW_MODEL)
    const applied = applyCodexAutoReviewAlias(payload, CODEX_AUTO_REVIEW_MODEL)
    expect(applied).toBeUndefined()
    expect(payload.model).toBe(CODEX_AUTO_REVIEW_MODEL)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/codex-auto-review-alias.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/codex-auto-review-alias'` (module not created yet).

- [ ] **Step 3: Write the helper**

Create `src/lib/codex-auto-review-alias.ts`:

```ts
import type { ResponsesPayload } from '~/services/copilot/create-responses'

import consola from 'consola'

/**
 * The Codex guardian ("auto-approve" reviewer) model id. Codex resolves this
 * from its bundled catalog and issues a /responses request for it regardless of
 * what this proxy advertises at /models, so the alias must live at the proxy.
 */
export const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review'

/**
 * When the payload targets the Codex guardian model and an alias target is
 * configured, rewrite `payload.model` in place so the request routes to — and
 * is sent upstream as — the Responses-capable target.
 *
 * No-op (returns undefined) when the target is unset, the model does not match,
 * or the target is the guardian model itself (self-alias guard against
 * misconfiguration).
 *
 * Returns the applied target on success, otherwise undefined.
 */
export function applyCodexAutoReviewAlias(
  payload: ResponsesPayload,
  target: string | undefined,
): string | undefined {
  if (
    !target
    || payload.model !== CODEX_AUTO_REVIEW_MODEL
    || target === CODEX_AUTO_REVIEW_MODEL
  ) {
    return undefined
  }

  consola.debug(`Aliasing /responses model ${CODEX_AUTO_REVIEW_MODEL} → ${target}`)
  payload.model = target
  return target
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/codex-auto-review-alias.test.ts`
Expected: PASS — 4 tests pass.

- [ ] **Step 5: Commit**

```bash
export PATH="$HOME/.bun/bin:$PATH"
git add src/lib/codex-auto-review-alias.ts tests/codex-auto-review-alias.test.ts
git commit -m "feat: add codex-auto-review /responses alias helper"
```

---

### Task 2: State field + handler integration + route test

**Files:**
- Modify: `src/lib/state.ts` (add optional field to `State` interface)
- Modify: `src/routes/responses/handler.ts` (import + one call in `handleResponses`)
- Test: `tests/codex-auto-review-alias-route.test.ts` (create)

**Interfaces:**
- Consumes: `applyCodexAutoReviewAlias` (Task 1); `state.codexAutoReviewModel` (added this task); `server` from `~/server`.
- Produces: `State.codexAutoReviewModel?: string` — read by the `/responses` handler; set later by config wiring (Task 4).

- [ ] **Step 1: Add the state field**

In `src/lib/state.ts`, add to the `State` interface immediately after the `normalizeOpenAIResponsesItemIds: boolean` field (around line 20):

```ts
  /**
   * When set, `/responses` requests for `codex-auto-review` (the Codex guardian
   * reviewer, resolved from Codex's bundled catalog) are aliased to this
   * Responses-capable model. Unset = no alias (codex-auto-review remains
   * unreachable via /responses — today's behavior). Set via
   * `--codex-auto-review-model`.
   */
  codexAutoReviewModel?: string
```

Do **not** add it to the `state` object literal — it is optional and defaults to `undefined`.

- [ ] **Step 2: Write the failing route test**

Create `tests/codex-auto-review-alias-route.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '../src/lib/state'
import { server } from '../src/server'

const originalFetch = globalThis.fetch
const originalAlias = state.codexAutoReviewModel

const COMPLETED_SSE = `event: response.completed\ndata: ${JSON.stringify({
  type: 'response.completed',
  response: {
    id: 'resp_1',
    object: 'response',
    model: 'gpt-5.4-mini',
    status: 'completed',
    output: [],
  },
})}\n\n`

let lastUpstreamBody: { model?: string } | undefined

const fetchMock = mock(async (url: string, init?: { body?: unknown }): Promise<Response> => {
  if (!url.endsWith('/responses')) {
    throw new Error(`Unexpected upstream URL: ${url}`)
  }
  lastUpstreamBody = typeof init?.body === 'string'
    ? JSON.parse(init.body) as { model?: string }
    : undefined
  return new Response(COMPLETED_SSE, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
})

beforeEach(() => {
  fetchMock.mockClear()
  lastUpstreamBody = undefined
  state.lastRequestTimestamp = undefined
  state.models = undefined
  state.copilotToken = 'test-token'
  state.vsCodeVersion = '1.0.0'
  state.accountType = 'individual'
  // @ts-expect-error test mock only needs a callable fetch shape
  globalThis.fetch = fetchMock
})

afterEach(() => {
  globalThis.fetch = originalFetch
  state.codexAutoReviewModel = originalAlias
})

async function postCodexAutoReview(): Promise<Response> {
  return server.request('/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'codex-auto-review', input: 'ping', stream: true }),
  })
}

describe('codex-auto-review alias on /responses', () => {
  test('aliases to the configured model and sends it upstream when set', async () => {
    state.codexAutoReviewModel = 'gpt-5.4-mini'
    const response = await postCodexAutoReview()
    expect(response.status).toBe(200)
    await response.text()
    expect(fetchMock).toHaveBeenCalled()
    expect(lastUpstreamBody?.model).toBe('gpt-5.4-mini')
  })

  test('returns the today-behavior 400 when the alias is unset', async () => {
    state.codexAutoReviewModel = undefined
    const response = await postCodexAutoReview()
    expect(response.status).toBe(400)
    const body = await response.text()
    expect(body).toContain('cannot be reached via /responses')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test to verify the "set" case fails**

Run: `bun test tests/codex-auto-review-alias-route.test.ts`
Expected: FAIL on "aliases to the configured model …" — the handler does not yet apply the alias, so `codex-auto-review` still hits the routing guard and returns `400` (received status 400, expected 200). The "unset" test PASSES (that is already today's behavior).

- [ ] **Step 4: Wire the alias into the handler**

In `src/routes/responses/handler.ts`, add the import alongside the other `~/lib` imports (near line 28):

```ts
import { applyCodexAutoReviewAlias } from '~/lib/codex-auto-review-alias'
```

Then in `handleResponses`, insert the call immediately before `const requestedModel = payload.model` (currently line 56):

```ts
  applyCodexAutoReviewAlias(payload, state.codexAutoReviewModel)
  const requestedModel = payload.model
  const effectiveModel = normalizeAnthropicModelName(requestedModel)
```

(`state` is already imported in this file.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/codex-auto-review-alias-route.test.ts`
Expected: PASS — both tests pass.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/state.ts src/routes/responses/handler.ts tests/codex-auto-review-alias-route.test.ts
git commit -m "feat: alias codex-auto-review to configured model on /responses"
```

---

### Task 3: Daemon config + native-service plumbing

**Files:**
- Modify: `src/daemon/config.ts` (interface + merge + validation)
- Modify: `src/daemon/enable.ts` (`buildServiceStartArgs`)
- Test: `tests/daemon-config.test.ts` (extend)
- Test: `tests/daemon-enable.test.ts` (extend)

**Interfaces:**
- Consumes: `wasCliOptionPassed` (existing, in `config.ts`).
- Produces: `DaemonConfig.codexAutoReviewModel?: string` — persisted in `daemon.json` (not stripped), re-emitted as `--codex-auto-review-model <value>` by `buildServiceStartArgs`, and overridable via `mergeDaemonConfigWithExplicitFlags`.

- [ ] **Step 1: Write the failing config tests**

In `tests/daemon-config.test.ts`, extend the import on line 6 to include the merge function:

```ts
import { loadDaemonConfig, loadDaemonConfigWithRecovery, MAX_DAEMON_CONFIG_BACKUPS, mergeDaemonConfigWithExplicitFlags, saveDaemonConfig } from '../src/daemon/config'
```

Then add this block at the end of the file (after the last `describe`):

```ts
describe('codexAutoReviewModel config field', () => {
  test('persists codexAutoReviewModel in the config file', () => {
    const config = { ...sampleConfig, codexAutoReviewModel: 'gpt-5.4-mini' }
    saveDaemonConfig(config)
    expect(loadDaemonConfig()).toEqual({ ...sampleConfig, codexAutoReviewModel: 'gpt-5.4-mini' })
  })

  test('returns null for a non-string codexAutoReviewModel', () => {
    saveDaemonConfig(sampleConfig)
    fs.writeFileSync(PATHS.DAEMON_JSON, JSON.stringify({ ...sampleConfig, codexAutoReviewModel: 123 }))
    expect(loadDaemonConfig()).toBeNull()
  })

  test('explicit --codex-auto-review-model overrides the saved value', () => {
    const fileConfig = { ...sampleConfig, codexAutoReviewModel: 'gpt-5.5' }
    const cliConfig = { ...sampleConfig, codexAutoReviewModel: 'gpt-5.4-mini' }
    const merged = mergeDaemonConfigWithExplicitFlags(
      fileConfig,
      cliConfig,
      ['--codex-auto-review-model', 'gpt-5.4-mini'],
    )
    expect(merged.codexAutoReviewModel).toBe('gpt-5.4-mini')
  })

  test('keeps the saved codexAutoReviewModel when the flag is absent', () => {
    const fileConfig = { ...sampleConfig, codexAutoReviewModel: 'gpt-5.5' }
    const cliConfig = { ...sampleConfig, codexAutoReviewModel: undefined }
    const merged = mergeDaemonConfigWithExplicitFlags(fileConfig, cliConfig, [])
    expect(merged.codexAutoReviewModel).toBe('gpt-5.5')
  })
})
```

- [ ] **Step 2: Write the failing enable tests**

In `tests/daemon-enable.test.ts`, add these two tests inside the `describe('buildServiceStartArgs', …)` block (after the existing `omits --normalize…` test):

```ts
  test('emits --codex-auto-review-model with its value when set', () => {
    const args = buildServiceStartArgs('/tmp/main.js', {
      ...baseConfig,
      codexAutoReviewModel: 'gpt-5.4-mini',
    })
    const flagIndex = args.indexOf('--codex-auto-review-model')
    expect(flagIndex).toBeGreaterThanOrEqual(0)
    expect(args[flagIndex + 1]).toBe('gpt-5.4-mini')
  })

  test('omits --codex-auto-review-model when unset', () => {
    const args = buildServiceStartArgs('/tmp/main.js', baseConfig)
    expect(args).not.toContain('--codex-auto-review-model')
  })
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test tests/daemon-config.test.ts tests/daemon-enable.test.ts`
Expected: FAIL — the persist test sees `codexAutoReviewModel` dropped on load (field not yet in the validator/type), the merge tests find `undefined`, and the enable test finds no `--codex-auto-review-model` in the args. (Type errors on `codexAutoReviewModel` are also expected until Step 4.)

- [ ] **Step 4: Add the field to `DaemonConfig` and the merge/validation logic**

In `src/daemon/config.ts`:

(a) Add to the `DaemonConfig` interface, immediately after `normalizeOpenAIResponsesItemIds: boolean` (around line 22):

```ts
  codexAutoReviewModel?: string
```

(b) In `mergeDaemonConfigWithExplicitFlags`, add after the `normalize-openai-responses-item-ids` merge line (around line 84):

```ts
  if (wasCliOptionPassed(rawArgs, 'codex-auto-review-model'))
    merged.codexAutoReviewModel = cliConfig.codexAutoReviewModel
```

(c) In `validateDaemonConfig`, add immediately before `return data as unknown as DaemonConfig` (after the `githubToken` check, around line 236):

```ts
  if (data.codexAutoReviewModel !== undefined && typeof data.codexAutoReviewModel !== 'string')
    return null
```

Do **not** add it to `DEFAULT_SERVICE_CONFIG` (optional ⇒ defaults to `undefined` ⇒ opt-in). Do **not** change `saveDaemonConfig` (only `githubToken` is stripped; the model name persists).

- [ ] **Step 5: Emit the flag from `buildServiceStartArgs`**

In `src/daemon/enable.ts`, add inside `buildServiceStartArgs` after the `normalizeOpenAIResponsesItemIds` push (around line 40):

```ts
  if (config.codexAutoReviewModel !== undefined)
    args.push('--codex-auto-review-model', config.codexAutoReviewModel)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test tests/daemon-config.test.ts tests/daemon-enable.test.ts`
Expected: PASS — all new and existing tests pass.

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/daemon/config.ts src/daemon/enable.ts tests/daemon-config.test.ts tests/daemon-enable.test.ts
git commit -m "feat: persist and re-emit --codex-auto-review-model in daemon config"
```

---

### Task 4: CLI flag + foreground option threading

**Files:**
- Modify: `src/start.ts` (`RunServerOptions`, arg definition, 3 call sites)
- Modify: `src/lib/server-setup.ts` (assign option to `state`)
- Modify: `README.md` (document the flag in the `start` options table)

**Interfaces:**
- Consumes: `DaemonConfig.codexAutoReviewModel` (Task 3), `State.codexAutoReviewModel` (Task 2), `args['codex-auto-review-model']` (citty string arg).
- Produces: `RunServerOptions.codexAutoReviewModel?: string`; the flag now flows CLI → `state.codexAutoReviewModel` on both foreground and supervisor paths, closing the loop so the Task 2 behavior is reachable in production.

- [ ] **Step 1: Add the field to `RunServerOptions`**

In `src/start.ts`, add to the `RunServerOptions` interface after `normalizeOpenAIResponsesItemIds: boolean` (around line 35):

```ts
  codexAutoReviewModel?: string
```

- [ ] **Step 2: Define the CLI arg**

In `src/start.ts`, inside the `args` object, add a new entry after the `'normalize-openai-responses-item-ids'` block and before `'daemon'` (around line 253):

```ts
    'codex-auto-review-model': {
      type: 'string',
      description:
        'Alias the Codex guardian reviewer model (codex-auto-review) to this Responses-capable model on /responses. Unset = no alias (codex-auto-review remains unreachable via /responses). Example: gpt-5.4-mini',
    },
```

- [ ] **Step 3: Thread the arg through all three call sites**

In `src/start.ts`, add `codexAutoReviewModel: args['codex-auto-review-model'],` immediately after each existing `normalizeOpenAIResponsesItemIds: args['normalize-openai-responses-item-ids'],` line. There are three:

1. The supervisor `fallbackConfig` object (around line 327):

```ts
        normalizeOpenAIResponsesItemIds: args['normalize-openai-responses-item-ids'],
        codexAutoReviewModel: args['codex-auto-review-model'],
```

2. The `daemonStart({ … })` call (around line 394):

```ts
        normalizeOpenAIResponsesItemIds: args['normalize-openai-responses-item-ids'],
        codexAutoReviewModel: args['codex-auto-review-model'],
```

3. The `runServer({ … })` call (around line 414):

```ts
      normalizeOpenAIResponsesItemIds: args['normalize-openai-responses-item-ids'],
      codexAutoReviewModel: args['codex-auto-review-model'],
```

- [ ] **Step 4: Assign the option to state during server init**

In `src/lib/server-setup.ts`, add after `state.normalizeOpenAIResponsesItemIds = options.normalizeOpenAIResponsesItemIds` (line 36):

```ts
  state.codexAutoReviewModel = options.codexAutoReviewModel
```

- [ ] **Step 5: Document the flag in the README**

In `README.md`, the `start` command options table (currently lines 257–274) documents every flag. Add a row for the new flag immediately after the `--normalize-openai-responses-item-ids` row and before the `--daemon` row:

```markdown
| --codex-auto-review-model | Alias the Codex guardian reviewer model (`codex-auto-review`) to this Responses-capable model on `/responses`. Unset = no alias (`codex-auto-review` remains unreachable via `/responses`). Example: `gpt-5.4-mini` | none | none  |
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors. (The supervisor path spreads `DaemonConfig` into `RunServerOptions`; both now carry `codexAutoReviewModel`, so the spread type-checks.)

- [ ] **Step 7: Verify the flag appears in CLI help**

Run: `bun run ./src/main.ts start --help`
Expected: output includes a `--codex-auto-review-model` line with the description text.

- [ ] **Step 8: Run the full test suite**

Run: `bun test`
Expected: PASS — entire suite green (including Task 1–3 tests). If any pre-existing `tests/live/` tests require live Copilot credentials and are skipped/failing in this environment, note that they are unrelated to this change.

- [ ] **Step 9: Commit**

```bash
git add src/start.ts src/lib/server-setup.ts README.md
git commit -m "feat: add --codex-auto-review-model CLI flag"
```

---

### Task 5: Manual verification (optional, needs live Copilot)

**Files:** none (verification only).

This mirrors the spec's §6. It requires a running proxy authenticated to Copilot, so it is optional here and best run by the human on the deployed instance.

- [ ] **Step 1: Reproduce today's behavior (alias unset)**

Start the proxy without the flag, then:

```bash
curl -sS -N http://localhost:4399/responses \
  -H 'content-type: application/json' \
  -d '{"model":"codex-auto-review","input":"Reply with the single word: pong.","stream":true}'
```

Expected: `400` with `... cannot be reached via /responses. Supported backend(s): /chat/completions ...`.

- [ ] **Step 2: Confirm the fix (alias set)**

Restart with `--codex-auto-review-model gpt-5.4-mini`, then re-run the same curl.
Expected: a normal Responses SSE stream (served by `gpt-5.4-mini`).

- [ ] **Step 3: Confirm structured output survives**

Re-run with a `text.format` json_schema block added to the payload (mirrors the guardian's strict-schema request); confirm the structured response streams without error.

- [ ] **Step 4: End-to-end with Codex**

With Codex (`approval_policy=on-request`, `approvals_reviewer=auto_review`) pointed at this proxy, trigger an action needing approval; confirm Codex surfaces a `GuardianAssessment` / "Automatic approval review approved/denied …" line instead of erroring.

---

## Self-Review

**Spec coverage:**
- §3.1 alias unit → Task 1. ✓
- §3.2 handler integration (rewrite `payload.model` before routing + upstream) → Task 2. ✓
- §3.3 config wiring: `state.ts` → Task 2; `daemon/config.ts` + `daemon/enable.ts` → Task 3; `start.ts` (RunServerOptions, arg, 3 sites) + `server-setup.ts` → Task 4. ✓
- §3.4 error handling (misconfigured target falls through to standard routing 400; no startup validation) → covered by design (no code); the unset-400 path is asserted in Task 2. ✓
- §4 testing: alias unit test → Task 1; handler behavior → Task 2; daemon-config + daemon-enable extensions → Task 3. ✓
- §5 non-goals: no translation, no `codex-compat.ts` change, no nixfiles change — respected (no such tasks). ✓
- §6 verification → Task 5. ✓
- Docs (repo convention, not in spec): user-facing flag documented in the `README.md` `start`-options table → Task 4 Step 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every run step shows an exact command and expected result. ✓

**Type consistency:** `CODEX_AUTO_REVIEW_MODEL` and `applyCodexAutoReviewAlias(payload, target)` are defined in Task 1 and consumed with the same signature in Task 2. `codexAutoReviewModel?: string` is spelled identically across `State` (Task 2), `DaemonConfig` (Task 3), and `RunServerOptions` (Task 4). CLI key `'codex-auto-review-model'` and flag `--codex-auto-review-model` are consistent across Tasks 3–4. ✓
