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

Use a real `codex` CLI smoke when changing Responses routing, request adaptation, tool handling, hosted tools, structured output, image inputs, or Responses stream handling.

### What counts as a real-machine Codex smoke

A qualifying smoke must use all of the following:

- the real `codex` executable installed on the machine
- a proxy process started from the current checkout
- a real GitHub Copilot credential, exact model ID, and account type
- real TCP and SSE traffic through the local `/v1/responses` route to the real Copilot upstream
- real local tool execution for tool-loop scenarios

In-process `server.request()` calls, direct calls to `createResponses`, `curl` requests without Codex, the live capability probe matrix, and stub/mock/fake upstreams remain useful at their own layers, but none of them substitutes for this client smoke. An HTTP `200` alone is also insufficient: validate the Codex terminal event and the observable result.

Use Codex's `--json` event stream and `--output-last-message` for machine assertions, as documented in the [official non-interactive mode guide](https://learn.chatgpt.com/docs/non-interactive-mode). Do not rely on formatted terminal output or model self-report.

### Preflight and isolated proxy lifecycle

Run the following from the repository root in one Bash shell, keeping all blocks in that same shell. Set `CODEX_SMOKE_MODEL` to a current Responses-backed model that is also present in the installed Codex catalog with local-tool support; an unknown explicit model may run as a text-only client and invalidate the tool-loop case. On macOS, set `CODEX_TIMEOUT_BIN=gtimeout` if GNU `timeout` is installed through coreutils.

```bash
set -euo pipefail

export CODEX_SMOKE_MODEL="${CODEX_SMOKE_MODEL:?set CODEX_SMOKE_MODEL to the exact model ID}"
export CODEX_SMOKE_ACCOUNT_TYPE="${CODEX_SMOKE_ACCOUNT_TYPE:?set CODEX_SMOKE_ACCOUNT_TYPE to individual, business, or enterprise}"
export CODEX_SMOKE_EXPECTED_BACKEND="${CODEX_SMOKE_EXPECTED_BACKEND:-responses}"
export CODEX_SMOKE_PORT="${CODEX_SMOKE_PORT:-4899}"
export CODEX_SMOKE_TIMEOUT_SECONDS="${CODEX_SMOKE_TIMEOUT_SECONDS:-180}"
export CODEX_TIMEOUT_BIN="${CODEX_TIMEOUT_BIN:-timeout}"

case "$CODEX_SMOKE_ACCOUNT_TYPE" in
  individual | business | enterprise) ;;
  *) echo "Invalid CODEX_SMOKE_ACCOUNT_TYPE: $CODEX_SMOKE_ACCOUNT_TYPE" >&2; exit 1 ;;
esac

for command_name in codex curl jq lsof rg "$CODEX_TIMEOUT_BIN"; do
  command -v "$command_name" >/dev/null
done

mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
CODEX_SMOKE_ROOT="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/codex-proxy-smoke.XXXXXX")"
CODEX_SMOKE_HOME="$CODEX_SMOKE_ROOT/codex-home"
CODEX_SMOKE_WORK="$CODEX_SMOKE_ROOT/work"
CODEX_SMOKE_PROXY_LOG="$CODEX_SMOKE_ROOT/proxy.log"
mkdir -p "$CODEX_SMOKE_HOME" "$CODEX_SMOKE_WORK"
git status --short >"$CODEX_SMOKE_ROOT/git-status.before"

cleanup_codex_smoke() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [ -n "${CODEX_SMOKE_PROXY_PID:-}" ] && kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
    kill "$CODEX_SMOKE_PROXY_PID" 2>/dev/null || true
    for _ in {1..40}; do
      if ! kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
      kill -KILL "$CODEX_SMOKE_PROXY_PID" 2>/dev/null || true
    fi
    wait "$CODEX_SMOKE_PROXY_PID" 2>/dev/null || true
  fi
  if lsof -nP -iTCP:"$CODEX_SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $CODEX_SMOKE_PORT is still listening after cleanup." >&2
    exit_status=1
  fi
  rm -rf "$CODEX_SMOKE_ROOT"
  exit "$exit_status"
}
trap cleanup_codex_smoke EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if lsof -nP -iTCP:"$CODEX_SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $CODEX_SMOKE_PORT already has a TCP listener; choose an unused port." >&2
  exit 1
fi

bun run ./src/main.ts start \
  --host 127.0.0.1 \
  --port "$CODEX_SMOKE_PORT" \
  --account-type "$CODEX_SMOKE_ACCOUNT_TYPE" \
  --verbose \
  >"$CODEX_SMOKE_PROXY_LOG" 2>&1 &
CODEX_SMOKE_PROXY_PID=$!

CODEX_SMOKE_READY=0
for _ in {1..60}; do
  if ! kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
    break
  fi
  if lsof -nP -a -p "$CODEX_SMOKE_PROXY_PID" -iTCP:"$CODEX_SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1 \
    && curl -fsS --max-time 1 "http://127.0.0.1:$CODEX_SMOKE_PORT/" >/dev/null; then
    CODEX_SMOKE_READY=1
    break
  fi
  sleep 0.5
done

if [ "$CODEX_SMOKE_READY" -ne 1 ]; then
  sed -n '1,200p' "$CODEX_SMOKE_PROXY_LOG" >&2
  exit 1
fi

date -u +'%Y-%m-%dT%H:%M:%SZ'
git rev-parse HEAD
git status --short
command -v codex
codex --version
env CODEX_HOME="$CODEX_SMOKE_HOME" codex debug models --bundled \
  | jq -e --arg model "$CODEX_SMOKE_MODEL" \
    'any(.models[]; .slug == $model and .supported_in_api == true)' >/dev/null
printf 'account_type=%s\nmodel=%s\nexpected_backend=%s\nproxy_pid=%s\nproxy_port=%s\n' \
  "$CODEX_SMOKE_ACCOUNT_TYPE" \
  "$CODEX_SMOKE_MODEL" \
  "$CODEX_SMOKE_EXPECTED_BACKEND" \
  "$CODEX_SMOKE_PROXY_PID" \
  "$CODEX_SMOKE_PORT"
```

The preflight must fail if the chosen port already has a TCP listener, and readiness must prove that the captured proxy PID owns the new listener. This prevents a smoke from accidentally passing against an older proxy. Keep the temporary `CODEX_HOME` under the user's cache directory rather than `/tmp`: current Codex releases warn and refuse to create PATH helper aliases under a temporary-directory home, which adds avoidable noise to the result. The bundled-model check validates only the local client's selected-model capability; it is not proxy catalog evidence. `--verbose` is required because upstream status, first-event, and stream-completion evidence is logged at debug level.

Define one isolated Codex invocation and one JSONL assertion helper in the same shell:

```bash
codex_smoke() {
  local final_path=$1
  local events_path=$2
  local sandbox_mode=$3
  local codex_status
  local scenario_name
  shift 3

  set +e
  "$CODEX_TIMEOUT_BIN" "${CODEX_SMOKE_TIMEOUT_SECONDS}s" \
    env CODEX_HOME="$CODEX_SMOKE_HOME" \
    OPENAI_API_KEY=dummy \
    codex --ask-for-approval never exec \
      --ephemeral \
      --ignore-user-config \
      --ignore-rules \
      --strict-config \
      --skip-git-repo-check \
      --sandbox "$sandbox_mode" \
      --color never \
      --cd "$CODEX_SMOKE_WORK" \
      --model "$CODEX_SMOKE_MODEL" \
      --json \
      --output-last-message "$final_path" \
      -c 'model_provider="copilot-proxy"' \
      -c "model_providers.copilot-proxy={name=\"Copilot Proxy\",base_url=\"http://127.0.0.1:$CODEX_SMOKE_PORT/v1\",env_key=\"OPENAI_API_KEY\",wire_api=\"responses\"}" \
      "$@" \
    >"$events_path" \
    </dev/null
  codex_status=$?
  set -e

  scenario_name="${events_path##*/}"
  scenario_name="${scenario_name%.jsonl}"
  printf 'scenario=%s codex_exit=%s\n' "$scenario_name" "$codex_status" \
    >>"$CODEX_SMOKE_ROOT/codex-exits.txt"
  printf 'codex_exit=%s\n' "$codex_status"
  if [ "$codex_status" -ne 0 ]; then
    sed -n '1,200p' "$CODEX_SMOKE_PROXY_LOG" >&2
  fi
  return "$codex_status"
}

assert_codex_events() {
  local events_path=$1
  jq -s -e 'any(.[]; .type == "thread.started")' "$events_path" >/dev/null
  jq -s -e 'any(.[]; .type == "turn.started")' "$events_path" >/dev/null
  jq -s -e \
    'any(.[]; .type == "item.completed" and .item.type == "agent_message")' \
    "$events_path" >/dev/null
  jq -s -e 'any(.[]; .type == "turn.completed")' "$events_path" >/dev/null
  if jq -s -e 'any(.[]; .type == "error" or .type == "turn.failed")' "$events_path" >/dev/null; then
    echo "Codex emitted an error or turn.failed event." >&2
    return 1
  fi
}
```

`OPENAI_API_KEY=dummy` only satisfies Codex's custom-provider validation. The local proxy authenticates to Copilot with its normal credential and must not log or copy that token into smoke artifacts. `--json` writes JSONL to stdout while Codex diagnostics remain on stderr, so keep the streams separate; do not use `2>&1` when creating the events file.

### Minimum real-machine gate

#### 1. Streaming baseline

```bash
CODEX_BASELINE_EVENTS="$CODEX_SMOKE_ROOT/baseline.jsonl"
CODEX_BASELINE_FINAL="$CODEX_SMOKE_ROOT/baseline-final.txt"

codex_smoke \
  "$CODEX_BASELINE_FINAL" \
  "$CODEX_BASELINE_EVENTS" \
  read-only \
  'Reply with exactly: proxy-ok'

assert_codex_events "$CODEX_BASELINE_EVENTS"
test "$(cat "$CODEX_BASELINE_FINAL")" = 'proxy-ok'
rg -q -- '--> POST /v1/responses 200' "$CODEX_SMOKE_PROXY_LOG"
rg -q 'Upstream /responses headers received: .*status: 200, stream: true' "$CODEX_SMOKE_PROXY_LOG"
rg -q 'Upstream /responses first SSE event:' "$CODEX_SMOKE_PROXY_LOG"
rg -q "event: 'response.created'" "$CODEX_SMOKE_PROXY_LOG"
rg -q "event: 'response.completed'" "$CODEX_SMOKE_PROXY_LOG"
test "$(rg -c 'tools: [1-9][0-9]*' "$CODEX_SMOKE_PROXY_LOG")" -ge 1
```

For a Responses-backed model, require a local `POST /v1/responses`, at least one advertised tool under the selected Codex model/configuration, upstream `/responses` status `200`, `stream: true`, a first SSE event, a terminal `response.completed` event, and a terminal Codex event. Record upstream iterator completion when the client remains connected through EOF, but do not require it after a valid terminal event because Codex may close the stream immediately. The final message must match exactly; seeing only a process exit code or HTTP status is not enough.

#### 2. Forced read-only tool loop

This case verifies the agentic path that the fixed-string baseline cannot exercise: model tool call, real local command execution, tool result submission, a second Responses turn, and the final answer.

```bash
CODEX_TOOL_SENTINEL="codex-tool-loop-$(date +%s)-$$"
printf '%s\n' "$CODEX_TOOL_SENTINEL" >"$CODEX_SMOKE_WORK/sentinel.txt"
CODEX_TOOL_EVENTS="$CODEX_SMOKE_ROOT/tool-loop.jsonl"
CODEX_TOOL_FINAL="$CODEX_SMOKE_ROOT/tool-loop-final.txt"
CODEX_TOOL_LOG_START="$(wc -l <"$CODEX_SMOKE_PROXY_LOG")"

codex_smoke \
  "$CODEX_TOOL_FINAL" \
  "$CODEX_TOOL_EVENTS" \
  read-only \
  'You must use the exec_command tool to read sentinel.txt. Do not guess or answer before reading it. Reply with only the exact file contents.'

assert_codex_events "$CODEX_TOOL_EVENTS"
jq -s -e \
  'any(.[]; .type == "item.completed" and .item.type == "command_execution" and .item.status == "completed" and .item.exit_code == 0)' \
  "$CODEX_TOOL_EVENTS" >/dev/null
test "$(cat "$CODEX_TOOL_FINAL")" = "$CODEX_TOOL_SENTINEL"

tail -n "+$((CODEX_TOOL_LOG_START + 1))" \
  "$CODEX_SMOKE_PROXY_LOG" \
  >"$CODEX_SMOKE_ROOT/tool-loop-proxy.log"
test "$(rg -c 'Responses API request summary' "$CODEX_SMOKE_ROOT/tool-loop-proxy.log")" -ge 2
test "$(rg -c 'functionCalls: [1-9][0-9]*' "$CODEX_SMOKE_ROOT/tool-loop-proxy.log")" -ge 1
test "$(rg -c 'functionCallOutputs: [1-9][0-9]*' "$CODEX_SMOKE_ROOT/tool-loop-proxy.log")" -ge 1
test "$(rg -c "event: 'response.completed'" "$CODEX_SMOKE_ROOT/tool-loop-proxy.log")" -ge 2
```

The second request must carry the matching tool-call history and `function_call_output`. Assert terminal `response.completed` events rather than requiring the upstream iterator to reach EOF for every turn: Codex may close the client stream immediately after the terminal event. When auditing exact fields, capture and inspect them at the proxy boundary; do not ask the model whether it received or sent them.

### Surface-specific real-machine cases

Run the minimum gate for every Responses behavior change, then add the matching scenario below. A schema merely being present in the first request does not prove that the feature works.

| Changed surface | Required real Codex scenario | Semantic evidence |
| --- | --- | --- |
| Tool handling or `apply_patch` | Isolated `workspace-write` file lifecycle | Codex invokes a real tool, the follow-up request contains the result, and the file is verified outside Codex |
| Structured output | `--output-schema <schema>` | Final output parses and satisfies the schema |
| Image input | `--image <known-local-fixture>` | The real Codex image request succeeds and the answer proves the known image fact |
| Web search | A prompt that requires an actual search | Codex JSONL contains a web-search event and the result uses returned evidence |
| MCP | A disposable real MCP server with a deterministic tool | Codex JSONL contains the MCP call/result and the final answer uses the returned value |
| Responses-to-Anthropic translation | The exact Claude model and intended Codex configuration | Proxy logs prove `/v1/responses` translated to the real `/v1/messages` upstream and the terminal SSE is client-compatible |
| Streaming cancellation | Interrupt the real Codex process after the first upstream SSE event | Codex exits within a bound, the captured proxy request does not finish with route status `500`, the proxy listener remains healthy, and an immediate baseline rerun succeeds |

For an `apply_patch` or writable-tool change, use only a temporary Git repository and verify the file from the shell:

```bash
CODEX_SMOKE_WORK="$CODEX_SMOKE_ROOT/write-work"
mkdir -p "$CODEX_SMOKE_WORK"
git -C "$CODEX_SMOKE_WORK" init -q
printf 'before\n' >"$CODEX_SMOKE_WORK/edit-me.txt"

codex_smoke \
  "$CODEX_SMOKE_ROOT/write-final.txt" \
  "$CODEX_SMOKE_ROOT/write.jsonl" \
  workspace-write \
  'Use apply_patch to replace the complete contents of edit-me.txt with a single line containing after. Read the file back, then reply with exactly: write-ok'

assert_codex_events "$CODEX_SMOKE_ROOT/write.jsonl"
jq -s -e \
  'any(.[]; .type == "item.completed" and .item.type == "file_change" and .item.status == "completed")' \
  "$CODEX_SMOKE_ROOT/write.jsonl" >/dev/null
test "$(cat "$CODEX_SMOKE_ROOT/write-final.txt")" = 'write-ok'
test "$(cat "$CODEX_SMOKE_WORK/edit-me.txt")" = 'after'
```

For structured output, validate the artifact rather than accepting a plausible-looking response:

```bash
cat >"$CODEX_SMOKE_ROOT/schema.json" <<'JSON'
{
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["proxy-ok"] }
  },
  "required": ["status"],
  "additionalProperties": false
}
JSON

CODEX_SMOKE_WORK="$CODEX_SMOKE_ROOT/structured-work"
mkdir -p "$CODEX_SMOKE_WORK"
codex_smoke \
  "$CODEX_SMOKE_ROOT/structured-final.json" \
  "$CODEX_SMOKE_ROOT/structured.jsonl" \
  read-only \
  --output-schema "$CODEX_SMOKE_ROOT/schema.json" \
  'Return status proxy-ok.'

assert_codex_events "$CODEX_SMOKE_ROOT/structured.jsonl"
jq -e '.status == "proxy-ok"' "$CODEX_SMOKE_ROOT/structured-final.json" >/dev/null
```

For a Claude translation change, test the default Codex tool set first. Do not silently disable hosted or custom tools just to obtain a green text response. If the intended supported configuration requires overrides, record the default result and then run the restricted positive case, listing every override. A restricted success proves only that scoped configuration, not general Codex-to-Claude compatibility.

### Model-catalog boundary

As verified with `codex-cli 0.144.1` on 2026-07-13, `codex debug models` with a custom provider prints Codex's bundled catalog and does not request that provider's `/v1/models?client_version=...` endpoint. Re-check this behavior after Codex upgrades. Until an actual Codex surface is observed making that request, validate the route separately and label it a route smoke, not a Codex real-machine smoke:

```bash
CODEX_CLIENT_VERSION="$(codex --version | awk '{print $2}')"
curl -fsS \
  "http://127.0.0.1:$CODEX_SMOKE_PORT/v1/models?client_version=$CODEX_CLIENT_VERSION" \
  | jq -e '.models | type == "array" and length > 0' >/dev/null
```

### Evidence record and cleanup

Record the UTC date, Git SHA and dirty state, `codex` path and version, Copilot account type, exact model ID, expected backend, scenario IDs, configuration overrides, Codex exit status, terminal event, semantic assertion, local route, upstream endpoint/status, and stream completion when the client remains connected through EOF. Emit a redacted summary before cleanup; retain that summary in the surrounding job or terminal log when it supports an upstream-gated decision. Never retain authorization headers, tokens, raw proxy logs, or unredacted user content.

The minimum gate can emit a machine-readable summary without preserving its raw temporary artifacts:

```bash
emit_codex_smoke_summary() {
  local git_dirty
  if [ -s "$CODEX_SMOKE_ROOT/git-status.before" ]; then
    git_dirty=true
  else
    git_dirty=false
  fi

  printf 'date_utc=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf 'git_sha=%s\n' "$(git rev-parse HEAD)"
  printf 'git_dirty=%s\n' "$git_dirty"
  printf 'codex_path=%s\n' "$(command -v codex)"
  printf 'codex_version=%s\n' "$(codex --version)"
  printf 'account_type=%s\n' "$CODEX_SMOKE_ACCOUNT_TYPE"
  printf 'model=%s\n' "$CODEX_SMOKE_MODEL"
  printf 'expected_backend=%s\n' "$CODEX_SMOKE_EXPECTED_BACKEND"
  printf 'proxy_pid=%s\n' "$CODEX_SMOKE_PROXY_PID"
  printf 'proxy_port=%s\n' "$CODEX_SMOKE_PORT"
  cat "$CODEX_SMOKE_ROOT/codex-exits.txt"
  printf 'baseline_turn_completed=true\n'
  printf 'baseline_final_match=true\n'
  printf 'tool_command_completed=true\n'
  printf 'tool_final_match=true\n'
  printf 'local_responses_200=%s\n' \
    "$(rg -c -- '--> POST /v1/responses 200' "$CODEX_SMOKE_PROXY_LOG")"
  printf 'upstream_responses_200=%s\n' \
    "$(rg -c 'Upstream /responses headers received: .*status: 200' "$CODEX_SMOKE_PROXY_LOG")"
  printf 'terminal_response_completed=%s\n' \
    "$(rg -c "event: 'response.completed'" "$CODEX_SMOKE_PROXY_LOG")"
  printf 'upstream_stream_completed=%s\n' \
    "$(rg -c 'Upstream /responses stream completed:' "$CODEX_SMOKE_PROXY_LOG")"
}

emit_codex_smoke_summary
```

Add equivalent scenario-specific assertion fields when running writable tools, structured output, images, web search, MCP, translation, or cancellation cases.

Before leaving the shell, verify that the repository did not change:

```bash
git status --short >"$CODEX_SMOKE_ROOT/git-status.after"
cmp -s \
  "$CODEX_SMOKE_ROOT/git-status.before" \
  "$CODEX_SMOKE_ROOT/git-status.after"
```

Exiting the shell runs the trap, sends `TERM` only to the captured proxy PID, escalates to `KILL` after a bounded wait, verifies that the selected port is no longer listening, and removes the temporary `CODEX_HOME`, work directories, JSONL, final outputs, and logs. Do not modify or delete the user's real `~/.codex` state.

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
