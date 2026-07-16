#!/usr/bin/env bash

set -euo pipefail

# This gate deliberately invokes the installed `codex` command. Do not replace
# either transport run with a mock client, direct proxy call, or protocol fixture.

: "${COPILOT_LIVE_CODEX_SMOKE:?set COPILOT_LIVE_CODEX_SMOKE=1 to run the real Codex CLI smoke}"
: "${CODEX_SMOKE_MODEL:?set CODEX_SMOKE_MODEL to a current Responses model with ws:/responses}"
: "${CODEX_SMOKE_ACCOUNT_TYPE:?set CODEX_SMOKE_ACCOUNT_TYPE to individual, business, or enterprise}"

if [[ "$COPILOT_LIVE_CODEX_SMOKE" != "1" ]]; then
  echo "COPILOT_LIVE_CODEX_SMOKE must be 1." >&2
  exit 1
fi

case "$CODEX_SMOKE_ACCOUNT_TYPE" in
  individual | business | enterprise) ;;
  *)
    echo "CODEX_SMOKE_ACCOUNT_TYPE must be individual, business, or enterprise." >&2
    exit 1
    ;;
esac

CODEX_SMOKE_PORT="${CODEX_SMOKE_PORT:-4899}"
CODEX_SMOKE_TIMEOUT_SECONDS="${CODEX_SMOKE_TIMEOUT_SECONDS:-180}"
CODEX_TIMEOUT_BIN="${CODEX_TIMEOUT_BIN:-timeout}"

if ! [[ "$CODEX_SMOKE_PORT" =~ ^[0-9]+$ ]] || ((CODEX_SMOKE_PORT < 1 || CODEX_SMOKE_PORT > 65535)); then
  echo "CODEX_SMOKE_PORT must be an integer from 1 through 65535." >&2
  exit 1
fi
if ! [[ "$CODEX_SMOKE_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  || ((CODEX_SMOKE_TIMEOUT_SECONDS < 10 || CODEX_SMOKE_TIMEOUT_SECONDS > 1800)); then
  echo "CODEX_SMOKE_TIMEOUT_SECONDS must be an integer from 10 through 1800." >&2
  exit 1
fi

for command_name in bun codex curl jq lsof rg "$CODEX_TIMEOUT_BIN"; do
  command -v "$command_name" >/dev/null
done

mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
CODEX_SMOKE_ROOT="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/codex-proxy-smoke.XXXXXX")"
CODEX_SMOKE_PROXY_LOG="$CODEX_SMOKE_ROOT/proxy.log"
CODEX_SMOKE_WORK="$CODEX_SMOKE_ROOT/work"
CODEX_SMOKE_HTTP_HOME="$CODEX_SMOKE_ROOT/codex-http"
CODEX_SMOKE_WS_HOME="$CODEX_SMOKE_ROOT/codex-websocket"
CODEX_SMOKE_TMP="$CODEX_SMOKE_ROOT/tmp"
CODEX_SMOKE_INSTANCE_TOKEN="codex-smoke-$$-$(date +%s)"
CODEX_SMOKE_SUCCESS=0
CODEX_SMOKE_PHASE=preflight
mkdir -p "$CODEX_SMOKE_WORK" "$CODEX_SMOKE_HTTP_HOME/home" "$CODEX_SMOKE_WS_HOME/home" "$CODEX_SMOKE_TMP"

cleanup_codex_smoke() {
  local exit_status=$?
  trap - EXIT INT TERM

  if [[ -n "${CODEX_SMOKE_PROXY_PID:-}" ]] && kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
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
    echo "Port $CODEX_SMOKE_PORT is still listening after Codex smoke cleanup." >&2
    exit_status=1
  fi

  if ! git status --porcelain=v1 -z >"$CODEX_SMOKE_ROOT/git-status.after"; then
    echo "Failed to inspect the repository after the Codex smoke." >&2
    exit_status=1
  elif [[ ! -f "$CODEX_SMOKE_ROOT/git-status.before" ]] \
    || ! cmp -s "$CODEX_SMOKE_ROOT/git-status.before" "$CODEX_SMOKE_ROOT/git-status.after"; then
    echo "The Codex smoke changed the repository worktree." >&2
    exit_status=1
  fi

  if ! rm -rf "$CODEX_SMOKE_ROOT" || [[ -e "$CODEX_SMOKE_ROOT" ]]; then
    echo "Failed to remove the Codex smoke temporary directory." >&2
    exit_status=1
  fi
  if [[ "$exit_status" -eq 0 && "$CODEX_SMOKE_SUCCESS" -eq 1 ]]; then
    printf 'real_codex_cli_smoke=passed date_utc=%s git_sha=%s dirty=%s codex_version=%s model=%s account_type=%s http_turns=%s websocket_turns=%s websocket_terminals=%s websocket_completed=%s local_101=%s upstream_101=%s websocket_connections=%s websocket_single_socket=true websocket_store_false=%s websocket_first_previous_absent=%s websocket_previous_chain=%s websocket_http_fallbacks=0%s\n' \
      "$CODEX_SMOKE_DATE_UTC" "$CODEX_SMOKE_GIT_SHA" "$CODEX_SMOKE_DIRTY" \
      "$CODEX_SMOKE_CLIENT_VERSION" "$CODEX_SMOKE_MODEL" "$CODEX_SMOKE_ACCOUNT_TYPE" \
      "$CODEX_HTTP_POSTS" "$CODEX_WS_FORWARDED" "$CODEX_WS_TERMINAL" \
      "$CODEX_WS_COMPLETED" "$CODEX_WS_DOWNSTREAM_101" "$CODEX_WS_UPSTREAM_101" \
      "$CODEX_WS_CONNECTION_COUNT" "$CODEX_WS_STORE_FALSE" \
      "$CODEX_WS_PREVIOUS_ABSENT" "$CODEX_WS_PREVIOUS_MATCHES" \
      "$CODEX_WS_GENERATE_FALSE_SUMMARY"
  elif [[ "$exit_status" -ne 0 ]]; then
    printf 'real_codex_cli_smoke=failed phase=%s\n' "$CODEX_SMOKE_PHASE" >&2
  fi
  exit "$exit_status"
}
trap cleanup_codex_smoke EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git status --porcelain=v1 -z >"$CODEX_SMOKE_ROOT/git-status.before"
CODEX_SMOKE_DATE_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CODEX_SMOKE_GIT_SHA="$(git rev-parse --verify HEAD)"
CODEX_SMOKE_DIRTY=false
if [[ -s "$CODEX_SMOKE_ROOT/git-status.before" ]]; then
  CODEX_SMOKE_DIRTY=true
fi

if lsof -nP -iTCP:"$CODEX_SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $CODEX_SMOKE_PORT already has a listener; choose another CODEX_SMOKE_PORT." >&2
  exit 1
fi

NO_COLOR=1 FORCE_COLOR=0 bun run ./src/main.ts start \
  --host 127.0.0.1 \
  --port "$CODEX_SMOKE_PORT" \
  --account-type "$CODEX_SMOKE_ACCOUNT_TYPE" \
  --verbose \
  --_instance-token "$CODEX_SMOKE_INSTANCE_TOKEN" \
  >"$CODEX_SMOKE_PROXY_LOG" 2>&1 &
CODEX_SMOKE_PROXY_PID=$!

CODEX_SMOKE_READY=0
for _ in {1..120}; do
  if ! kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
    break
  fi
  if curl -fsS --max-time 1 -D "$CODEX_SMOKE_ROOT/readiness.headers" \
    -o /dev/null "http://127.0.0.1:$CODEX_SMOKE_PORT/" 2>/dev/null \
    && rg -i -Fq "x-copilot-proxy-instance-token: $CODEX_SMOKE_INSTANCE_TOKEN" \
      "$CODEX_SMOKE_ROOT/readiness.headers"; then
    CODEX_SMOKE_READY=1
    break
  fi
  sleep 0.25
done
if [[ "$CODEX_SMOKE_READY" -ne 1 ]]; then
  echo "The disposable proxy did not become ready." >&2
  exit 1
fi

CODEX_SMOKE_PHASE=codex_version
CODEX_SMOKE_VERSION="$(
  "$CODEX_TIMEOUT_BIN" --kill-after=5s "${CODEX_SMOKE_TIMEOUT_SECONDS}s" \
    env -i PATH="$PATH" HOME="$CODEX_SMOKE_HTTP_HOME/home" \
    CODEX_HOME="$CODEX_SMOKE_HTTP_HOME" LANG="${LANG:-C.UTF-8}" \
    NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost' \
    codex --version
)"
CODEX_SMOKE_CLIENT_VERSION="$(rg -o '[0-9]+\.[0-9]+\.[0-9]+(?:[-+][[:alnum:]._-]+)?' <<<"$CODEX_SMOKE_VERSION" | head -n 1)"
[[ -n "$CODEX_SMOKE_CLIENT_VERSION" ]]
CODEX_SMOKE_PHASE=codex_bundled_catalog
"$CODEX_TIMEOUT_BIN" --kill-after=5s "${CODEX_SMOKE_TIMEOUT_SECONDS}s" \
  env -i PATH="$PATH" HOME="$CODEX_SMOKE_HTTP_HOME/home" \
    CODEX_HOME="$CODEX_SMOKE_HTTP_HOME" LANG="${LANG:-C.UTF-8}" \
    NO_PROXY='127.0.0.1,localhost' no_proxy='127.0.0.1,localhost' \
    codex debug models --bundled \
  | jq -e --arg model "$CODEX_SMOKE_MODEL" \
    'any(.models[]; .slug == $model and .supported_in_api == true)' >/dev/null

run_real_codex() {
  local codex_home=$1
  local supports_websockets=$2
  local final_path=$3
  local events_path=$4
  local diagnostics_path=$5
  local prompt=$6
  local status

  set +e
  "$CODEX_TIMEOUT_BIN" --kill-after=5s "${CODEX_SMOKE_TIMEOUT_SECONDS}s" \
    env -i \
    PATH="$PATH" \
    HOME="$codex_home/home" \
    CODEX_HOME="$codex_home" \
    TMPDIR="$CODEX_SMOKE_TMP" \
    LANG="${LANG:-C.UTF-8}" \
    SHELL="${SHELL:-/bin/sh}" \
    NO_PROXY='127.0.0.1,localhost' \
    no_proxy='127.0.0.1,localhost' \
    OPENAI_API_KEY=dummy \
    RUST_LOG=warn \
    NO_COLOR=1 \
    FORCE_COLOR=0 \
    codex --ask-for-approval never exec \
      --ephemeral \
      --ignore-user-config \
      --ignore-rules \
      --strict-config \
      --skip-git-repo-check \
      --sandbox read-only \
      --color never \
      --cd "$CODEX_SMOKE_WORK" \
      --model "$CODEX_SMOKE_MODEL" \
      --json \
      --output-last-message "$final_path" \
      -c 'model_provider="copilot-proxy-smoke"' \
      -c 'shell_environment_policy={inherit="none"}' \
      -c "model_providers.copilot-proxy-smoke={name=\"Copilot Proxy Smoke\",base_url=\"http://127.0.0.1:$CODEX_SMOKE_PORT/v1\",env_key=\"OPENAI_API_KEY\",wire_api=\"responses\",request_max_retries=0,stream_max_retries=0,supports_websockets=$supports_websockets,websocket_connect_timeout_ms=10000}" \
      "$prompt" \
    >"$events_path" 2>"$diagnostics_path" </dev/null
  status=$?
  set -e

  if [[ "$status" -ne 0 ]]; then
    echo "The real codex command exited with status $status." >&2
    return "$status"
  fi
}

assert_codex_tool_loop() {
  local events_path=$1
  local final_path=$2
  local sentinel=$3

  jq -s -e 'any(.[]; .type == "thread.started")' "$events_path" >/dev/null
  jq -s -e 'any(.[]; .type == "turn.started")' "$events_path" >/dev/null
  jq -s -e \
    'any(.[]; .type == "item.completed" and .item.type == "command_execution" and .item.status == "completed" and .item.exit_code == 0)' \
    "$events_path" >/dev/null
  jq -s -e 'any(.[]; .type == "turn.completed")' "$events_path" >/dev/null
  jq -s -e 'all(.[]; .type != "error" and .type != "turn.failed")' "$events_path" >/dev/null
  [[ "$(cat "$final_path")" == "$sentinel" ]]
}

assert_no_match() {
  local pattern=$1
  local file=$2
  local status

  set +e
  rg -q -- "$pattern" "$file"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    echo "Unexpected smoke evidence matched: $pattern" >&2
    return 1
  fi
  if [[ "$status" -ne 1 ]]; then
    echo "Failed to inspect smoke evidence for: $pattern" >&2
    return "$status"
  fi
}

assert_no_match_i() {
  local pattern=$1
  local file=$2
  local status

  set +e
  rg -qi -- "$pattern" "$file"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    echo "Unexpected smoke evidence matched: $pattern" >&2
    return 1
  fi
  if [[ "$status" -ne 1 ]]; then
    echo "Failed to inspect smoke evidence for: $pattern" >&2
    return "$status"
  fi
}

count_matches() {
  local pattern=$1
  local file=$2
  local count
  local status

  set +e
  count="$(rg -c -- "$pattern" "$file")"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]]; then
    printf '%s\n' "$count"
    return 0
  fi
  if [[ "$status" -eq 1 ]]; then
    printf '0\n'
    return 0
  fi
  echo "Failed to count smoke evidence for: $pattern" >&2
  return "$status"
}

CODEX_HTTP_SENTINEL="codex-http-tool-loop-$(date +%s)-$$"
printf '%s\n' "$CODEX_HTTP_SENTINEL" >"$CODEX_SMOKE_WORK/http-sentinel.txt"
CODEX_HTTP_LOG_START="$(wc -l <"$CODEX_SMOKE_PROXY_LOG")"
CODEX_SMOKE_PHASE=http_cli
run_real_codex \
  "$CODEX_SMOKE_HTTP_HOME" false \
  "$CODEX_SMOKE_ROOT/http-final.txt" \
  "$CODEX_SMOKE_ROOT/http-events.jsonl" \
  "$CODEX_SMOKE_ROOT/http-diagnostics.log" \
  'You must use the exec_command tool to read http-sentinel.txt. Do not guess. Reply with only the exact file contents.'
CODEX_SMOKE_PHASE=http_semantic_evidence
assert_codex_tool_loop \
  "$CODEX_SMOKE_ROOT/http-events.jsonl" \
  "$CODEX_SMOKE_ROOT/http-final.txt" \
  "$CODEX_HTTP_SENTINEL"
CODEX_SMOKE_PHASE=http_transport_evidence
tail -n "+$((CODEX_HTTP_LOG_START + 1))" "$CODEX_SMOKE_PROXY_LOG" >"$CODEX_SMOKE_ROOT/http-proxy.log"
CODEX_HTTP_POSTS="$(count_matches '--> POST /v1/responses 200' "$CODEX_SMOKE_ROOT/http-proxy.log")"
CODEX_HTTP_SUMMARIES="$(count_matches 'Responses API request summary:' "$CODEX_SMOKE_ROOT/http-proxy.log")"
CODEX_HTTP_HEADERS="$(count_matches 'Upstream /responses headers received:' "$CODEX_SMOKE_ROOT/http-proxy.log")"
CODEX_HTTP_STREAM_TRUE="$(count_matches 'stream: true' "$CODEX_SMOKE_ROOT/http-proxy.log")"
CODEX_HTTP_FIRST_EVENTS="$(count_matches 'Upstream /responses first SSE event:' "$CODEX_SMOKE_ROOT/http-proxy.log")"
CODEX_HTTP_COMPLETED="$(count_matches "event: 'response.completed'" "$CODEX_SMOKE_ROOT/http-proxy.log")"
if [[ "$CODEX_HTTP_POSTS" -lt 2 || "$CODEX_HTTP_SUMMARIES" -lt 2 \
  || "$CODEX_HTTP_HEADERS" -lt 2 || "$CODEX_HTTP_STREAM_TRUE" -lt 2 \
  || "$CODEX_HTTP_FIRST_EVENTS" -lt 2 || "$CODEX_HTTP_COMPLETED" -lt 2 ]]; then
  printf 'Unexpected HTTP smoke counts: posts=%s summaries=%s headers=%s stream_true=%s first_events=%s completed=%s\n' \
    "$CODEX_HTTP_POSTS" "$CODEX_HTTP_SUMMARIES" "$CODEX_HTTP_HEADERS" \
    "$CODEX_HTTP_STREAM_TRUE" "$CODEX_HTTP_FIRST_EVENTS" "$CODEX_HTTP_COMPLETED" >&2
  exit 1
fi
rg -q 'functionCalls: [1-9][0-9]*' "$CODEX_SMOKE_ROOT/http-proxy.log"
rg -q 'functionCallOutputs: [1-9][0-9]*' "$CODEX_SMOKE_ROOT/http-proxy.log"
assert_no_match 'Responses WebSocket downstream upgrade completed:' "$CODEX_SMOKE_ROOT/http-proxy.log"

CODEX_SMOKE_PHASE=websocket_catalog
curl -fsS --max-time "$CODEX_SMOKE_TIMEOUT_SECONDS" \
  "http://127.0.0.1:$CODEX_SMOKE_PORT/v1/models?client_version=$CODEX_SMOKE_CLIENT_VERSION" \
  | jq -e --arg model "$CODEX_SMOKE_MODEL" \
    'any(.models[]; .slug == $model and .supports_websockets == true)' >/dev/null

CODEX_WS_SENTINEL="codex-ws-tool-loop-$(date +%s)-$$"
printf '%s\n' "$CODEX_WS_SENTINEL" >"$CODEX_SMOKE_WORK/ws-sentinel.txt"
CODEX_WS_LOG_START="$(wc -l <"$CODEX_SMOKE_PROXY_LOG")"
CODEX_SMOKE_PHASE=websocket_cli
run_real_codex \
  "$CODEX_SMOKE_WS_HOME" true \
  "$CODEX_SMOKE_ROOT/ws-final.txt" \
  "$CODEX_SMOKE_ROOT/ws-events.jsonl" \
  "$CODEX_SMOKE_ROOT/ws-diagnostics.log" \
  'You must use the exec_command tool to read ws-sentinel.txt. Do not guess. Reply with only the exact file contents.'
CODEX_SMOKE_PHASE=websocket_semantic_evidence
assert_codex_tool_loop \
  "$CODEX_SMOKE_ROOT/ws-events.jsonl" \
  "$CODEX_SMOKE_ROOT/ws-final.txt" \
  "$CODEX_WS_SENTINEL"
CODEX_SMOKE_PHASE=websocket_transport_evidence
tail -n "+$((CODEX_WS_LOG_START + 1))" "$CODEX_SMOKE_PROXY_LOG" >"$CODEX_SMOKE_ROOT/ws-proxy.log"

CODEX_WS_FORWARDED="$(count_matches 'Forwarded Responses WebSocket request:' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_TERMINAL="$(count_matches 'Copilot Responses WebSocket terminal event:' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_UPSTREAM_101="$(count_matches 'Copilot Responses WebSocket handshake completed:' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_COMPLETED="$(count_matches "event: 'response.completed'" "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_DOWNSTREAM_101="$(count_matches 'Responses WebSocket downstream upgrade completed:' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_UPSTREAM_ATTEMPTS="$(count_matches 'Opening Copilot Responses WebSocket connection:' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_GENERATE_FALSE_REJECTIONS="$(count_matches 'Rejected Responses WebSocket generate:false locally:' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_STORE_FALSE="$(count_matches 'storeFalse: true' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_PREVIOUS_ABSENT="$(count_matches 'hasPreviousResponseId: false' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_PREVIOUS_PRESENT="$(count_matches 'hasPreviousResponseId: true' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_PREVIOUS_MATCHES="$(count_matches 'previousResponseIdMatchesLast: true' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_PREVIOUS_MISMATCHES="$(count_matches 'previousResponseIdMatchesLast: false' "$CODEX_SMOKE_ROOT/ws-proxy.log")"
CODEX_WS_CHAINED_TURNS=$((CODEX_WS_FORWARDED - 1))
if [[ "$CODEX_WS_FORWARDED" -lt 2 || "$CODEX_WS_TERMINAL" -ne "$CODEX_WS_FORWARDED" \
  || "$CODEX_WS_UPSTREAM_101" -ne 1 || "$CODEX_WS_COMPLETED" -ne "$CODEX_WS_FORWARDED" \
  || "$CODEX_WS_DOWNSTREAM_101" -lt 1 ]]; then
  printf 'Unexpected WebSocket smoke counts: downstream_101=%s upstream_101=%s forwarded=%s terminal=%s completed=%s\n' \
    "$CODEX_WS_DOWNSTREAM_101" "$CODEX_WS_UPSTREAM_101" "$CODEX_WS_FORWARDED" \
    "$CODEX_WS_TERMINAL" "$CODEX_WS_COMPLETED" >&2
  exit 1
fi
# These fields come from the proxy's redacted per-turn summary. They prove the
# state chain without retaining raw response.create frames, prompts, IDs, or
# tool output. The first turn must start a new chain; every later turn must
# refer to the immediately preceding terminal response.
if [[ "$CODEX_WS_STORE_FALSE" -ne "$CODEX_WS_FORWARDED" \
  || "$CODEX_WS_PREVIOUS_ABSENT" -ne 1 \
  || "$CODEX_WS_PREVIOUS_PRESENT" -ne "$CODEX_WS_CHAINED_TURNS" \
  || "$CODEX_WS_PREVIOUS_MATCHES" -ne "$CODEX_WS_CHAINED_TURNS" \
  || "$CODEX_WS_PREVIOUS_MISMATCHES" -ne 1 ]]; then
  printf 'Unexpected WebSocket state-chain evidence: forwarded=%s store_false=%s previous_absent=%s previous_present=%s previous_matches=%s previous_mismatches=%s\n' \
    "$CODEX_WS_FORWARDED" "$CODEX_WS_STORE_FALSE" "$CODEX_WS_PREVIOUS_ABSENT" \
    "$CODEX_WS_PREVIOUS_PRESENT" "$CODEX_WS_PREVIOUS_MATCHES" \
    "$CODEX_WS_PREVIOUS_MISMATCHES" >&2
  exit 1
fi
assert_no_match 'POST /v1/responses' "$CODEX_SMOKE_ROOT/ws-proxy.log"
assert_no_match 'Responses API request summary:' "$CODEX_SMOKE_ROOT/ws-proxy.log"
assert_no_match_i 'falling back to HTTP|fallback_to_http' "$CODEX_SMOKE_ROOT/ws-diagnostics.log"

CODEX_WS_SEQUENCE="$(
  rg -o 'Forwarded Responses WebSocket request:|Copilot Responses WebSocket terminal event:' \
    "$CODEX_SMOKE_ROOT/ws-proxy.log" \
    | sed -e 's/Forwarded Responses WebSocket request:/request/' \
      -e 's/Copilot Responses WebSocket terminal event:/terminal/' \
    | paste -sd, -
)"
if ! [[ "$CODEX_WS_SEQUENCE" =~ ^request,terminal(,request,terminal)+$ ]]; then
  echo "Unexpected WebSocket request/terminal order: $CODEX_WS_SEQUENCE" >&2
  exit 1
fi

CODEX_WS_FORWARD_CONNECTIONS="$(
  rg 'Forwarded Responses WebSocket request:' "$CODEX_SMOKE_ROOT/ws-proxy.log" \
    | sed -nE "s/.*connectionId: '([^']+)'.*/\1/p" \
    | sort -u
)"
CODEX_WS_TERMINAL_CONNECTIONS="$(
  rg 'Copilot Responses WebSocket terminal event:' "$CODEX_SMOKE_ROOT/ws-proxy.log" \
    | sed -nE "s/.*connectionId: '([^']+)'.*/\1/p" \
    | sort -u
)"
CODEX_WS_DOWNSTREAM_CONNECTIONS="$(
  rg 'Responses WebSocket downstream upgrade completed:' "$CODEX_SMOKE_ROOT/ws-proxy.log" \
    | sed -nE "s/.*connectionId: '([^']+)'.*/\1/p" \
    | sort -u
)"
CODEX_WS_REJECTED_CONNECTIONS="$(
  sed -nE "/Rejected Responses WebSocket generate:false locally:/s/.*connectionId: '([^']+)'.*/\1/p" \
    "$CODEX_SMOKE_ROOT/ws-proxy.log" \
    | sort -u
)"
CODEX_WS_EXPECTED_CONNECTIONS="$(
  printf '%s\n%s\n' "$CODEX_WS_FORWARD_CONNECTIONS" "$CODEX_WS_REJECTED_CONNECTIONS" \
    | sed '/^$/d' \
    | sort -u
)"
[[ -n "$CODEX_WS_FORWARD_CONNECTIONS" ]]
[[ "$CODEX_WS_FORWARD_CONNECTIONS" == "$CODEX_WS_TERMINAL_CONNECTIONS" ]]
CODEX_WS_CONNECTION_COUNT="$(rg -c '.+' <<<"$CODEX_WS_FORWARD_CONNECTIONS")"
[[ "$CODEX_WS_CONNECTION_COUNT" -eq 1 ]]
rg -Fxq -- "$CODEX_WS_FORWARD_CONNECTIONS" <<<"$CODEX_WS_DOWNSTREAM_CONNECTIONS"
CODEX_WS_EXPECTED_DOWNSTREAM_CONNECTIONS="$(awk 'NF { count++ } END { print count + 0 }' <<<"$CODEX_WS_EXPECTED_CONNECTIONS")"
if [[ "$CODEX_WS_DOWNSTREAM_CONNECTIONS" != "$CODEX_WS_EXPECTED_CONNECTIONS" \
  || "$CODEX_WS_DOWNSTREAM_101" -ne "$CODEX_WS_EXPECTED_DOWNSTREAM_CONNECTIONS" \
  || "$CODEX_WS_UPSTREAM_ATTEMPTS" -ne "$CODEX_WS_CONNECTION_COUNT" ]]; then
  printf 'Unexpected WebSocket connection evidence: local_101=%s active_connections=%s rejected_connections=%s generate_false_rejections=%s upstream_attempts=%s\n' \
    "$CODEX_WS_DOWNSTREAM_101" "$CODEX_WS_CONNECTION_COUNT" \
    "$CODEX_WS_REJECTED_CONNECTIONS" "$CODEX_WS_GENERATE_FALSE_REJECTIONS" \
    "$CODEX_WS_UPSTREAM_ATTEMPTS" >&2
  exit 1
fi
CODEX_WS_GENERATE_FALSE_SUMMARY=''
if [[ "$CODEX_WS_GENERATE_FALSE_REJECTIONS" -gt 0 ]]; then
  CODEX_WS_GENERATE_FALSE_SUMMARY=" generate_false_local_rejections=$CODEX_WS_GENERATE_FALSE_REJECTIONS generate_false_upstream_attempts=0"
fi

CODEX_SMOKE_SUCCESS=1
CODEX_SMOKE_PHASE=cleanup
