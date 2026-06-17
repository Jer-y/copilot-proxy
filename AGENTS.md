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
- **Test single file:**
  `bun test tests/messages-routing.test.ts`
- **Common targeted tests:**
  `bun test tests/create-responses.test.ts` for Responses routing/translation, `bun test tests/messages-routing.test.ts` for Anthropic messages, `bun test tests/model-config.test.ts` for model metadata, and `bun test tests/request-signal-regression.test.ts` for inbound request-signal regressions
- **Background service commands:**
  `bun run ./src/main.ts enable` installs a native systemd/launchd/Task Scheduler service that runs foreground `start`; on Linux this requires systemd user lingering so the service can start after boot before login. `stop`, `restart`, `status`, and `logs` prefer the native service and fall back to the legacy app-managed daemon. `bun run ./src/main.ts start -d` remains a compatibility daemon path.
- **Other CLI subcommands:**
  `auth`, `check-usage`, and `debug`
- **Live Copilot capability probes:**
  `bun run test:live:copilot` with `COPILOT_LIVE_TEST=1` and the required token/model environment variables; see [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md#how-to-run-the-live-probes).

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
- For upstream-gated features, validate with the live capability probes documented in [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md) before enabling new forwarding behavior.
- Supported upstream capabilities should be transparently forwarded. Do not add local explicit rejections solely to handle client compatibility gaps or unknown-but-forwardable fields; prefer transparent forwarding, best-effort translation, and debug logging for fields that cannot be represented exactly. Local rejection is still appropriate for malformed requests, security boundaries, or cases where forwarding would create a misleading false success instead of real upstream behavior.
- Do not route Anthropic `output_config.format=json_schema` to Claude `/chat/completions` as `response_format=json_schema`; if native `/v1/messages` rejects it, the fallback can produce schema-invalid 200 responses with different semantics. For the selected model, run the native Anthropic live probe and keep the upstream result as the source of truth. See [the Anthropic json_schema note](docs/copilot-capability-validation.md#important-nuance-for-anthropic-output_configformatjson_schema).
- When evaluating full Claude/Anthropic capabilities, use the current exact 1M Claude variants for the selected model family rather than shorter-context variants; confirm the precise model IDs before running the probe.
- When changing Responses routing, tool handling, MCP behavior, web search, image inputs, or structured output, run a real `codex` CLI smoke against the local `/v1/responses` proxy. Pure documentation-only or test-only changes may skip this smoke, but lack of token access is not a reason to skip it for behavior changes. Keep Codex config temporary, for example with `CODEX_HOME=/tmp/...`, and do not modify the user's `~/.codex`.
- When changing Anthropic `/v1/messages` routing, native passthrough sanitization, thinking/output_config handling, or Claude Code tool behavior, run a real `claude` CLI smoke against the local proxy. Pure documentation-only or test-only changes may skip this smoke, but lack of token access is not a reason to skip it for behavior changes. Use temporary local state and follow [the Claude Code smoke guidance](docs/copilot-capability-validation.md#claude-code-cli-smoke-tests).

## Request Abort and Upstream Cancellation Policy

- Do not pass Hono inbound request abort signals, especially `c.req.raw.signal`, into Copilot upstream fetch calls. This has repeatedly caused proxy clients such as NewAPI to surface 500s when the inbound request signal cancels upstream `/v1/responses` or `/v1/messages` work.
- Handle client disconnects at the response streaming boundary instead: check `stream.aborted` while writing SSE and stop writing to the client when needed. Do not use the inbound request signal as upstream cancellation unless there is fresh production evidence and the regression tests are updated deliberately.
- Before changing request-signal behavior, inspect `git log -S "signal: c.req.raw.signal"` and `tests/request-signal-regression.test.ts` to understand the v0.6.1/v0.7.6/v0.7.7 regression history. Treat reversing that test's semantic direction as high risk.
- When editing routes or services that call `createResponses`, `createAnthropicMessages`, `createChatCompletions`, `createEmbeddings`, or `forwardResponsesEndpoint`, run `bun test tests/request-signal-regression.test.ts`. The test's intent is to fail if any normal route forwards an inbound request signal upstream.

---

This file is tailored for agentic coding agents. For more details, see the configs in `eslint.config.js` and `tsconfig.json`.
