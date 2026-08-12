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

In multi-account mode, generation routes accept `x-copilot-account: <id>`. Model-bearing requests may instead use `<account-id>/<model-id>`. Conflicting selectors return `409`; an unavailable selected account returns `503` without failover. `/usage?account=<id>` and `/readyz?account=<id>` inspect one account.

When authentication recovery opens a scoped or global circuit, protected upstream routes fail locally with `503`, `Retry-After`, error code `copilot_upstream_circuit_open`, and `X-Copilot-Proxy-Recovery-State`. While the global circuit is open, `/readyz` also returns `503` with `Retry-After`. Clients and gateways should honor that delay instead of starting their own restart or retry loop.

## Security and request controls

| Setting | Purpose |
| --- | --- |
| `COPILOT_PROXY_ALLOWED_HOSTS` | Exact non-loopback Host allowlist |
| `COPILOT_PROXY_CORS_ORIGINS` | Additional exact browser origins |
| `COPILOT_PROXY_MAX_JSON_BODY_BYTES` | Positive JSON request-body limit; default 32 MiB |
| `COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH=1` | Enables translated document URL fetching; private, loopback, metadata, reserved, and redirect targets remain blocked |
| `COPILOT_PROXY_EXPOSE_TOKEN=1` | Enables `/token` under its loopback and same-origin restrictions until the variable is removed; a native-service environment can persist it across restarts |
| `COPILOT_PROXY_EXPOSE_ACCOUNT_IDENTITY=1` | Includes GitHub login and numeric user ID in account health data; disabled by default |
| `COPILOT_PROXY_EXPOSE_ACCOUNT_MODELS=1` | Adds `<account>/<model>` aliases to non-Codex `/models` responses |

Requests with JSON bodies require `application/json` or `application/*+json`.

## CLI truth source

Use the CLI help instead of duplicating every option in documentation:

```sh
copilot-proxy --help
copilot-proxy <command> --help
```

Useful non-interactive and timeout controls include:

```sh
printf '%s\n' "$TOKEN" | copilot-proxy accounts auth <id> --token-stdin --yes
copilot-proxy start --headers-timeout-ms <ms> --body-timeout-ms <ms> --connect-timeout-ms <ms>
```

`--github-token` remains the legacy single-account bootstrap and is rejected when `accounts.json` exists. `--token-stdin` is the safe multi-account path because it does not place the token in argv. Never place real tokens in shared shell history or logs, and redact local paths, usernames, internal endpoints, and authenticated proxy URLs before sharing CLI output.

Use `accounts concurrency set|clear` for optional account-specific limits and `accounts required-route set|remove|list` for startup/readiness capability gates. These writes use the same account transaction and rollback boundary described in [Operations](operations.md#multiple-copilot-accounts).

See [Operations](operations.md) for presets, diagnostics, proxy handling, and service lifecycle.
