# AGENTS.md

## Top-Level Engineering Principle

- Avoid over-engineering. Choose the simplest complete solution that satisfies the current confirmed requirement and preserves the existing product contract.
- Complexity must be earned by a concrete current need, observed evidence, or a real second use case. Hypothetical future flexibility, practically unreachable edge cases, and architectural elegance alone are not sufficient justification.
- This principle governs architecture, implementation, debugging, testing, review, documentation, and operations. Unless correctness, security, an external protocol contract, or an explicit user requirement demands otherwise, prefer narrower scope, fewer moving parts, and reversible changes over broader or more generic designs.

## Build, Lint, and Test Commands

- **Core:** `bun run build`, `bun run dev`, `bun run start`, `bun run lint`, `bun run lint --fix`, `bun run typecheck`, `bun run knip`, and `bun run audit`.
- **Tests:** `bun test`, `bun run test:coverage`, or `bun test <test-file>`.
- **Common targeted tests:** `tests/create-responses.test.ts`, `tests/messages-routing.test.ts`, `tests/model-config.test.ts`, `tests/copilot-auth-recovery.test.ts`, `tests/auth-recovery-routes.test.ts`, `tests/concurrency-limiter.test.ts`, and `tests/request-signal-regression.test.ts`.
- **Protocol and live gates:** use `bun run test:node:http`, `bun run test:live:copilot`, `bun run test:live:responses-item-replay`, and `bun run test:live:codex` as applicable. Exact environment variables, route matrices, and acceptance criteria live in [the capability validation guide](docs/copilot-capability-validation.md#command-map).
- **Native service:** `bun run ./src/main.ts enable`; use `stop`, `restart`, `status`, and `logs` for lifecycle control. Linux boot-before-login requires systemd user lingering. The removed `start -d` path must continue to direct users to `enable`.
- **Other CLI subcommands:** `setup`, `models`, `doctor`, `auth`, `check-usage`, and `debug`.
- **Codex setup policy:**
  Before authentication, inspect the installed Codex version and bundled catalog. Require Codex 0.134.0 or newer, and apply the same usable bundled-metadata gate to interactive choices and explicit `--model`. Keep live route-probe evidence separate from evidence that the generated profile was saved and executed with real Codex; setup does not provide the latter.

## Code Style Guidelines

- **Imports:**
  Use ESNext syntax. Prefer absolute imports via `~/*` for `src/*` (see `tsconfig.json`).
- **Formatting and linting:**
  Follow Prettier with `prettier-plugin-packagejson` and `@antfu/eslint-config`; use `bun run lint --fix` or `bunx lint-staged`.
- **Types:**
  Strict TypeScript (`strict: true`). Avoid `any`; use explicit types and interfaces.
- **Naming:**
  Use `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Error Handling:**
  Use existing explicit error classes (see `src/lib/error.ts`) for route, upstream, and HTTP boundary failures where they apply. Plain `Error` is fine for narrow internal assertions, but do not silently ignore failures.
- **Static rules:**
  Unused imports/variables are errors, switches do not fall through, and modules use ESNext rather than CommonJS.
- **Testing:**
  Use Bun's built-in test runner. Place tests in `tests/`, name as `*.test.ts`.
- **Paths:**
  Use path aliases (`~/*`) for imports from `src/`.

## Proxy Capability Policy

- Treat the proxy as a product boundary with two independent contracts: current official OpenAI/Anthropic client semantics and fresh live Copilot behavior for the exact model, account, endpoint, and request shape. Neither contract proves the other.
- Make successful, semantically faithful forwarding the first priority. For direct passthrough routes, accept and transparently forward official or safely forward-compatible fields whenever Copilot accepts them; do not add a local rejection merely because local hand-written types, an SDK version, or a downstream client has not caught up.
- For translated routes, preserve client intent rather than maximizing nominal 200 responses. Map a field only when the target protocol has an equivalent meaning and the selected Copilot backend has been validated. If no faithful representation exists and continuing would create a misleading success, return a clear client-compatible error. Advisory hints with no output-semantic effect may be omitted only with bounded debug logging and an explicit compatibility rationale.
- Do not equate HTTP 200 or parser acceptance with semantic support. Preserve official client-visible response shapes when adapting to Copilot, classify evidence as local, official-contract, live-upstream, client-smoke, or conditional, and do not present one category as another.
- Validate upstream-gated behavior using [the capability validation guide](docs/copilot-capability-validation.md); keep transient model/account/request evidence out of repository documentation.
- Responses WebSocket is a direct one-to-one bridge available only when the exact live model advertises `ws:/responses`; it is never a translation or fallback path. Keep HTTP/SSE Responses independently available.
- Preserve Responses WebSocket protocol semantics: accept `response.create` text events, keep one response in flight per connection, process queued turns FIFO without multiplexing, and enforce the 60-minute connection boundary. `stream` is implicit and `background` is unsupported. Reject explicit `stream: false` and malformed `stream` values instead of silently converting a non-streaming request into a streaming success; `stream: true` or `null` may be stripped as transport-compatible no-ops. With `store: false`, connection-local `previous_response_id` state cannot be assumed after reconnect; a reconnect must start a new chain with the full required context unless persisted state is deliberately available.
- Keep Responses WebSocket input memory bounded both per connection and globally. The current boundary is 16 MiB per text frame, 8 queued turns / 32 MiB per connection, and 64 MiB across queued plus setup-stage request frames. Reserve before enqueue/setup, release on forwarding, rejection, cancellation, and shutdown, and reject global overflow locally without touching Copilot.
- Keep official OpenAI `response.create` warmup semantics separate from Copilot behavior. Until a fresh probe proves faithful no-output warmup semantics, reject `generate: false` locally with `400 unsupported_value` and `param: "generate"` before opening an upstream connection; never report ordinary generation or parser acceptance as a successful warmup.
- Keep direct Responses HTTP/SSE and WebSocket feature semantics in parity using one common payload and semantic validator. Transport/API failures and semantic/category mismatches are hard failures; matching explicit capability rejections confirm parity but not support. Detailed feature assertions live in [the parity guide](docs/copilot-capability-validation.md#responses-http-and-websocket-parity).
- Supported upstream capabilities should be transparently forwarded. Do not add local explicit rejections solely to handle client compatibility gaps or unknown-but-forwardable fields; prefer transparent forwarding, best-effort translation, and debug logging for fields that cannot be represented exactly. Local rejection is still appropriate for malformed requests, security boundaries, or cases where forwarding would create a misleading false success instead of real upstream behavior.
- Responses requests translated to Anthropic Messages are stateless and must explicitly set `store: false`; omission means the official Responses default (`store: true`) and must not be reported as a successful translated request. Preserve initial system/developer input as the top-level system prompt, preserve mid-conversation instructions only in positions accepted by the native Anthropic contract, and reject orderings that would require semantic reordering.
- Do not route Anthropic `output_config.format=json_schema` to Claude `/chat/completions` as `response_format=json_schema`; if native `/v1/messages` rejects it, the fallback can produce schema-invalid 200 responses with different semantics. For the selected model, run the native Anthropic live probe and keep the upstream result as the source of truth. See [feature-specific cautions](docs/copilot-capability-validation.md#feature-specific-cautions).
- Keep per-model Claude probes limited to request-scoped inference behavior using current upstream model IDs and limits. Anthropic Models, Files, Message Batches, Skills, Managed Agents, and state-creating negative probes are outside this matrix.
- Treat `code_execution` and `web_search` as hosted server tools: a positive probe must validate the completed server call, result, and deterministic output/source evidence. Treat `bash`, text editor, and memory as client-executed tools: validate the correctly named `tool_use` with executable input matching the requested operation, and leave execution to the real client or SDK.
- Behavior changes to Responses routing/tools/transports require the real paired Codex gate; native Messages/Claude Code behavior changes require a real Claude CLI smoke. Mock clients and direct service calls do not substitute for these gates. Test-only or documentation-only changes may skip them. Follow the [Codex](docs/copilot-capability-validation.md#real-codex-cli) and [Claude Code](docs/copilot-capability-validation.md#real-claude-code) guides.

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
