#!/usr/bin/env bash

set -euo pipefail
umask 077

: "${COPILOT_LIVE_ITEM_ID_REPLAY:?set COPILOT_LIVE_ITEM_ID_REPLAY=1 to run the real stateless replay gate}"
: "${COPILOT_LIVE_RESPONSES_MODEL:?set COPILOT_LIVE_RESPONSES_MODEL to the current Responses model}"
: "${COPILOT_ACCOUNT_TYPE:?set COPILOT_ACCOUNT_TYPE to individual, business, or enterprise}"

if [[ "$COPILOT_LIVE_ITEM_ID_REPLAY" != "1" ]]; then
  echo "COPILOT_LIVE_ITEM_ID_REPLAY must be 1." >&2
  exit 1
fi

case "$COPILOT_ACCOUNT_TYPE" in
  individual | business | enterprise) ;;
  *)
    echo "COPILOT_ACCOUNT_TYPE must be individual, business, or enterprise." >&2
    exit 1
    ;;
esac

ITEM_REPLAY_PORT="${COPILOT_LIVE_ITEM_ID_REPLAY_PORT:-4903}"
ITEM_REPLAY_TIMEOUT_SECONDS="${COPILOT_LIVE_ITEM_ID_REPLAY_TIMEOUT_SECONDS:-180}"

if ! [[ "$ITEM_REPLAY_PORT" =~ ^[0-9]+$ ]] \
  || ((ITEM_REPLAY_PORT < 1 || ITEM_REPLAY_PORT > 65535)); then
  echo "COPILOT_LIVE_ITEM_ID_REPLAY_PORT must be an integer from 1 through 65535." >&2
  exit 1
fi
if ! [[ "$ITEM_REPLAY_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] \
  || ((ITEM_REPLAY_TIMEOUT_SECONDS < 10 || ITEM_REPLAY_TIMEOUT_SECONDS > 1800)); then
  echo "COPILOT_LIVE_ITEM_ID_REPLAY_TIMEOUT_SECONDS must be an integer from 10 through 1800." >&2
  exit 1
fi

for command_name in bun cmp curl git lsof rg; do
  command -v "$command_name" >/dev/null
done

mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
ITEM_REPLAY_ROOT="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/responses-item-replay.XXXXXX")"
ITEM_REPLAY_PROXY_LOG="$ITEM_REPLAY_ROOT/proxy.log"
ITEM_REPLAY_INSTANCE_TOKEN="item-replay-$$-$(date +%s)"
ITEM_REPLAY_PHASE=preflight
ITEM_REPLAY_SUCCESS=0

capture_worktree_snapshot() {
  local output_path=$1
  bun run --silent ./scripts/capture-worktree-snapshot.ts >"$output_path"
}

cleanup_item_replay() {
  local exit_status=$?
  trap - EXIT INT TERM

  if [[ -n "${ITEM_REPLAY_PROXY_PID:-}" ]] \
    && kill -0 "$ITEM_REPLAY_PROXY_PID" 2>/dev/null; then
    kill "$ITEM_REPLAY_PROXY_PID" 2>/dev/null || true
    for _ in {1..40}; do
      if ! kill -0 "$ITEM_REPLAY_PROXY_PID" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$ITEM_REPLAY_PROXY_PID" 2>/dev/null; then
      kill -KILL "$ITEM_REPLAY_PROXY_PID" 2>/dev/null || true
    fi
    wait "$ITEM_REPLAY_PROXY_PID" 2>/dev/null || true
  fi

  if lsof -nP -iTCP:"$ITEM_REPLAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $ITEM_REPLAY_PORT is still listening after item replay cleanup." >&2
    exit_status=1
  fi

  if ! git status --porcelain=v1 -z >"$ITEM_REPLAY_ROOT/git-status.after" \
    || ! capture_worktree_snapshot "$ITEM_REPLAY_ROOT/worktree.after"; then
    echo "Failed to inspect the repository after the item replay gate." >&2
    exit_status=1
  elif [[ ! -f "$ITEM_REPLAY_ROOT/git-status.before" ]] \
    || ! cmp -s "$ITEM_REPLAY_ROOT/git-status.before" "$ITEM_REPLAY_ROOT/git-status.after" \
    || [[ ! -f "$ITEM_REPLAY_ROOT/worktree.before" ]] \
    || ! cmp -s "$ITEM_REPLAY_ROOT/worktree.before" "$ITEM_REPLAY_ROOT/worktree.after"; then
    echo "The item replay gate changed the repository worktree." >&2
    exit_status=1
  fi

  if ! rm -rf "$ITEM_REPLAY_ROOT" || [[ -e "$ITEM_REPLAY_ROOT" ]]; then
    echo "Failed to remove the item replay temporary directory." >&2
    exit_status=1
  fi

  if [[ "$exit_status" -eq 0 && "$ITEM_REPLAY_SUCCESS" -eq 1 ]]; then
    printf 'responses_item_id_stateless_replay=passed date_utc=%s git_sha=%s dirty=%s model=%s account_type=%s terminal_driven=true sensitive_payloads_in_memory=true cleanup=passed\n' \
      "$ITEM_REPLAY_DATE_UTC" "$ITEM_REPLAY_GIT_SHA" "$ITEM_REPLAY_DIRTY" \
      "$COPILOT_LIVE_RESPONSES_MODEL" "$COPILOT_ACCOUNT_TYPE"
  elif [[ "$exit_status" -ne 0 ]]; then
    printf 'responses_item_id_stateless_replay=failed phase=%s\n' "$ITEM_REPLAY_PHASE" >&2
  fi
  exit "$exit_status"
}
trap cleanup_item_replay EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git status --porcelain=v1 -z >"$ITEM_REPLAY_ROOT/git-status.before"
capture_worktree_snapshot "$ITEM_REPLAY_ROOT/worktree.before"
ITEM_REPLAY_DATE_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ITEM_REPLAY_GIT_SHA="$(git rev-parse --verify HEAD)"
ITEM_REPLAY_DIRTY=false
if [[ -s "$ITEM_REPLAY_ROOT/git-status.before" ]]; then
  ITEM_REPLAY_DIRTY=true
fi

if lsof -nP -iTCP:"$ITEM_REPLAY_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $ITEM_REPLAY_PORT already has a listener; choose another item replay port." >&2
  exit 1
fi

NO_COLOR=1 FORCE_COLOR=0 bun run ./src/main.ts start \
  --host 127.0.0.1 \
  --port "$ITEM_REPLAY_PORT" \
  --account-type "$COPILOT_ACCOUNT_TYPE" \
  --_instance-token "$ITEM_REPLAY_INSTANCE_TOKEN" \
  >"$ITEM_REPLAY_PROXY_LOG" 2>&1 &
ITEM_REPLAY_PROXY_PID=$!

ITEM_REPLAY_READY=0
for _ in {1..120}; do
  if ! kill -0 "$ITEM_REPLAY_PROXY_PID" 2>/dev/null; then
    break
  fi
  if curl -fsS --noproxy '*' --max-time 1 -D "$ITEM_REPLAY_ROOT/readiness.headers" \
    -o /dev/null "http://127.0.0.1:$ITEM_REPLAY_PORT/" 2>/dev/null \
    && rg -i -Fq "x-copilot-proxy-instance-token: $ITEM_REPLAY_INSTANCE_TOKEN" \
      "$ITEM_REPLAY_ROOT/readiness.headers"; then
    ITEM_REPLAY_READY=1
    break
  fi
  sleep 0.25
done
if [[ "$ITEM_REPLAY_READY" -ne 1 ]]; then
  echo "The disposable proxy did not become ready for the item replay gate." >&2
  exit 1
fi

ITEM_REPLAY_PHASE=client
ITEM_REPLAY_BASE_URL="http://127.0.0.1:$ITEM_REPLAY_PORT" \
ITEM_REPLAY_TIMEOUT_MS="$((ITEM_REPLAY_TIMEOUT_SECONDS * 1000))" \
COPILOT_LIVE_RESPONSES_MODEL="$COPILOT_LIVE_RESPONSES_MODEL" \
NO_PROXY='127.0.0.1,localhost' \
no_proxy='127.0.0.1,localhost' \
  bun run ./scripts/responses-item-replay-client.ts

ITEM_REPLAY_SUCCESS=1
ITEM_REPLAY_PHASE=cleanup
