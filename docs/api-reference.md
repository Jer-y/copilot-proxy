English | [简体中文](api-reference.zh-CN.md)

# API and configuration reference

The OpenAI-compatible API base URL is `http://127.0.0.1:4399/v1`, and the Anthropic API base URL is `http://127.0.0.1:4399`.

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
| `/token` | `GET` | Retired; returns 410 after global security checks, without reading or returning credentials |

OpenAI routes also accept the corresponding unprefixed path. Anthropic Messages remains under `/v1/messages`.

Availability is model- and upstream-dependent. See [Protocol compatibility](protocol-compatibility.md) and run the relevant [capability validation](copilot-capability-validation.md) before claiming support for an upstream-gated route.

### Claude Code document boundary

Claude setup selects a native `/v1/messages` model. Document behavior is endpoint-specific:

- Local text/Markdown becomes ordinary text or `tool_result` blocks in Claude Code.
- PDF forwarding requires a client-emitted base64 `application/pdf` document block; Claude Code may instead render pages as base64 images.
- Generation rejects `document.source` forms using `text`, `content`, `url`, `file`, or non-PDF base64 media with `400 invalid_request_error`; there is no generic document adaptation.
- `/v1/messages/count_tokens` does not apply generation-only sanitization or document gates. Successful URL/`file_id` counting proves request acceptance, not resource retrieval, file existence/readability, or generation support.
- Anthropic Files, Message Batches, Skills, and Managed Agents control planes are not exposed.

### Account selection

In multi-account mode, generation routes accept `x-copilot-account: <id>`; model-bearing requests also accept `<account-id>/<model-id>`. Conflicts return `409`; an unavailable account returns `503` without failover. `/usage?account=<id>` and `/readyz?account=<id>` inspect one account. Full precedence and connection pinning are in [Operations](operations.md#multiple-copilot-accounts).

### Recovery backoff

When authentication recovery opens a scoped or global circuit, protected upstream routes fail locally with `503`, `Retry-After`, error code `copilot_upstream_circuit_open`, and `X-Copilot-Proxy-Recovery-State`. While the global circuit is open, `/readyz` also returns `503` with `Retry-After`. Clients and gateways should honor that delay instead of starting their own restart or retry loop.

## Security and request controls

| Setting | Purpose |
| --- | --- |
| `COPILOT_PROXY_ALLOWED_HOSTS` | Exact non-loopback Host allowlist |
| `COPILOT_PROXY_CORS_ORIGINS` | Additional exact browser origins |
| `COPILOT_PROXY_MAX_JSON_BODY_BYTES` | Positive JSON request-body limit; default 32 MiB |
| `COPILOT_PROXY_EXPOSE_TOKEN` | Retired and ignored; old enabled values warn and are no longer saved or restored |
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

`--github-token` is the legacy single-account bootstrap and is rejected with `accounts.json`; use `--token-stdin` for multi-account imports without secrets in argv. Follow [Security](../SECURITY.md) before sharing CLI output.

Use `accounts concurrency set|clear` for optional account-specific limits and `accounts required-route set|remove|list` for startup/readiness capability gates. These writes use the same account transaction and rollback boundary described in [Operations](operations.md#multiple-copilot-accounts).

See [Operations](operations.md) for presets, diagnostics, proxy handling, and service lifecycle.
