# Security Policy

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/Jer-y/copilot-proxy/security/advisories/new), not a public issue. Include the affected version, reproduction, impact, and suggested mitigation, without real tokens, prompts, or model output. Expect an initial acknowledgement within seven days.

## Security model

copilot-proxy serves one trusted operator on loopback and has no downstream user authentication. Remote access requires an [authenticated private gateway](docs/deployment.md#authenticated-private-gateway); exposing the listener directly exposes the operator's subscription.

Request Hosts and browser Origins are allowlisted separately and rejected before route execution when disallowed. JSON bodies require the appropriate Content-Type. These checks do not authenticate downstream users.

Per-request terminal approval has been removed: there is no interactive approval step before forwarding. `--manual` and enabled legacy settings are rejected. Follow the [upgrade checklist](docs/operations.md#upgrade-changes-after-v0100) before removing a safety setting.

Plaintext token diagnostics are retired. Use `doctor` or `/diagnostics`, not `/token` or `--show-token`; see [route behavior](docs/api-reference.md#routes) and [retired settings](docs/operations.md#upgrade-changes-after-v0100). `/usage` returns a minimal quota summary, not the full upstream user payload.

## Diagnostics privacy

The hosted Dashboard is a remote GitHub Pages origin. Opening it sends the complete `endpoint` query value to that site; the URL may persist in browser history or infrastructure logs. Its JavaScript is also trusted with the diagnostics response it fetches.

Never put credentials in the URL. If endpoint names or diagnostics must remain local, use `doctor`, `curl`, or a self-hosted copy. See [Dashboard operation](docs/operations.md#diagnostics-and-dashboard).

Treat authenticated proxy URLs and persisted proxy/TLS settings as credentials. Before sharing logs, setup output, `debug --json`, diagnostics, or bug reports, remove tokens, keys, prompts, tool/model content, proxy credentials, internal endpoints, usernames, and local paths. Automatic redaction of known fields does not make every output safe to publish.

## Supported versions

Security fixes target the latest release line. Upgrade to the newest published version before reporting an issue that may already be fixed.
