# GitHub Copilot Capability Validation for Claude Compatibility Work

This repository already translates Anthropic-compatible requests onto GitHub Copilot upstream APIs. That means some fixes are purely local schema/translation work, while others are only safe if the Copilot upstream endpoint actually accepts the mapped field.

This document is the guardrail for that second category.

This document intentionally does not record a durable support matrix for GitHub Copilot upstream behavior. Treat the executable live probes, run against the selected model and account at the time of the change, as the source of truth.

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
- Passing Responses-native controls such as `text.verbosity`, `include`, `top_logprobs`, `prompt_cache_key`, `prompt_cache_retention`, `metadata`, `safety_identifier`, `user`, `truncation`, `context_management`, `conversation`, `prompt`, `store`, `previous_response_id`, `background`, `max_tool_calls`, `stream_options`, and `service_tier`
- Passing hosted and Responses-native tools such as `web_search`, `web_search_preview`, `file_search`, `image_generation`, `mcp`, `computer_use_preview`, `tool_search`, `local_shell`, `shell`, `custom`, `namespace`, `apply_patch`, and `code_interpreter`
- Exposing official Responses subroutes such as `/responses/{id}`, `/responses/{id}/cancel`, `/responses/{id}/input_items`, `/responses/input_tokens`, and `/responses/compact`

## Probe matrix

The executable probe definitions live in [tests/live/copilot-capability-matrix.ts](../tests/live/copilot-capability-matrix.ts).

The Responses rows are aligned to the OpenAI OpenAPI `CreateResponse` schema and official Responses subroutes as of API spec `2.3.0`. The matrix intentionally emphasizes upstream-gated pass-through decisions: state/context controls, include values, streaming options, tool definitions, tool-choice forms, multimodal input shapes, structured output, and official `/responses/*` routes. Plain sampling controls such as `temperature`, `top_p`, and `max_output_tokens` are covered by normal request smoke coverage unless a Copilot-specific incompatibility appears.

Hosted tool presence probes set `tool_choice=none`, so they measure whether Copilot accepts the tool schema on the request, not whether the backend can or will execute that hosted tool.

| Probe group | Probe IDs | Copilot endpoint | Model source | How to read the result |
| --- | --- | --- | --- | --- |
| Baselines | `baseline-claude-chat-completions`, `baseline-claude-responses-unsupported`, `baseline-responses-api`, `baseline-responses-model-chat-completions-unsupported`, `responses-streaming` | `/chat/completions`, `/responses` | env configured | Establishes whether the selected model and endpoint are reachable before interpreting feature probes |
| Claude compatibility gates | `claude-tool-choice-required`, `claude-parallel-tool-calls-false`, `claude-reasoning-effort-high`, `claude-reasoning-effort-max`, `claude-response-format-json-object`, `claude-response-format-json-schema` | `/chat/completions` | env configured | Read the live summary for the selected model; do not infer support from this document |
| Responses streaming controls | `responses-stream-options-include-obfuscation-false` | `/responses` | env configured | Read the live summary for the selected model |
| Responses reasoning and output controls | `responses-reasoning-effort-none`, `responses-reasoning-effort-low`, `responses-reasoning-effort-medium`, `responses-reasoning-effort-high`, `responses-reasoning-effort-xhigh`, `responses-reasoning-effort-minimal-unsupported`, `responses-reasoning-summary-auto`, `responses-reasoning-summary-concise`, `responses-reasoning-summary-detailed`, `responses-reasoning-generate-summary-auto-deprecated`, `responses-include-encrypted-reasoning`, `responses-include-output-logprobs`, `responses-include-input-image-url`, `responses-text-verbosity-low`, `responses-text-verbosity-medium`, `responses-text-verbosity-high` | `/responses` | env configured | Read the live summary for the selected model and date |
| Responses cache and context controls | `responses-prompt-cache-key`, `responses-prompt-cache-retention-24h`, `responses-metadata`, `responses-safety-identifier`, `responses-user-deprecated`, `responses-truncation-auto`, `responses-context-management`, `responses-conversation`, `responses-prompt-template`, `responses-store-false`, `responses-store-true-unsupported`, `responses-previous-response-id-unsupported`, `responses-background-unsupported`, `responses-background-stream-unsupported`, `responses-service-tier-auto-unsupported` | `/responses` | env configured | Read the live summary for the selected model and date |
| Responses tools and structured output | `responses-max-tool-calls-1`, `responses-function-call-output-input`, `responses-parallel-tool-calls-false`, `responses-tool-choice-function-object`, `responses-tool-choice-allowed-tools`, `responses-web-search-tool`, `responses-web-search-preview-tool`, `responses-file-search-tool`, `responses-image-generation-tool`, `responses-mcp-tool`, `responses-computer-use-preview-tool`, `responses-tool-search-tool`, `responses-local-shell-tool`, `responses-shell-tool`, `responses-custom-tool`, `responses-namespace-tool`, `responses-apply-patch-tool`, `responses-code-interpreter-tool-unsupported`, `responses-text-format-json-object`, `responses-text-format-json-schema` | `/responses` | env configured | Read the live summary for the selected model and date |
| Responses multimodal and files | `responses-input-image-url`, `responses-input-image-data-url`, `responses-input-file-url` | `/responses` | env configured | Read the live summary for the selected model and date |
| Official Responses subroutes | `responses-get-by-id-unsupported`, `responses-delete-by-id-unsupported`, `responses-cancel-unsupported`, `responses-input-items-unsupported`, `responses-input-tokens-unsupported`, `responses-compact-unsupported` | `/responses/{id}`, `/responses/{id}/cancel`, `/responses/{id}/input_items`, `/responses/input_tokens`, `/responses/compact` | env configured | Read the live summary for the selected model and date |
| Native Anthropic passthrough | `native-anthropic-baseline`, `native-anthropic-hyphen-alias-baseline`, `native-anthropic-streaming`, `native-anthropic-count-tokens`, `native-anthropic-count-tokens-tools`, `native-anthropic-reasoning-effort-low`, `native-anthropic-reasoning-effort-medium`, `native-anthropic-reasoning-effort-high`, `native-anthropic-reasoning-effort-xhigh`, `native-anthropic-reasoning-effort-max`, `native-anthropic-json-schema`, `native-anthropic-thinking-display-omitted`, `native-anthropic-manual-thinking-budget`, `native-anthropic-thinking-disabled`, `native-anthropic-tool-choice-specific`, `native-anthropic-tool-choice-any-disable-parallel`, `native-anthropic-strict-custom-tool`, `native-anthropic-server-tool-code-execution`, `native-anthropic-server-tool-memory`, `native-anthropic-server-tool-bash`, `native-anthropic-server-tool-text-editor`, `native-anthropic-server-tool-web-search`, `native-anthropic-mid-conversation-system-beta`, `native-anthropic-speed-fast`, `native-anthropic-document-text`, `native-anthropic-document-url-pdf`, `native-anthropic-document-file-unsupported`, `native-anthropic-document-citations`, `native-anthropic-cache-control`, `native-anthropic-image-base64`, `native-anthropic-image-url-rejected`, `native-anthropic-models-api-unsupported`, `native-anthropic-batches-list-unsupported`, `native-anthropic-batches-create-unsupported`, `native-anthropic-files-api-unsupported` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, `/v1/messages/batches`, `/v1/files` | env configured | Read the live summary for the selected model and date |

## How to run the live probes

The live suite is intentionally opt-in. It is skipped during normal `bun test` runs unless `COPILOT_LIVE_TEST=1` is set.

Required environment variables:

- `COPILOT_LIVE_TEST=1`
- `COPILOT_TOKEN=<your GitHub Copilot bearer token>`
- `COPILOT_LIVE_CLAUDE_MODEL=<claude-model-under-test>` when Claude or Anthropic probes are enabled
- `COPILOT_LIVE_CLAUDE_MODELS=<comma-separated-claude-models-under-test>` as an alternative to run the Claude/Anthropic probes for multiple models in one suite
- `COPILOT_LIVE_RESPONSES_MODEL=<responses-model-under-test>` when Responses probes are enabled

Optional environment variables:

- `COPILOT_ACCOUNT_TYPE=individual|business|enterprise`
- `COPILOT_VSCODE_VERSION=1.104.3`
- `COPILOT_LIVE_RESPONSES_ONLY=1` to run only the configured `/responses` and raw `/responses/*` probes
- `COPILOT_LIVE_ANTHROPIC_ONLY=1` to run only native Anthropic `/v1/messages` and `/v1/files` probes
- `COPILOT_LIVE_IMAGE_URL=https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png`
- `COPILOT_LIVE_FILE_URL=https://www.berkshirehathaway.com/letters/2024ltr.pdf`
- `COPILOT_LIVE_TIMEOUT_MS=180000`
- `COPILOT_LIVE_RETRY_COUNT=2`

Example:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=<claude-model-under-test> \
COPILOT_LIVE_RESPONSES_MODEL=<responses-model-under-test> \
bun run test:live:copilot
```

Responses-only baseline:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_RESPONSES_MODEL=<responses-model-under-test> \
COPILOT_LIVE_RESPONSES_ONLY=1 \
bun run test:live:copilot
```

Anthropic-only baseline:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=<claude-model-under-test> \
COPILOT_LIVE_ANTHROPIC_ONLY=1 \
bun run test:live:copilot
```

Anthropic-only probes across current Opus variants:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODELS=claude-opus-4.8,claude-opus-4.7,claude-opus-4.6 \
COPILOT_LIVE_ANTHROPIC_ONLY=1 \
bun run test:live:copilot
```

Anthropic-only probe for a selected upstream Claude model:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=<another-claude-model-under-test> \
COPILOT_LIVE_ANTHROPIC_ONLY=1 \
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

- Treat each live run as a point-in-time result for the selected model, account type, and Copilot backend.
- If a probe is `supported`, we can wire the corresponding translation path for that validated surface and add normal unit coverage.
- If a probe is `unsupported`, keep the local parsing improvement but omit, downgrade, or explicitly surface the upstream-aligned unsupported error for that surface.
- If a probe fails for environmental reasons, rerun the suite before making routing or translation decisions.

## Codex CLI smoke tests

Use a real `codex` CLI smoke when changing Responses routing, Responses request adaptation, tool handling, hosted tools, structured output, image inputs, or Responses stream handling.

Start the proxy on a disposable port first:

```sh
bun run ./src/main.ts start -p 4899
```

Then run Codex with temporary local state and an explicit Responses provider:

```sh
mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
CODEX_SMOKE_HOME="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/codex-proxy-smoke.XXXXXX")"
CODEX_SMOKE_WORK="$(mktemp -d /tmp/codex-proxy-smoke-work.XXXXXX)"
RESPONSES_MODEL_UNDER_TEST=<responses-model-under-test>

env CODEX_HOME="$CODEX_SMOKE_HOME" \
OPENAI_API_KEY=dummy \
codex --ask-for-approval never exec \
  --ephemeral \
  --ignore-rules \
  --skip-git-repo-check \
  --sandbox read-only \
  --cd "$CODEX_SMOKE_WORK" \
  --model "$RESPONSES_MODEL_UNDER_TEST" \
  -c 'model_provider="copilot-proxy"' \
  -c 'model_providers.copilot-proxy={name="Copilot Proxy", base_url="http://127.0.0.1:4899/v1", env_key="OPENAI_API_KEY", wire_api="responses"}' \
  "Reply with exactly: proxy-ok"
```

Expected behavior:

- Codex uses the temporary `CODEX_HOME`; it does not read or modify the user's `~/.codex`.
- `OPENAI_API_KEY=dummy` only satisfies Codex provider validation. The local proxy does not require this key.
- The configured provider uses `wire_api="responses"` and calls `POST /v1/responses`.
- The request normally uses SSE streaming and includes Codex's tool schemas and agent instructions.
- The CLI should print exactly `proxy-ok`; proxy logs should show upstream `/responses` status `200` and stream completion.

## Claude Code CLI smoke tests

Use a real `claude` CLI smoke when changing Anthropic `/v1/messages` routing, native passthrough sanitization, thinking/output_config handling, tool translation, or Claude Code-specific beta behavior.

Start the proxy on a disposable port first:

```sh
bun run ./src/main.ts start -p 4899
```

Then run Claude Code with temporary local state:

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL="$CLAUDE_MODEL_UNDER_TEST" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model "$CLAUDE_MODEL_UNDER_TEST" \
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
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL="$CLAUDE_MODEL_UNDER_TEST" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model "$CLAUDE_MODEL_UNDER_TEST" \
  --output-format json \
  --no-session-persistence \
  --permission-mode bypassPermissions \
  --allowedTools=Read \
  --disallowedTools=Bash,Edit \
  "Read package.json and answer with only the package name."
```

This verifies a real tool_use/tool_result loop through `/v1/messages`.

For changes that affect Claude Code request adaptation, native `/v1/messages`
passthrough, tool schemas, thinking/output_config handling, or local tool loops,
run the fuller Claude Code smoke matrix across the current Opus variants instead
of only checking one basic prompt. At minimum, cover each model with:

- a no-tool basic prompt that must return a fixed string
- a `Read`-only local file read from `package.json`
- `--json-schema` structured output and validation of the `structured_output`
  object in Claude Code's JSON result
- an isolated temporary-directory `Read,Write,Edit` tool chain that creates,
  edits, reads back, and externally verifies a file
- `--effort max` with a fixed-string response

Use temporary `HOME` and temporary work directories for every run. Do not modify
the user's `~/.claude` state or repository files while running this matrix.

```sh
CLAUDE_MODELS_UNDER_TEST="claude-opus-4.8 claude-opus-4.7 claude-opus-4.6"
for CLAUDE_MODEL_UNDER_TEST in $CLAUDE_MODELS_UNDER_TEST; do
  # 1. Basic no-tool fixed response
  # 2. Read-only package.json tool loop
  # 3. --json-schema structured_output validation
  # 4. Temporary Read/Write/Edit file lifecycle
  # 5. --effort max fixed response
  # Keep each HOME and writable work directory under /tmp.
  :
done
```

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL="$CLAUDE_MODEL_UNDER_TEST" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model "$CLAUDE_MODEL_UNDER_TEST" \
  --output-format json \
  --no-session-persistence \
  --json-schema '{"type":"object","properties":{"status":{"type":"string"}},"required":["status"],"additionalProperties":false}' \
  "Return status proxy-ok."
```

Claude Code implements `--json-schema` by adding a `StructuredOutput` tool. It does not send Anthropic `output_config.format=json_schema`, so this smoke should succeed when normal tool calls work.

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL="$CLAUDE_MODEL_UNDER_TEST" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model "$CLAUDE_MODEL_UNDER_TEST" \
  --effort max \
  --output-format json \
  --no-session-persistence \
  "Reply with exactly: effort-ok"
```

This smoke is only meaningful after a fresh live probe shows how the selected model handles `output_config.effort="max"`. If the live probe reports a clean unsupported result, Claude Code should surface that API error rather than route around it.

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
curl -sS http://127.0.0.1:4899/v1/messages/count_tokens \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d "{\"model\":\"$CLAUDE_MODEL_UNDER_TEST\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Count this short prompt.\"}]}"
```

This checks the Claude-compatible token counting route.

## Important nuance for Anthropic `output_config.format=json_schema`

Do not encode an expected accept/reject result for Anthropic `output_config.format.type="json_schema"` in this document. Run the native Anthropic live probe for the selected model and use that result.

Keep Anthropic `output_config.format.type="json_schema"` on native `/v1/messages` when it is forwarded. Do not route a native rejection through Claude `/chat/completions` as `response_format=json_schema`, because that can produce a schema-invalid 200 response with different semantics.

## Important nuance for Anthropic `output_config.effort=max`

Anthropic `max` is Claude-side reasoning semantics, not a value we should blindly forward to Copilot `/responses` or assume Copilot native Claude accepts.

Do not encode an expected accept/reject result for `output_config.effort` values in this document. Run the live probe for the selected model. If the selected upstream model rejects an effort value cleanly, surface that unsupported error instead of silently changing the request semantics.

The live validation layer therefore treats `/responses` differently:

- First, probe the selected Claude model on its native endpoint.
- Then, if Anthropic-compatible requests are routed onto a Responses-backed model, separately probe the native Copilot/OpenAI-side high-end effort value.

That keeps Claude-specific effort semantics separate from Responses-backed model semantics, with the live probe result as the source of truth.
