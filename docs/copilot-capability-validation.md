# GitHub Copilot Capability Validation for Claude Compatibility Work

This repository already translates Anthropic-compatible requests onto GitHub Copilot upstream APIs. That means some fixes are purely local schema/translation work, while others are only safe if the Copilot upstream endpoint actually accepts the mapped field.

This document is the guardrail for that second category.

## Why this exists

Several Claude-side compatibility gaps are easy to identify from the Anthropic protocol alone:

- `thinking.type = "adaptive"`
- `output_config.effort`
- `tool_choice`
- `disable_parallel_tool_use`
- URL-based image inputs

The risky part is that "valid Anthropic input" does not automatically mean "valid GitHub Copilot upstream input". If we wire fields through blindly, we can turn a harmless proxy omission into a hard upstream request failure.

## Validation model

Use two layers:

1. Local-only fixes

These are safe to implement without a live Copilot probe, as long as unit tests cover the translation behavior.

- Accept Anthropic request shapes such as `thinking.type = "adaptive"` or `thinking.type = "disabled"`.
- Accept `tool_result.content` as either string or structured block arrays.
- Accept Anthropic `image.source.type = "url"` in request parsing.
- Improve Claude model normalization or historical-thinking handling.

2. Upstream-gated fixes

These should only be enabled after a live probe proves Copilot accepts the translated request, or after we deliberately choose a graceful fallback for unsupported cases.

- Forwarding Claude `tool_choice` to Copilot `/chat/completions`
- Mapping Anthropic `output_config.effort` or thinking hints onto Copilot `reasoning.effort`
- Mapping `disable_parallel_tool_use = true` onto `parallel_tool_calls = false`
- Passing URL image inputs through to Copilot `/responses`
- Passing Responses-native controls such as `text.verbosity`, `include`, `prompt_cache_key`, `truncation`, `context_management`, `store`, `previous_response_id`, `background`, `max_tool_calls`, and `service_tier`
- Passing hosted Responses tools such as `web_search`, `tool_search`, and `code_interpreter`
- Exposing official Responses subroutes such as `/responses/{id}`, `/responses/{id}/cancel`, `/responses/{id}/input_items`, `/responses/input_tokens`, and `/responses/compact`

## Probe matrix

The executable probe definitions live in [tests/live/copilot-capability-matrix.ts](../tests/live/copilot-capability-matrix.ts).

| Probe group | Probe IDs | Copilot endpoint | Default model | Expected interpretation |
| --- | --- | --- | --- | --- |
| Baselines | `baseline-claude-chat-completions`, `baseline-claude-responses-unsupported`, `baseline-responses-api`, `baseline-responses-model-chat-completions-unsupported`, `responses-streaming` | `/chat/completions`, `/responses` | `claude-opus-4.6`, `gpt-5.5` | Baseline positive probes must succeed; negative baseline probes must return clean `unsupported` |
| Claude compatibility gates | `claude-tool-choice-required`, `claude-parallel-tool-calls-false`, `claude-reasoning-effort-high`, `claude-reasoning-effort-max`, `claude-response-format-json-object`, `claude-response-format-json-schema` | `/chat/completions` | `claude-opus-4.6` | `supported` or clean `unsupported` |
| Responses reasoning and output controls | `responses-reasoning-effort-none`, `responses-reasoning-effort-low`, `responses-reasoning-effort-medium`, `responses-reasoning-effort-high`, `responses-reasoning-effort-xhigh`, `responses-reasoning-effort-minimal-unsupported`, `responses-reasoning-summary-auto`, `responses-include-encrypted-reasoning`, `responses-text-verbosity-low`, `responses-text-verbosity-medium`, `responses-text-verbosity-high` | `/responses` | `gpt-5.5` | Supported values may pass; known invalid values must return clean `unsupported` |
| Responses cache and context controls | `responses-prompt-cache-key`, `responses-truncation-auto`, `responses-context-management`, `responses-store-false`, `responses-store-true-unsupported`, `responses-previous-response-id-unsupported`, `responses-background-unsupported`, `responses-background-stream-unsupported`, `responses-service-tier-auto-unsupported` | `/responses` | `gpt-5.5` | Supported stateless controls may pass; stateful/background controls currently must return clean `unsupported` |
| Responses tools and structured output | `responses-max-tool-calls-1`, `responses-parallel-tool-calls-false`, `responses-web-search-tool`, `responses-tool-search-tool`, `responses-code-interpreter-tool-unsupported`, `responses-text-format-json-object`, `responses-text-format-json-schema` | `/responses` | `gpt-5.5` | Function/tool controls and accepted hosted tools may pass; unsupported hosted tools must return clean `unsupported` |
| Responses multimodal and files | `responses-input-image-url`, `responses-input-file-url` | `/responses` | `gpt-5.5` | `supported` or clean `unsupported` |
| Official Responses subroutes | `responses-get-by-id-unsupported`, `responses-delete-by-id-unsupported`, `responses-cancel-unsupported`, `responses-input-items-unsupported`, `responses-input-tokens-unsupported`, `responses-compact-unsupported` | `/responses/{id}`, `/responses/{id}/cancel`, `/responses/{id}/input_items`, `/responses/input_tokens`, `/responses/compact` | `gpt-5.5` | Current Copilot behavior must be clean `unsupported` |
| Native Anthropic passthrough | `native-anthropic-baseline`, `native-anthropic-reasoning-effort-high`, `native-anthropic-reasoning-effort-max`, `native-anthropic-json-schema`, `native-anthropic-thinking-display-omitted`, `native-anthropic-document-text`, `native-anthropic-document-url-pdf`, `native-anthropic-document-citations`, `native-anthropic-cache-control`, `native-anthropic-image-base64`, `native-anthropic-image-url-rejected`, `native-anthropic-files-api-unsupported` | `/v1/messages`, `/v1/files` | `claude-opus-4.6` | Known supported native Anthropic features must succeed; known upstream gaps such as native `json_schema` and URL documents must return clean `unsupported` |

## How to run the live probes

The live suite is intentionally opt-in. It is skipped during normal `bun test` runs unless `COPILOT_LIVE_TEST=1` is set.

Required environment variables:

- `COPILOT_LIVE_TEST=1`
- `COPILOT_TOKEN=<your GitHub Copilot bearer token>`

Optional environment variables:

- `COPILOT_ACCOUNT_TYPE=individual|business|enterprise`
- `COPILOT_VSCODE_VERSION=1.104.3`
- `COPILOT_LIVE_CLAUDE_MODEL=claude-opus-4.6`
- `COPILOT_LIVE_RESPONSES_MODEL=gpt-5.5`
- `COPILOT_LIVE_IMAGE_URL=https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png`
- `COPILOT_LIVE_FILE_URL=https://www.berkshirehathaway.com/letters/2024ltr.pdf`
- `COPILOT_LIVE_TIMEOUT_MS=180000`
- `COPILOT_LIVE_RETRY_COUNT=2`

Example:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=claude-opus-4.6 \
COPILOT_LIVE_RESPONSES_MODEL=gpt-5.5 \
bun run test:live:copilot
```

## Result semantics

Each probe is classified as one of:

- `supported`
- `unsupported`
- `auth_error`
- `rate_limited`
- `api_error`
- `network_error`
- `unexpected_response`

Interpretation rules:

- Baseline probes must return `supported`.
- Baseline negative-compatibility probes must return a clean `unsupported`.
- Optional probes pass if they return either `supported` or a clean `unsupported`.
- `auth_error`, `rate_limited`, `api_error`, `network_error`, and `unexpected_response` should be treated as environment or upstream-health failures, not product decisions.

## How to use the results

Use the probe outcome to decide how aggressive the proxy should be:

- If a probe is `supported`, we can confidently wire the corresponding translation path and add normal unit coverage.
- If a probe is `unsupported`, keep the local parsing improvement but omit or downgrade the upstream field.
- If a probe fails for environmental reasons, rerun the suite before making routing or translation decisions.

## Claude Code CLI smoke tests

Use a real `claude` CLI smoke when changing Anthropic `/v1/messages` routing, native passthrough sanitization, thinking/output_config handling, tool translation, or Claude Code-specific beta behavior.

Start the proxy on a disposable port first:

```sh
bun run ./src/main.ts start -p 4899
```

Then run Claude Code with temporary local state:

```sh
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL=claude-opus-4-6 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model claude-opus-4-6 \
  --output-format json \
  --no-session-persistence \
  "Reply with exactly: proxy-ok"
```

Expected behavior:

- Claude Code respects `ANTHROPIC_BASE_URL` and calls `POST /v1/messages?beta=true`.
- `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer ...`; `ANTHROPIC_API_KEY` is sent as `x-api-key`.
- The request normally uses SSE streaming and includes Claude Code beta headers, adaptive thinking, `context_management`, `output_config.effort`, cache-control hints, metadata, and built-in tool schemas.
- The proxy should return a normal Claude Code `result` with `is_error=false`.

Additional high-value smokes:

```sh
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL=claude-opus-4-6 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model claude-opus-4-6 \
  --output-format json \
  --no-session-persistence \
  --permission-mode bypassPermissions \
  --allowedTools=Read \
  --disallowedTools=Bash,Edit \
  "Read package.json and answer with only the package name."
```

This verifies a real tool_use/tool_result loop through `/v1/messages`.

```sh
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL=claude-opus-4-6 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model claude-opus-4-6 \
  --output-format json \
  --no-session-persistence \
  --json-schema '{"type":"object","properties":{"status":{"type":"string"}},"required":["status"],"additionalProperties":false}' \
  "Return status proxy-ok."
```

Claude Code implements `--json-schema` by adding a `StructuredOutput` tool. It does not send Anthropic `output_config.format=json_schema`, so this smoke should succeed when normal tool calls work.

```sh
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL=claude-opus-4-6 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model claude-opus-4-6 \
  --effort max \
  --output-format json \
  --no-session-persistence \
  "Reply with exactly: effort-ok"
```

This is a negative smoke. Current Copilot native `/v1/messages` rejects `output_config.effort="max"` for `claude-opus-4.6`, so Claude Code should return an API error with `invalid_reasoning_effort`.

```sh
curl -sS http://127.0.0.1:4899/v1/messages/count_tokens \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-opus-4-6","max_tokens":32,"messages":[{"role":"user","content":"Count this short prompt."}]}'
```

This checks the Claude-compatible token counting route.

## Important nuance for Anthropic `output_config.format=json_schema`

Parameter acceptance is not the same as equivalent structured-output support.

Current Copilot behavior is:

- Native `/v1/messages` rejects Anthropic `output_config.format` with `output_config.format: Extra inputs are not permitted`.
- Claude `/chat/completions` accepts `response_format=json_schema`, but that does not prove it enforces an Anthropic-equivalent JSON schema contract.

For that reason, Anthropic `output_config.format.type="json_schema"` must stay on native `/v1/messages` and surface the upstream rejection until Copilot implements native support. The proxy should not silently route this request to Claude `/chat/completions`, because that can turn an unsupported request into a schema-invalid 200 response.

## Important nuance for Anthropic `output_config.effort=max`

Anthropic `max` is Claude-side reasoning semantics, not a value we should blindly forward to Copilot `/responses` or assume Copilot native Claude accepts.

Current Copilot behavior is:

- Native `/v1/messages` accepts `output_config.effort` values `low`, `medium`, and `high`.
- Native `/v1/messages` rejects `output_config.effort="max"` for `claude-opus-4.6` with `invalid_reasoning_effort`.
- Claude `/chat/completions` also rejects `reasoning_effort="max"` for `claude-opus-4.6` with `invalid_reasoning_effort`.
- Claude Code `--effort max` therefore should surface a clean unsupported error until Copilot native support changes.

The live validation layer therefore treats `/responses` differently:

- First, verify that Claude itself is still rejected on `/responses`.
- Then, if Anthropic-compatible requests are routed onto a Responses-backed model, probe the native Copilot/OpenAI-side high-end value `reasoning.effort = "xhigh"`.

That keeps Claude-specific `max` logic on the `/chat/completions` path where it belongs, while still giving us a validated adaptation target for non-Claude Responses-backed models.
