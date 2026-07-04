# Spec — Alias `codex-auto-review` to a Responses-capable model on `/responses`

- **Status:** approved design, ready for implementation plan
- **Branch:** `feat/codex-auto-review-alias`
- **Repo:** `ningw42/copilot-proxy` (v0.7.15)
- **Background:** `docs/HANDOFF-codex-auto-review-alias.md` (root cause, upstream Codex references)

## 1. Goal

Make OpenAI Codex's "auto-approve" reviewer work through this proxy.

With `approval_policy = "on-request"` and `approvals_reviewer = "auto_review"`, Codex
spins up a locked-down guardian sub-session that asks a model whether to approve a
pending tool call / command. That guardian model is hardcoded to **`codex-auto-review`**,
and Codex resolves it from its **bundled** catalog — so it issues a `/responses` request
for `codex-auto-review` regardless of what this proxy advertises at `/models`.

On GitHub Copilot, `codex-auto-review` is a **chat-completions-only** model. The proxy
does not translate `/chat/completions ↔ /responses` (by explicit design), so the guardian
request fails today with:

```
Model codex-auto-review cannot be reached via /responses. Supported backend(s):
/chat/completions. The proxy does not translate between /chat/completions and
other endpoints.
```

The fix: when a `/responses` request arrives for `codex-auto-review` **and** an alias
target is configured, rewrite the model to a Responses-capable model **before routing**.
The request then takes the existing **direct** path with no translation.

Why the fix must live here and not in Codex config is established in the handoff:
Codex's guardian session clones the parent provider (welded to this proxy), the model id
is a hardcoded `&'static str`, and `[auto_review]` in Codex's `config.toml` exposes only
`policy`. The proxy is the only clean lever.

## 2. Decisions (settled during brainstorming)

1. **Alias target:** `gpt-5.4-mini` — confirmed live and Responses-capable on the
   deployed instance. Cheaper fit for a frequent, bounded approve/deny task. (Codex
   requests `low` reasoning effort for the guardian when the target supports it.)
2. **Mechanism:** a value-bearing CLI flag `--codex-auto-review-model <model>`, following
   the existing `--github-token` / `--account-type` string-arg precedent (not the boolean
   `--normalize-openai-responses-item-ids` pattern).
3. **Default when the flag is unset:** **no alias.** Behavior is byte-for-byte identical
   to today — `codex-auto-review` still returns the 400 above. Opt-in, matching this
   repo's "off by default" philosophy for the item-id normalizer.
4. **Placement (approach B):** a dedicated, pure alias module called once from the
   `/responses` handler — testable in isolation, mirrors the `model-normalization.ts`
   precedent, keeps the handler clean.

## 3. Design

### 3.1 The alias unit — `src/lib/codex-auto-review-alias.ts` (new)

A pure function with a single purpose, no server/state/routing coupling:

```ts
import type { ResponsesPayload } from '~/services/copilot/create-responses'
import consola from 'consola'

/** The Codex guardian ("auto-approve" reviewer) model id. Codex resolves this
 *  from its bundled catalog and issues a /responses request for it regardless of
 *  what this proxy advertises at /models. */
export const CODEX_AUTO_REVIEW_MODEL = 'codex-auto-review'

/**
 * When the payload targets the Codex guardian model and an alias target is
 * configured, rewrite `payload.model` in place so the request routes to — and
 * is sent upstream as — the Responses-capable target.
 *
 * No-op (returns undefined) when:
 *  - `target` is unset (preserves today's behavior),
 *  - `payload.model` is not `codex-auto-review`, or
 *  - `target === codex-auto-review` (self-alias guard against misconfiguration).
 *
 * Returns the applied target on success, else undefined.
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

- **Depends on:** `ResponsesPayload` type + `consola` only.
- **Debug log** on fire, mirroring the handler's `consola.debug` style.
- **Self-alias guard** prevents an infinite/degenerate mapping if someone sets the flag to
  `codex-auto-review` itself.

### 3.2 Handler integration — `src/routes/responses/handler.ts`

One call at the top of `handleResponses`, immediately before model derivation:

```ts
applyCodexAutoReviewAlias(payload, state.codexAutoReviewModel)   // ← new
const requestedModel = payload.model
const effectiveModel = normalizeAnthropicModelName(requestedModel)
```

Because the function mutates `payload.model`, **every** downstream consumer follows
automatically:

- `resolveRoute('responses', effectiveModel, …)` sees the target and returns a `direct`
  route (`gpt-5.4-mini` supports `/responses`).
- `handleViaResponses(c, payload)` calls `createResponses(payload)` — and `payload.model`
  is what Copilot receives. This closes the handoff's §2 gotcha: aliasing only
  `effectiveModel` would pass routing but still send `codex-auto-review` upstream.

No other handler change. `handleResponsesPassthrough` is untouched — Codex's guardian uses
`POST /responses`, which is served by `handleResponses`.

### 3.3 Config wiring (value-bearing flag)

| File | Change |
|---|---|
| `src/lib/state.ts` | Add optional `codexAutoReviewModel?: string` to the `State` interface. No entry in the `state` object literal (optional → `undefined` = unset). |
| `src/start.ts` | Add `codexAutoReviewModel?: string` to `RunServerOptions`. Add a `'codex-auto-review-model'` string arg (no default). Thread `args['codex-auto-review-model']` through all **3** call sites: supervisor `fallbackConfig`, `daemonStart`, and `runServer`. |
| `src/daemon/config.ts` | Add `codexAutoReviewModel?: string` to `DaemonConfig`. Add a merge line `if (wasCliOptionPassed(rawArgs, 'codex-auto-review-model')) merged.codexAutoReviewModel = cliConfig.codexAutoReviewModel`. Add a validation guard `if (data.codexAutoReviewModel !== undefined && typeof data.codexAutoReviewModel !== 'string') return null` (undefined allowed — back-compat with configs written before this field existed). **Not** added to `DEFAULT_SERVICE_CONFIG` (optional → opt-in default falls out). No change to `saveDaemonConfig` — only `githubToken` is stripped; the model name persists normally. |
| `src/daemon/enable.ts` | In `buildServiceStartArgs`, `if (config.codexAutoReviewModel !== undefined) args.push('--codex-auto-review-model', config.codexAutoReviewModel)`. |
| `src/lib/server-setup.ts` | `state.codexAutoReviewModel = options.codexAutoReviewModel`. |

The flag is a non-secret string, so it is written to `daemon.json` and reloaded on service
restart — set once, applies across reboots.

### 3.4 Error handling / edge cases

- **Misconfigured target** (e.g. a chat-completions-only model): no special handling.
  After aliasing, `resolveRoute` throws the existing clear 400 for the *target* model.
  Fail-safe with a standard message.
- **No startup validation** that the target is served or Responses-capable. This avoids
  coupling to `state.models` and a race with the model-cache load, for marginal benefit;
  a bad value surfaces as the normal routing error on first use.
- **Non-`/responses` clients:** out of scope. The alias lives only in the `/responses`
  handler, the only path Codex's guardian uses.

## 4. Testing

- **New `tests/codex-auto-review-alias.test.ts`** (mirrors `tests/model-normalization.test.ts`):
  - alias fires when `payload.model === 'codex-auto-review'` and target is set → `payload.model` rewritten, returns target;
  - no-op when target is `undefined`;
  - no-op when `payload.model` is some other model;
  - self-alias guard: target `=== 'codex-auto-review'` → no-op.
- **Handler behavior** (mirrors `tests/responses-item-id-gate.test.ts`):
  - with `state.codexAutoReviewModel` set, a `codex-auto-review` `/responses` request
    resolves/routes as the target (proves the aliased model reaches routing **and**
    upstream — the §2 gotcha);
  - with it unset, the today-behavior 400 still fires.
- **Extend `tests/daemon-config.test.ts`:** new optional field validates and merges
  (present / absent / wrong-type).
- **Extend `tests/daemon-enable.test.ts`:** `buildServiceStartArgs` emits
  `--codex-auto-review-model <value>` when set, omits it when unset.

## 5. Non-goals

- **No** general `/responses ↔ /chat-completions` translation (the heavier option
  explicitly rejected; the alias sidesteps it).
- **No** changes to `src/routes/models/codex-compat.ts` — Codex resolves the guardian from
  its bundled catalog, so the `/models` list does not drive the request.
- **No** nixfiles / Codex-side changes; the Codex config
  (`approval_policy=on-request` + `approvals_reviewer=auto_review`) is already correct.

## 6. Verification

**Reproduce the failure (before the fix, or with the flag unset):**

```bash
curl -sS -N https://copilot.ningw.net/responses \
  -H 'content-type: application/json' \
  -d '{"model":"codex-auto-review","input":"Reply with the single word: pong.","stream":true}'
```

Expect the 400 `... cannot be reached via /responses. Supported backend(s):
/chat/completions ...`.

**Confirm the fix** (proxy started with `--codex-auto-review-model gpt-5.4-mini`): the same
curl streams a normal Responses SSE served by the alias target. Add a variant that includes
a `text.format` json_schema block to mirror the guardian payload shape and confirm
structured output survives.

**End-to-end:** with Codex (`approval_policy=on-request`, `approvals_reviewer=auto_review`)
pointed at this proxy, trigger an action that needs approval and confirm the guardian
assessment resolves (approve/deny) instead of erroring — Codex surfaces a
`GuardianAssessment` / "Automatic approval review approved/denied …" line when it works.

## 7. Reference map

- `src/routes/responses/handler.ts` — `handleResponses` (call site), `handleViaResponses`
  → `createResponses(payload)` (the upstream model source).
- `src/lib/routing-policy.ts` — `resolveRoute`; prefers live `state.models`
  `supported_endpoints`, falls back to static config.
- `src/lib/model-config.ts` — per-model `supportedApis`.
- `src/lib/state.ts`, `src/start.ts`, `src/daemon/config.ts`, `src/daemon/enable.ts`,
  `src/lib/server-setup.ts` — config surfaces to extend.
- `src/routes/messages/model-normalization.ts` — precedent for a pure model-rewrite unit.
