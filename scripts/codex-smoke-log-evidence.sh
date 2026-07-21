#!/usr/bin/env bash

# Print three counts for completed Codex model-catalog requests in a proxy log:
# successful responses for the expected validated client version, non-2xx
# responses for any validated client version, and all completed responses.
codex_catalog_response_counts() {
  local log_file=$1
  local expected_client_version=$2

  awk -v expected_client_version="$expected_client_version" '
    {
      line = $0
      gsub(/\033\[[0-9;]*m/, "", line)
      sub(/^[[:space:]]+/, "", line)
      sub(/^ℹ[[:space:]]+/, "", line)

      marker = "Codex model catalog response: client_version="
      if (index(line, marker) != 1)
        next

      response = substr(line, length(marker) + 1)
      separator = index(response, " status=")
      if (separator == 0)
        next

      client_version = substr(response, 1, separator - 1)
      response = substr(response, separator + length(" status="))
      if (response !~ /^[0-9][0-9][0-9]([[:space:]]|$)/)
        next

      status = substr(response, 1, 3)
      completed += 1
      if (status != "200") {
        non_success += 1
        next
      }

      if (client_version == expected_client_version \
        || index(client_version, expected_client_version "&") == 1)
        expected_success += 1
    }
    END {
      printf "%d %d %d\n", expected_success + 0, non_success + 0, completed + 0
    }
  ' "$log_file"
}

# Validate response-completion evidence from one real Codex invocation. A
# request-start line is insufficient because Codex can fall back to its bundled
# catalog after the proxy returns an error and still complete the turn.
require_codex_catalog_success() {
  local log_file=$1
  local expected_client_version=$2
  local transport_label=$3
  local counts
  local expected_success
  local non_success
  local completed

  counts="$(codex_catalog_response_counts "$log_file" "$expected_client_version")" || return $?
  read -r expected_success non_success completed <<<"$counts"

  if [[ "$expected_success" -lt 1 || "$non_success" -ne 0 ]]; then
    printf 'Invalid %s Codex catalog response evidence: expected_version=%s expected_200=%s non_2xx=%s completed=%s\n' \
      "$transport_label" "$expected_client_version" "$expected_success" \
      "$non_success" "$completed" >&2
    return 1
  fi

  printf '%s\n' "$expected_success"
}
