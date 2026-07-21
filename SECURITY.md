# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting feature for this repository instead:

<https://github.com/Jer-y/copilot-proxy/security/advisories/new>

Include the affected version, reproduction steps, impact, and any suggested
mitigation. Please avoid including real GitHub or Copilot tokens, prompts, or
model output in the report. You can expect an initial acknowledgement within
seven days.

## Security model

copilot-proxy is a personal, local proxy by default. It listens on loopback and
does not provide multi-user API authentication. Binding it to a LAN or public
interface exposes the user's Copilot subscription to every client that can
reach it; place an authenticated gateway in front of it if remote access is
required.

Browser Origins and request Hosts are allowlisted separately. Cross-origin
requests are rejected before route execution, and JSON routes require a JSON
Content-Type. The `/token` endpoint is disabled unless
`COPILOT_PROXY_EXPOSE_TOKEN=1` is explicitly set, and remains restricted to
loopback, same-origin access when enabled. That environment variable may be
persisted in native-service state, so remove it from the service environment
rather than assuming the exposure ends with the current shell. `/usage`
returns a minimal quota summary rather than the full upstream Copilot user
payload.

The hosted diagnostics dashboard is a separate GitHub Pages origin. Opening a
dashboard URL sends its complete `endpoint` query parameter to that remote
site, can retain the URL in browser or infrastructure history, and trusts the
page's JavaScript with the diagnostics response it fetches. Never put URL
credentials or other secrets in the endpoint. Use local `doctor`, `curl`, or a
locally hosted dashboard when the endpoint hostname or diagnostics data must
remain inside the local trust boundary.

`--manual` is an interactive foreground safeguard. Requests fail closed if a
TTY is unavailable or approval times out. Do not enable verbose or token
logging when logs are persisted or shared: prompts, tool data, model output,
and bearer tokens can contain secrets.

Treat authenticated HTTP proxy URLs and persisted proxy/TLS service state as
credentials. Before sharing setup output, logs, `debug --json`, diagnostics
snapshots, shell commands, or bug reports, remove tokens, API keys, proxy
credentials, internal endpoints, usernames, and local filesystem paths. Local
diagnostic output is not automatically safe to publish merely because known
token fields are redacted.

Deployment details are in [Deployment](docs/deployment.md), and operational
diagnostics boundaries are in [Operations](docs/operations.md).

## Supported versions

Security fixes are made on the latest release line. Users should upgrade to
the newest published version before reporting an issue that may already have
been fixed.
