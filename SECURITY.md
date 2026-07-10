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
loopback, same-origin access when enabled.

`--manual` is an interactive foreground safeguard. Requests fail closed if a
TTY is unavailable or approval times out. Do not enable verbose or token
logging when logs are persisted or shared: prompts, tool data, model output,
and bearer tokens can contain secrets.

## Supported versions

Security fixes are made on the latest release line. Users should upgrade to
the newest published version before reporting an issue that may already have
been fixed.
