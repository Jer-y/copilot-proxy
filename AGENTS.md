# AGENTS.md

## Build, Lint, and Test Commands

- **Build:**
  `bun run build` (uses tsup)
- **Dev:**
  `bun run dev` (runs `start` subcommand with file watching)
- **Lint:**
  `bun run lint` (uses @antfu/eslint-config)
- **Lint & Fix staged files:**
  `bunx lint-staged`
- **Test all:**
   `bun test`
- **Test single file:**
   `bun test tests/claude-request.test.ts`
- **Start (prod):**
  `bun run start` (runs `start` subcommand in production mode)
- **Daemon commands:**
  `bun run ./src/main.ts start -d` (background), `stop`, `restart`, `status`, `logs`, `enable`, `disable`
- **Live Copilot capability probes:**
  See [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md#how-to-run-the-live-probes).

## Code Style Guidelines

- **Imports:**
  Use ESNext syntax. Prefer absolute imports via `~/*` for `src/*` (see `tsconfig.json`).
- **Formatting:**
  Follows Prettier (with `prettier-plugin-packagejson`). Run `bun run lint` to auto-fix.
- **Types:**
  Strict TypeScript (`strict: true`). Avoid `any`; use explicit types and interfaces.
- **Naming:**
  Use `camelCase` for variables/functions, `PascalCase` for types/classes.
- **Error Handling:**
  Use explicit error classes (see `src/lib/error.ts`). Avoid silent failures.
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
- Supported upstream capabilities should be transparently forwarded. Known unsupported capabilities should fail locally or surface a clean upstream-aligned unsupported error instead of being silently dropped or rerouted into a false success.
- Do not route Anthropic `output_config.format=json_schema` to Claude `/chat/completions` as `response_format=json_schema`; native `/v1/messages` currently rejects it and the fallback can produce schema-invalid 200 responses. See [the Anthropic json_schema note](docs/copilot-capability-validation.md#important-nuance-for-anthropic-output_configformatjson_schema).
- When changing Responses routing, tool handling, MCP behavior, web search, image inputs, or structured output, run a real `codex` CLI smoke against the local `/v1/responses` proxy. Keep Codex config temporary, for example with `CODEX_HOME=/tmp/...`, and do not modify the user's `~/.codex`.
- When changing Anthropic `/v1/messages` routing, native passthrough sanitization, thinking/output_config handling, or Claude Code tool behavior, run a real `claude` CLI smoke against the local proxy. Use temporary local state and follow [the Claude Code smoke guidance](docs/copilot-capability-validation.md#claude-code-cli-smoke-tests).

---

This file is tailored for agentic coding agents. For more details, see the configs in `eslint.config.js` and `tsconfig.json`. No Cursor or Copilot rules detected.
