#!/bin/sh
set -eu

# Convert an environment-provided GitHub token into the existing owner-only
# credential file before exec. This keeps the secret out of both argv and the
# long-running PID 1 environment (`/proc/1/environ`).
github_token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
if [ -n "$github_token" ]; then
  data_home=${XDG_DATA_HOME:-"${HOME}/.local/share"}
  token_dir=${COPILOT_PROXY_DATA_DIR:-"$data_home/copilot-proxy"}
  umask 077
  mkdir -p "$token_dir"
  printf '%s' "$github_token" > "$token_dir/github_token"
  chmod 600 "$token_dir/github_token"
fi
unset github_token data_home token_dir GH_TOKEN GITHUB_TOKEN

case "${1:-}" in
  --auth)
    exec bun run dist/main.js auth
    ;;
  start)
    shift
    exec bun run dist/main.js start "$@"
    ;;
  auth|check-usage|debug|stop|restart|status|logs|enable|disable)
    exec bun run dist/main.js "$@"
    ;;
  *)
    exec bun run dist/main.js start "$@"
    ;;
esac
