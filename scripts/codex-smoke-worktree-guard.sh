#!/usr/bin/env bash

# Shared by the real Codex smoke and its regression tests. Keep this file
# sourceable: the smoke installs its EXIT trap and owns the final exit status.

capture_codex_smoke_worktree_state() {
  if [[ "$#" -ne 4 ]]; then
    echo "capture_codex_smoke_worktree_state requires repository, snapshot helper, status output, and snapshot output paths." >&2
    return 2
  fi

  local repository_root=$1
  local snapshot_helper=$2
  local status_output=$3
  local snapshot_output=$4

  if ! git -C "$repository_root" status --porcelain=v1 -z >"$status_output"; then
    return 1
  fi
  if ! (
    cd -- "$repository_root"
    bun run --silent "$snapshot_helper"
  ) >"$snapshot_output"; then
    return 1
  fi
}

verify_codex_smoke_worktree_unchanged() {
  if [[ "$#" -ne 6 ]]; then
    echo "verify_codex_smoke_worktree_unchanged requires repository, snapshot helper, before status, before snapshot, after status, and after snapshot paths." >&2
    return 2
  fi

  local repository_root=$1
  local snapshot_helper=$2
  local status_before=$3
  local snapshot_before=$4
  local status_after=$5
  local snapshot_after=$6

  if ! capture_codex_smoke_worktree_state \
    "$repository_root" "$snapshot_helper" "$status_after" "$snapshot_after"; then
    echo "Failed to inspect the repository after the Codex smoke with a content-sensitive snapshot." >&2
    return 1
  fi

  if [[ ! -f "$status_before" ]] \
    || ! cmp -s "$status_before" "$status_after" \
    || [[ ! -f "$snapshot_before" ]] \
    || ! cmp -s "$snapshot_before" "$snapshot_after"; then
    echo "The Codex smoke changed the repository worktree (status, tracked content or metadata, or non-ignored untracked content or metadata differs)." >&2
    return 1
  fi
}
