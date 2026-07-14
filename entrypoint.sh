#!/bin/sh
set -eu

health_port_file=${COPILOT_PROXY_HEALTH_PORT_FILE:-/tmp/copilot-proxy-health-port}

if [ "${1:-}" = "--healthcheck" ]; then
  # Docker healthcheck processes inherit the container's configured
  # environment, so scrub credential aliases before invoking wget too.
  unset GH_TOKEN GITHUB_TOKEN
  IFS= read -r health_port < "$health_port_file"
  case "$health_port" in
    ''|*[!0-9]*)
      exit 1
      ;;
  esac
  if [ "$health_port" -lt 1 ] || [ "$health_port" -gt 65535 ]; then
    exit 1
  fi
  exec wget --spider -q "http://127.0.0.1:${health_port}/"
fi

# Record the same public --port syntax accepted by the CLI. The healthcheck is
# a separate process and cannot observe shell variables changed by PID 1.
health_port=$(/resolve-container-port.sh "$@")
umask 077
health_port_tmp="${health_port_file}.$$"
printf '%s\n' "$health_port" > "$health_port_tmp"
mv "$health_port_tmp" "$health_port_file"

# Convert an environment-provided GitHub token into the existing owner-only
# credential file before exec. This keeps the secret out of both argv and the
# long-running PID 1 environment (`/proc/1/environ`).
github_token=${GH_TOKEN:-${GITHUB_TOKEN:-}}
if [ -n "$github_token" ]; then
  data_home=${XDG_DATA_HOME:-"${HOME}/.local/share"}
  token_dir=${COPILOT_PROXY_DATA_DIR:-"$data_home/copilot-proxy"}
  mkdir -p "$token_dir"
  printf '%s' "$github_token" > "$token_dir/github_token"
  chmod 600 "$token_dir/github_token"
fi
unset github_token data_home token_dir health_port health_port_file health_port_tmp GH_TOKEN GITHUB_TOKEN

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
