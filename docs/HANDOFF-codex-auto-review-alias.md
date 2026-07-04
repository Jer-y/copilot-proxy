# HANDOFF — Alias `codex-auto-review` to a Responses-capable model in `/responses`

> Kickstart prompt for an agent picking this up cold. Read the whole thing before
> touching code. The change is small and well-scoped, but there is **one decision
> left open on purpose** (which model to alias to — see §5); the human will make it
> or tell you to. Repo: `ningw42/copilot-proxy` (this checkout, v0.7.15,
> branch `fix/stabilize-responses-item-ids`).

## 1. Goal

Make OpenAI **Codex**'s "auto-approve" reviewer work through this proxy.

Codex 0.142.x has an approval-reviewer feature: with `approval_policy = "on-request"`
and `approvals_reviewer = "auto_review"`, instead of prompting the human, Codex spins
up a locked-down "guardian" sub-session that asks a model whether to approve the
pending tool call / command. That guardian model is **`codex-auto-review`**.

Against this proxy, the guardian request fails. We want it to succeed by **aliasing
`codex-auto-review` to a Responses-capable model** at the proxy, so the guardian's
`/responses` call flows through the normal direct-Responses path.

## 2. Root cause (verified against both codebases, not hypothesized)

**Why the model can't be re-pointed on the Codex side (so it must be fixed here).**
Codex builds the guardian sub-session with
`build_guardian_review_session_config(parent_config, …)`
(`codex-rs/core/src/guardian/review_session.rs`). That function **clones the parent
session config and overrides only `model` + reasoning effort — it keeps
`model_provider`.** So the guardian is welded to Codex's main provider, which for the
human's setup is this proxy with `wire_api = "responses"`. There is **no** per-guardian
provider / endpoint / wire_api knob in Codex config:

- `[auto_review]` in `config.toml` accepts only `policy` (extra prompt text) —
  `codex-rs/config/src/config_toml.rs` → `struct AutoReviewToml { policy }`.
- The guardian's model id is the hardcoded `DEFAULT_APPROVAL_REVIEW_PREFERRED_MODEL =
  "codex-auto-review"` (`codex-rs/model-provider/src/provider.rs`) — a `&'static str`,
  overridable only by specific built-in providers (e.g. Bedrock), not by TOML.
- `codex-auto-review` is a **bundled** catalog entry
  (`codex-rs/models-manager/models.json`), so Codex resolves it and issues a
  `/responses` request for it regardless of what this proxy advertises at `/models`.
  (Confirmed reference commit: codex `98d28aab54ed86714901b6619400598598876dd0`.)

So the only clean lever is here, at the proxy.

**Why it fails here today.** On GitHub Copilot, `codex-auto-review` is a
**chat-completions-only** model. When a `/responses` request arrives for it:

- `handleResponses` (`src/routes/responses/handler.ts:41`) computes
  `effectiveModel` and calls `resolveRoute('responses', effectiveModel, …)`
  (`handler.ts:56-60`).
- `resolveRoute` (`src/lib/routing-policy.ts:54`) sees `supportedApis =
  {chat-completions}` for the model, and **by explicit design the proxy refuses to
  translate `/chat/completions ↔ /responses`** (see the doc comment at
  `routing-policy.ts:33-52` and the `case 'chat-completions'` guard at
  `handler.ts:69-73`). It throws via `buildUnsupportedClientApiError`
  (`routing-policy.ts:146-156`):

  ```
  Model codex-auto-review cannot be reached via /responses. Supported backend(s):
  /chat/completions. The proxy does not translate between /chat/completions and
  other endpoints.
  ```

  That is exactly the error the human hit.

**Note on `/models`.** `src/routes/models/codex-compat.ts` already **drops**
`codex-auto-review` from the Codex-facing model list (its `modelSupportsResponses`
filter excludes chat-completions-only models). That is *not* sufficient: Codex resolves
the guardian model from its **bundled** catalog, not from our `/models`, so it requests
`codex-auto-review` anyway. The alias below is the reliable fix.

## 3. The idea

When a `/responses` request comes in for `codex-auto-review`, **rewrite the model to a
Responses-capable model before routing.** Because the target model natively supports
`/responses` on Copilot, the request then takes the existing **direct** path
(`handleViaResponses → createResponses`) with **no translation** — the guardian's
strict structured-output schema (`text.format` / json_schema), streaming, reasoning,
`store:false`, etc. are all handled natively by Copilot's `/responses` for the target
model. That's the whole elegance: alias → direct path → done.

This is the "route the reviewer to a supported model" option, implemented at the layer
where it's a few lines instead of a fragile per-model catalog override on the Codex side.

## 4. Where to make the change (candidate insertion points — you decide the design)

The alias must be applied **before `resolveRoute`** so the swapped, Responses-capable
model is what gets routed, and it must mutate the value that actually goes **upstream**.

⚠️ **Gotcha — rewrite `payload.model`, not just `effectiveModel`.** In
`handleViaResponses` the *original* `payload` is passed to `createResponses(payload)`
(`handler.ts:128-129`), so **`payload.model` is what Copilot receives.** `effectiveModel`
today is only used for routing + max-token lookup. If you alias only `effectiveModel`,
routing will pass but Copilot will still get `codex-auto-review` and reject it. Rewrite
`payload.model` (and let `effectiveModel` follow), or thread the resolved model through.

Candidate placements:

- **A — inline in `handleResponses`** (`handler.ts:56`): a small alias step right where
  `requestedModel` / `effectiveModel` are derived. Minimal, local, easy to test.
- **B — a dedicated normalizer** parallel to
  `src/routes/messages/model-normalization.ts` (`normalizeAnthropicModelName`), e.g. a
  `normalizeResponsesModelName` or a shared alias map in `src/lib/`. Cleaner if you
  expect more reviewer/system-model aliases later (see §6). The Responses handler
  already imports `normalizeAnthropicModelName` at `handler.ts:34`, so there's a
  precedent for a normalization step in this file.

Either way: keep it a pure string→string map, log at `consola.debug` when an alias
fires (mirror the style already used in the handler), and add a unit test.

Responses-capable models currently known to the proxy (`src/lib/model-config.ts`,
`supportedApis` includes `'responses'`): `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5-mini`,
`gpt-5-codex`, `gpt-5.4`, `gpt-5.5`, `gpt-5.1-codex`, `gpt-5.2-codex`, … Use the live
`state.models` list to confirm what Copilot is actually serving at runtime rather than
trusting the static config alone.

## 5. Decision left open (do NOT pick this yourself unless told)

**Which model `codex-auto-review` aliases to.** The human is keeping this choice.
Considerations to surface for them:

- `gpt-5.5` — the human's current main Codex model; guaranteed served + Responses-only.
  Safe default, but full-size (reviews are frequent and cheap-ish since Codex requests
  `low` reasoning effort when the target supports it — see
  `guardian_review_session_config` in `codex-rs/core/src/guardian/review.rs`).
- A smaller Responses-capable model (e.g. `gpt-5-mini`) — cheaper per review. `gpt-5.4`
  exists in `model-config.ts` but was dropped from the human's agent configs; `gpt-5.4-mini`
  is **not** wired here. Verify against live `state.models` before proposing.

Confirm the chosen target supports **structured outputs / json_schema on Copilot's
`/responses`** (the guardian sends a strict schema). GPT-5.x Responses models do; verify.

## 6. Scope / non-goals

- **Do NOT** build a general `/responses ↔ /chat-completions` translation. That is the
  *other*, heavier option we explicitly rejected for this task. The alias sidesteps it.
- **Do NOT** touch the human's nixfiles `codex.nix`. The Codex-side change there
  (`approval_policy = "on-request"` + `approvals_reviewer = "auto_review"`) is already
  correct and satisfies Codex's `routes_approval_to_guardian` predicate. The only gap is
  this proxy not serving the reviewer model.
- Optional stretch (mention, don't necessarily do): if you want Codex to also *see*
  `codex-auto-review` as available at `/models`, you could stop dropping it in
  `codex-compat.ts` and present it with the alias target's capabilities. Not required for
  the fix; the bundled-catalog resolution already drives the request.
- Consider whether the alias should be Responses-path-only (it only ever arrives via
  `/responses`, since Codex uses `wire_api: responses`) or a shared table. Responses-only
  is sufficient.

## 7. Verify

**Reproduce the failure (before the fix):**

```bash
# copilot.ningw.net is the deployed instance (LAN-only, no inbound auth).
# Or run locally and point at your local port.
curl -sS -N https://copilot.ningw.net/responses \
  -H 'content-type: application/json' \
  -d '{"model":"codex-auto-review","input":"Reply with the single word: pong.","stream":true}'
```

Expect the 400 `... cannot be reached via /responses. Supported backend(s):
/chat/completions ...` from §2.

**Confirm the fix:** the same curl should now stream a normal Responses SSE (served by
the alias target). Add a `curl` that also sends a `text.format` json_schema block to
mirror the guardian payload shape, and confirm structured output survives.

**End-to-end (the real thing):** with the human's Codex (`approval_policy=on-request`,
`approvals_reviewer=auto_review`) pointed at this proxy, trigger an action that needs
approval and confirm the guardian assessment resolves (approve/deny) instead of erroring.
Codex surfaces a `GuardianAssessment` / "Automatic approval review approved/denied …"
line when it works.

## 8. Reference map

**This repo (copilot-proxy, v0.7.15):**
- `src/routes/responses/handler.ts` — `handleResponses` (`:41`), routing call (`:56-60`),
  chat-completions rejection guard (`:69-73`), direct path `handleViaResponses` (`:128`).
- `src/lib/routing-policy.ts` — `resolveRoute` (`:54`), no-translate policy comment
  (`:33-52`), exact error builder (`:146-156`).
- `src/lib/model-config.ts` — per-model `supportedApis` (Responses-capable list, `:108+`).
- `src/routes/messages/model-normalization.ts` — `normalizeAnthropicModelName`, precedent
  for a model-rewrite step.
- `src/routes/models/codex-compat.ts` — Codex `/models` compat; already drops
  chat-completions-only models via `modelSupportsResponses`.

**Upstream Codex (for context; ref `98d28aab54ed86714901b6619400598598876dd0`):**
- `codex-rs/model-provider/src/provider.rs` — `DEFAULT_APPROVAL_REVIEW_PREFERRED_MODEL =
  "codex-auto-review"`, `approval_review_preferred_model()`.
- `codex-rs/core/src/guardian/review.rs` — `guardian_review_session_config`: resolves the
  review model; falls back to the main model slug when the review model isn't in the
  catalog; sets `low` reasoning effort when supported.
- `codex-rs/core/src/guardian/review_session.rs` — `build_guardian_review_session_config`:
  clones parent config, keeps `model_provider`.
- `codex-rs/models-manager/models.json` — bundled `codex-auto-review` entry.
- `codex-rs/config/src/config_toml.rs` — `AutoReviewToml { policy }` (only field).
