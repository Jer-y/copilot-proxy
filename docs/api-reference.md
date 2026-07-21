English | [简体中文](api-reference.zh-CN.md)

# API and configuration reference

Use `http://127.0.0.1:4399/v1` as the OpenAI-compatible base URL and `http://127.0.0.1:4399` as the Anthropic base URL.

## Routes

| Route | Method | Notes |
| --- | --- | --- |
| `/v1/chat/completions` | `POST` | OpenAI Chat Completions |
| `/v1/models` | `GET` | Compact OpenAI model list; `client_version` requests the Codex catalog shape |
| `/v1/embeddings` | `POST` | OpenAI embeddings |
| `/v1/responses` | `POST` | OpenAI Responses over HTTP or SSE |
| `/v1/responses` | `GET` Upgrade | Native Responses WebSocket for explicitly eligible models |
| `/v1/responses/input_tokens` | `POST` | Upstream-gated Responses helper |
| `/v1/responses/compact` | `POST` | Upstream-gated Responses compaction |
| `/v1/responses/:id` | `GET`, `DELETE` | Upstream-gated stored-response operations |
| `/v1/responses/:id/cancel` | `POST` | Upstream-gated cancellation |
| `/v1/responses/:id/input_items` | `GET` | Upstream-gated input items |
| `/v1/messages` | `POST` | Anthropic Messages |
| `/v1/messages/count_tokens` | `POST` | Anthropic token counting |
| `/livez`, `/readyz` | `GET` | Liveness and readiness |
| `/diagnostics` | `GET` | Runtime, model-route, and usage summary |
| `/usage` | `GET` | Minimal Copilot quota summary; does not expose the full upstream user payload |
| `/token` | `GET` | Disabled-by-default local token diagnostic |

OpenAI routes also accept the corresponding unprefixed path. Anthropic Messages remains under `/v1/messages`.

Availability is model- and upstream-dependent. See [Protocol compatibility](protocol-compatibility.md) and run the relevant [capability validation](copilot-capability-validation.md) before claiming support for an upstream-gated route.

When authentication recovery opens a scoped or global circuit, protected upstream routes fail locally with `503`, `Retry-After`, error code `copilot_upstream_circuit_open`, and `X-Copilot-Proxy-Recovery-State`. While the global circuit is open, `/readyz` also returns `503` with `Retry-After`. Clients and gateways should honor that delay instead of starting their own restart or retry loop.

## Security and request controls

| Setting | Purpose |
| --- | --- |
| `COPILOT_PROXY_ALLOWED_HOSTS` | Exact non-loopback Host allowlist |
| `COPILOT_PROXY_CORS_ORIGINS` | Additional exact browser origins |
| `COPILOT_PROXY_MAX_JSON_BODY_BYTES` | Positive JSON request-body limit; default 32 MiB |
| `COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH=1` | Enables translated document URL fetching; private, loopback, metadata, reserved, and redirect targets remain blocked |
| `COPILOT_PROXY_EXPOSE_TOKEN=1` | Enables `/token` under its loopback and same-origin restrictions until the variable is removed; a native-service environment can persist it across restarts |

Requests with JSON bodies require `application/json` or `application/*+json`.

## CLI truth source

Use the CLI help instead of duplicating every option in documentation:

```sh
copilot-proxy --help
copilot-proxy <command> --help
```

Useful non-interactive and timeout controls include:

```sh
copilot-proxy auth --github-token <token>
copilot-proxy start --headers-timeout-ms <ms> --body-timeout-ms <ms> --connect-timeout-ms <ms>
```

`--github-token` persists the token and exits so a long-running launcher does not retain it in process arguments. Never place real tokens in shared shell history or logs, and redact local paths, usernames, internal endpoints, and authenticated proxy URLs before sharing CLI output.

See [Operations](operations.md) for presets, diagnostics, proxy handling, and service lifecycle.
