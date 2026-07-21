# AGENTS.md

## Build, Lint, and Test Commands

- **Build:**
  `bun run build` (uses tsdown)
- **Dev:**
  `bun run dev` (runs `start` subcommand with file watching)
- **Start (prod):**
  `bun run start` (runs `start` subcommand in production mode)
- **Lint:**
  `bun run lint` (checks with @antfu/eslint-config)
- **Lint & Fix:**
  `bun run lint --fix` for the full tree, or `bunx lint-staged` for staged files
- **Typecheck:**
  `bun run typecheck`
- **Unused/dependency scan:**
  `bun run knip`
- **Audit dependencies:**
  `bun run audit`
- **Test all:**
  `bun test`
- **Test with coverage gate:**
  `bun run test:coverage` (enforces the repository floor from `bunfig.toml`)
- **Test single file:**
  `bun test tests/messages-routing.test.ts`
- **Common targeted tests:**
  `bun test tests/create-responses.test.ts` for Responses routing/translation, `bun test tests/messages-routing.test.ts` for Anthropic messages, `bun test tests/model-config.test.ts` for model metadata, `bun test tests/copilot-auth-recovery.test.ts tests/auth-recovery-routes.test.ts` for token self-healing/circuit behavior, `bun test tests/concurrency-limiter.test.ts` for bounded concurrency, and `bun test tests/request-signal-regression.test.ts` for inbound request-signal regressions
- **Responses WebSocket tests:**
  `bun test tests/responses-websocket.test.ts tests/responses-websocket-upgrade.test.ts tests/responses-websocket-upstream.test.ts tests/copilot-responses-transport-parity.test.ts tests/routing-policy.test.ts tests/models-route.test.ts tests/copilot-auth-recovery.test.ts tests/start-shutdown.test.ts` covers the downstream session, Host/Origin Upgrade policy, authenticated upstream handshake, SSE/WSS parity classification, live-model gating, Codex catalog flags, recovery/lease behavior, and shutdown; `bun run test:node:http` is the packaged Node HTTP + WebSocket Upgrade smoke
- **Background service commands:**
  `bun run ./src/main.ts enable` installs a native systemd/launchd/Task Scheduler service that runs foreground `start`; on Linux this requires systemd user lingering so the service can start after boot before login. `stop`, `restart`, `status`, and `logs` prefer the native service and fall back to the legacy app-managed daemon. `bun run ./src/main.ts start -d` remains a compatibility daemon path.
- **Other CLI subcommands:**
  `setup`, `models`, `doctor`, `auth`, `check-usage`, and `debug`
- **Codex setup policy:**
  Before authentication, inspect the installed Codex version and bundled catalog. Require Codex 0.134.0 or newer, and apply the same usable bundled-metadata gate to interactive choices and explicit `--model`. Keep live route-probe evidence separate from evidence that the generated profile was saved and executed with real Codex; setup does not provide the latter.
- **Live Copilot capability probes:**
  `bun run test:live:copilot` with `COPILOT_LIVE_TEST=1` and the required token/model environment variables; see [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md#live-copilot-capability-matrix).
- **Live Responses SSE/WSS semantic parity:**
  `COPILOT_LIVE_WS_PARITY=1 COPILOT_TOKEN=... COPILOT_LIVE_RESPONSES_MODEL=gpt-5.4 COPILOT_ACCOUNT_TYPE=individual bun test tests/live/copilot-responses-transport-parity.test.ts`; repeat with each account type in scope, and set `COPILOT_LIVE_VECTOR_STORE_ID` plus `COPILOT_LIVE_FILE_SEARCH_SENTINEL` for a positive `file_search` run
- **Live stateless Responses item replay:**
  `COPILOT_LIVE_ITEM_ID_REPLAY=1 COPILOT_LIVE_RESPONSES_MODEL=gpt-5.4 COPILOT_ACCOUNT_TYPE=individual bun run test:live:responses-item-replay` starts a disposable real HTTP proxy, captures the client-visible normalized `store:false` output including encrypted reasoning, replays the complete output on the next request, and requires exact semantic completion without retaining credentials or artifacts
- **Real Codex paired transport smoke:**
  `COPILOT_LIVE_CODEX_SMOKE=1 CODEX_SMOKE_MODEL=<current-ws-responses-model> CODEX_SMOKE_ACCOUNT_TYPE=individual bun run test:live:codex` invokes the real `codex` command twice against a disposable proxy and requires both an HTTP/SSE and a native WSS tool loop with at least two turns. Mock clients, direct service calls, and protocol fixtures do not count as this smoke.

## Code Style Guidelines

- **Imports:**
  Use ESNext syntax. Prefer absolute imports via `~/*` for `src/*` (see `tsconfig.json`).
- **Formatting:**
  Follows Prettier (with `prettier-plugin-packagejson`). Run `bun run lint --fix` to auto-fix.
- **Types:**
  Strict TypeScript (`strict: true`). Avoid `any`; use explicit types and interfaces.
- **Naming:**
  Use `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Error Handling:**
  Use existing explicit error classes (see `src/lib/error.ts`) for route, upstream, and HTTP boundary failures where they apply. Plain `Error` is fine for narrow internal assertions, but do not silently ignore failures.
- **Unused:**
  Unused imports/variables are errors (`noUnusedLocals`, `noUnusedParameters`).
- **Switches:**
  No fallthrough in switch statements.
- **Modules:**
  Use ESNext modules, no CommonJS.
- **Testing:**
  Use Bun's built-in test runner. Place tests in `tests/`, name as `*.test.ts`.
- **Linting:**
  Uses `@antfu/eslint-config` (see npm for details). Includes stylistic, unused imports, regex, and package.json rules.
- **Paths:**
  Use path aliases (`~/*`) for imports from `src/`.

## Proxy Capability Policy

- Treat GitHub Copilot upstream behavior as the source of truth for proxy pass-through decisions. Do not assume official OpenAI Responses or Anthropic API support implies Copilot support.
- Treat the proxy as a product boundary with two independent contracts: the client-facing wire contract comes from the current official OpenAI/Anthropic documentation, while the upstream-facing contract comes from fresh live Copilot probes for the selected model and endpoint. A correct implementation must satisfy both sides.
- Make successful, semantically faithful forwarding the first priority. For direct passthrough routes, accept and transparently forward official or safely forward-compatible fields whenever Copilot accepts them; do not add a local rejection merely because local hand-written types, an SDK version, or a downstream client has not caught up.
- For translated routes, preserve client intent rather than maximizing nominal 200 responses. Map a field only when the target protocol has an equivalent meaning and the selected Copilot backend has been validated. If no faithful representation exists and continuing would create a misleading success, return a clear client-compatible error. Advisory hints with no output-semantic effect may be omitted only with bounded debug logging and an explicit compatibility rationale.
- Do not equate HTTP 200 or parser acceptance with semantic support. Capability probes for stop conditions, structured output, tool choice, task/context controls, and similar behavior must validate the observable result whenever practical, not only the status code.
- When official documentation and Copilot behavior differ, preserve the official client-facing response shape while adapting the upstream request to the validated Copilot behavior. Never “fix” an upstream incompatibility by emitting a client-visible response that violates the client protocol.
- Apply this evidence model to reviews, implementation, and tests alike. Keep account type, model ID, endpoint, request shape, status, and semantic observation in the transient run output or issue that needs the result; do not accumulate dated snapshots in repository documentation. Classify findings as locally reproduced, official-contract verified, live-upstream verified, client-smoke verified, or conditional/platform-only; do not present one category as another.
- For upstream-gated features, validate with the live capability probes documented in [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md) before enabling new forwarding behavior.
- Native Responses WebSocket support is a transport-specific direct path. Accept client `GET` Upgrade requests on `/responses` and `/v1/responses`, then bridge each downstream connection one-to-one to Copilot `wss://.../responses`. Enable it only when the current live model entry explicitly advertises `ws:/responses` (or the equivalent normalized WebSocket endpoint); do not infer support from ordinary `/responses` metadata or static model defaults.
- Never present Responses WebSocket as a translation or fallback path. Claude/Anthropic translation, Chat Completions, and the Realtime API must not be advertised as Responses WebSocket support. Keep the existing HTTP `POST`/SSE Responses path available independently.
- Preserve Responses WebSocket protocol semantics: accept `response.create` text events, keep one response in flight per connection, process queued turns FIFO without multiplexing, and enforce the 60-minute connection boundary. `stream` is implicit and `background` is unsupported. Reject explicit `stream: false` and malformed `stream` values instead of silently converting a non-streaming request into a streaming success; `stream: true` or `null` may be stripped as transport-compatible no-ops. With `store: false`, connection-local `previous_response_id` state cannot be assumed after reconnect; a reconnect must start a new chain with the full required context unless persisted state is deliberately available.
- Keep Responses WebSocket input memory bounded both per connection and globally. The current boundary is 16 MiB per text frame, 8 queued turns / 32 MiB per connection, and 64 MiB across queued plus setup-stage request frames. Reserve before enqueue/setup, release on forwarding, rejection, cancellation, and shutdown, and reject global overflow locally without touching Copilot.
- Keep official OpenAI `response.create` warmup semantics separate from Copilot behavior. Until a fresh probe proves faithful no-output warmup semantics, reject `generate: false` locally with `400 unsupported_value` and `param: "generate"` before opening an upstream connection; never report ordinary generation or parser acceptance as a successful warmup.
- Keep direct Responses HTTP/SSE and WebSocket feature semantics in parity. The live gate must send one common payload per feature, force HTTP through a real `stream: true` SSE response, send the WebSocket form as `response.create`, and apply the same semantic validator to both results. A transport/category mismatch, semantic validation failure, or transport/API failure is a hard failure. Matching resource/dependency failures are only inconclusive; matching explicit capability rejections confirm parity but must never be reported as feature support.
- The parity validator must inspect observable semantics, not terminal status alone: structured outputs must parse and satisfy their JSON/schema contract; web search must emit a completed `web_search_call`, affirm that the H1 is `Example Domain`, and cite or source an `example.com` URL. If MCP becomes available, require completed `mcp_list_tools` plus `mcp_call` for deterministic `roll` input `1d1`, with both the tool output and assistant answer proving the exact numeric result `1`; an echoed `1d1` is not result evidence. A positive file-search claim requires a real `COPILOT_LIVE_VECTOR_STORE_ID`, a known sentinel, results, and a file citation. Only an explicit vector-store-missing error is a resource prerequisite failure; a bare endpoint or handshake `404` is a hard transport/API failure.
- Supported upstream capabilities should be transparently forwarded. Do not add local explicit rejections solely to handle client compatibility gaps or unknown-but-forwardable fields; prefer transparent forwarding, best-effort translation, and debug logging for fields that cannot be represented exactly. Local rejection is still appropriate for malformed requests, security boundaries, or cases where forwarding would create a misleading false success instead of real upstream behavior.
- Responses requests translated to Anthropic Messages are stateless and must explicitly set `store: false`; omission means the official Responses default (`store: true`) and must not be reported as a successful translated request. Preserve initial system/developer input as the top-level system prompt, preserve mid-conversation instructions only in positions accepted by the native Anthropic contract, and reject orderings that would require semantic reordering.
- Do not route Anthropic `output_config.format=json_schema` to Claude `/chat/completions` as `response_format=json_schema`; if native `/v1/messages` rejects it, the fallback can produce schema-invalid 200 responses with different semantics. For the selected model, run the native Anthropic live probe and keep the upstream result as the source of truth. See [feature-specific cautions](docs/copilot-capability-validation.md#feature-specific-cautions).
- When evaluating full Claude/Anthropic capabilities, use the current upstream model IDs and context limits as the source of truth before running probes.
- When changing Responses routing, tool handling, MCP behavior, web search, image inputs, structured output, or either Responses transport, run the real paired Codex gate with `bun run test:live:codex`. The script must execute the installed `codex` command for both HTTP/SSE (`supports_websockets=false`) and native WSS (`supports_websockets=true`); it must not implement or substitute a mock Codex client. Pure documentation-only or test-only changes may skip this smoke, but lack of token access is not a reason to skip it for behavior changes. The script keeps Codex state under a disposable cache directory and must never modify the user's `~/.codex`.
- The Codex WSS half must select a model whose live proxy catalog advertises `ws:/responses`. Success requires local and upstream `101` handshake evidence, at least two alternating forwarded/completed turns with matching counts over one active socket, a real local tool execution, and zero `POST /v1/responses` or Codex fallback diagnostics. Codex can return the correct answer after silently falling back to HTTP, so JSONL success and the final sentinel are necessary but insufficient. Follow the [real Codex CLI gate](docs/copilot-capability-validation.md#real-codex-cli).
- When changing Anthropic `/v1/messages` routing, native passthrough sanitization, thinking/output_config handling, or Claude Code tool behavior, run a real `claude` CLI smoke against the local proxy. Pure documentation-only or test-only changes may skip this smoke, but lack of token access is not a reason to skip it for behavior changes. Use temporary local state and follow [the real Claude Code gate](docs/copilot-capability-validation.md#real-claude-code).

## Request Abort and Upstream Cancellation Policy

- Do not pass Hono inbound request abort signals, especially `c.req.raw.signal`, into Copilot upstream fetch calls. This has repeatedly caused proxy clients such as NewAPI to surface 500s when the inbound request signal cancels upstream `/v1/responses` or `/v1/messages` work.
- Handle client disconnects at the response streaming boundary instead: check `stream.aborted` while writing SSE and stop writing to the client when needed. Do not use the inbound request signal as upstream cancellation unless there is fresh production evidence and the regression tests are updated deliberately.
- Before changing request-signal behavior, inspect `git log -S "signal: c.req.raw.signal"` and `tests/request-signal-regression.test.ts` to understand the v0.6.1/v0.7.6/v0.7.7 regression history. Treat reversing that test's semantic direction as high risk.
- When editing routes or services that call `createResponses`, `createAnthropicMessages`, `createChatCompletions`, `createEmbeddings`, or `forwardResponsesEndpoint`, run `bun test tests/request-signal-regression.test.ts`. The test's intent is to fail if any normal route forwards an inbound request signal upstream.
- Keep daemon/native-service tests on the isolated test data directory installed by `tests/preload.ts`; never point test configuration, PID, log, environment, or service-control helpers at the developer's real application directory.

## Authentication Recovery and Concurrency Policy

- Normal Copilot-token requests must go through the authenticated upstream wrapper so request-time recovery, correlation metrics, circuit state, and optional concurrency limits remain consistent across Responses HTTP and WebSocket turns, Messages, Chat Completions, embeddings, count-tokens, model refresh, and Responses passthrough routes. The developer-CLI model fallback uses the GitHub token and must not enter Copilot-token recovery.
- A Copilot upstream `401` may trigger one short-lived token refresh and one replay. A `403` is eligible only when it is an explicit token-expired/invalid response or the dated, live-observed GitHub shape: plain-text `Forbidden` with a GitHub or Copilot service request ID and no `Retry-After`.
- Never refresh/replay structured model, organization, content, or permission `403` responses; local Host/Origin/manual-approval/token-route `403` responses; `429`; 5xx; timeouts; connection resets; or any failure after a 2xx response or downstream stream has begun.
- Concurrent failures for the same endpoint/model must join one recovery. Rebuild Authorization and `x-request-id` for the replay. If the fresh-token canary is still rejected, open the scoped cooldown circuit; multiple failing scopes may open the global circuit. Do not add restart, token-refresh, account-switch, or endpoint-switch loops that attempt to bypass persistent GitHub risk enforcement.
- Named runtime presets are bounded; `custom` without `--max-concurrency` disables the limiter. Plain `start`, existing native services, and explicit concurrency configurations must retain their pre-preset semantics unless the user explicitly selects a preset. Setup may recommend an explicit bounded preset for new configurations. When enabled, hold the lease until the final upstream response body/SSE stream completes or is cancelled; do not release at response-header time. Queue overflow/timeout must fail locally without touching GitHub.
- `/livez` is process liveness only. `/readyz` is passive and must never expose credentials, prompt content, token hashes, or user keys. Keep correlation logging limited to endpoint/model/status, recovery generation, and safe GitHub/Copilot request IDs.
- After recovery, concurrency, health, or service-option changes, run `bun test tests/copilot-auth-recovery.test.ts tests/auth-recovery-routes.test.ts tests/concurrency-limiter.test.ts tests/health-routes.test.ts tests/request-signal-regression.test.ts` plus the paired HTTP/SSE+WSS Codex gate and a real Claude CLI smoke through disposable local listeners.

---

This file is tailored for agentic coding agents. For more details, see the configs in `eslint.config.js` and `tsconfig.json`.
