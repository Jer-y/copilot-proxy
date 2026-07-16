English | [简体中文](README.zh-CN.md)

# Copilot API Proxy

Turn a GitHub Copilot subscription into a local OpenAI- and Anthropic-compatible API for Claude Code, Codex, SDKs, and custom tools.

> [!WARNING]
> This is a reverse-engineered proxy. It is not supported by GitHub and may break without notice. Excessive automated, rapid, or bulk use can trigger GitHub abuse detection and may temporarily suspend Copilot access. Review the [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github) and [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot), and use the proxy responsibly.

> [!NOTE]
> You may not need this project if you use [opencode](https://github.com/sst/opencode), which has a native GitHub Copilot provider. GitHub also offers first-party Claude experiences in some products; see [Anthropic Claude](https://docs.github.com/en/copilot/concepts/agents/anthropic-claude) and [BYOK models in Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models). This proxy is for clients that specifically need a local OpenAI/Anthropic-compatible API, including native Responses WebSocket mode, backed by Copilot.

[Quick start](#quick-start) · [Capabilities](#capability-map) · [API](#api-surface) · [Deployment](#deployment) · [CLI](#cli-and-operations) · [Clients](#client-integrations) · [Development](#development-and-live-validation)

## Quick start

You need a GitHub account with an individual, business, or enterprise Copilot subscription, plus one of:

- Node.js >= 22.19.0 for npm, npx, pnpm, Yarn, Volta, or a global CLI install
- Bun >= 1.3.6 for source development or `bunx --bun`

Start without installing:

```sh
npx @jer-y/copilot-proxy@latest start
```

The first run starts GitHub authentication when needed, then listens on `http://127.0.0.1:4399`. Use `http://127.0.0.1:4399/v1` as the OpenAI-compatible base URL or `http://127.0.0.1:4399` as the Anthropic base URL. Query `GET /v1/models` before choosing a model because upstream availability and supported APIs can change.

<details>
<summary>Other installation methods</summary>

Global installation:

```sh
# npm
npm i -g @jer-y/copilot-proxy

# pnpm
pnpm add -g @jer-y/copilot-proxy

# Yarn Classic
yarn global add @jer-y/copilot-proxy

# Volta
volta install @jer-y/copilot-proxy

copilot-proxy start
```

Other one-off runners:

```sh
pnpm dlx @jer-y/copilot-proxy@latest start
yarn dlx @jer-y/copilot-proxy@latest start
bunx --bun @jer-y/copilot-proxy@latest start
```

`yarn dlx` requires modern Yarn. The published global bin uses a Node.js shebang, so a Bun-only machine should use `bunx --bun` instead of `bun add -g`.

From a source checkout:

```sh
bun install --frozen-lockfile
bun run dev       # watch mode
bun run start     # production mode
```

</details>

## Capability map

| Area | Behavior |
| --- | --- |
| OpenAI-compatible HTTP | Chat Completions, Models, Embeddings, and Responses endpoints, including SSE streaming |
| Anthropic-compatible HTTP | Messages and token counting; Claude uses native Copilot `/v1/messages` when available |
| Responses WebSocket | One-to-one native Copilot bridge on Bun and Node.js, enabled only when live model metadata explicitly advertises `ws:/responses` |
| Routing and translation | Direct routing when the model supports the requested API; only Messages and Responses may translate to each other. Chat Completions is never used as a translation fallback |
| Claude compatibility | Prompt caching via `copilot_cache_control`, adaptive thinking / `output_config.effort`, provider-specific model normalization, and Claude Code setup |
| Reliability controls | Optional rate limiting, bounded identity-wide concurrency and queueing, longer upstream timeouts, Anthropic SSE keepalive pings, and fail-closed manual approval |
| Authentication recovery | One single-flight short-lived token refresh and one guarded replay for eligible `401` or correlation-ID-bearing plain-text `403 Forbidden`; persistent rejection opens a cooldown circuit |
| Operations | Usage dashboard, individual/business/enterprise routing, native system services on Linux/macOS/Windows, and legacy `start -d` daemon compatibility |

Support is model-aware and comes from current Copilot metadata. Ordinary Responses support does not imply Responses WebSocket support, and a successful parser response does not by itself prove semantic feature support.

## API surface

OpenAI-compatible routes accept both the listed `/v1/...` form and the corresponding unprefixed path. Anthropic Messages is available only under `/v1/messages`; auxiliary routes are unprefixed.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/v1/chat/completions` | `POST` | OpenAI-compatible chat response |
| `/v1/models` | `GET` | Current models and model-specific API metadata |
| `/v1/embeddings` | `POST` | OpenAI-compatible embedding vector |
| `/v1/responses` | `POST` | [Responses API](https://platform.openai.com/docs/api-reference/responses) over HTTP, including SSE streaming |
| `/v1/responses` | `GET` + Upgrade | Native Responses WebSocket; first turn must select a model that explicitly supports it |
| `/v1/messages` | `POST` | Anthropic-compatible Messages response |
| `/v1/messages/count_tokens` | `POST` | Anthropic-compatible token count |
| `/usage` | `GET` | Copilot usage and quota data |
| `/token` | `GET` | Short-lived local diagnostics only; disabled unless `COPILOT_PROXY_EXPOSE_TOKEN=1` |
| `/livez` | `GET` | Process liveness only; does not claim upstream availability |
| `/readyz` | `GET` | Passive, non-secret token/recovery/model-cache/concurrency readiness; returns `503` while the global recovery circuit is not closed |

<details>
<summary>Responses WebSocket contract and boundaries</summary>

HTTP Responses requests are forwarded directly when the selected model exposes Copilot's Responses backend. A Claude model may use the HTTP route only when the request can be faithfully translated to Anthropic Messages. WebSocket turns are direct-only: the first `response.create` must select a live model with explicit `ws:/responses` metadata, after which one downstream connection maps to one Copilot `wss://.../responses` connection. Claude translation, Chat Completions, and the Realtime API are never presented as WebSocket support.

The transport follows the [official Responses WebSocket contract](https://developers.openai.com/api/docs/guides/websocket-mode): one response may be in flight per connection, additional turns run FIFO without multiplexing, and a connection lasts at most 60 minutes. Streaming is implicit; `stream: false` and malformed values are rejected, while `stream: true` or `null` are stripped as compatible no-ops. `background` is unsupported. With `store: false`, reconnecting loses connection-local `previous_response_id` state, so a new chain must resend its required context unless persisted state is deliberately available.

Input memory is bounded independently from upstream concurrency: 16 MiB per text frame, 8 queued turns or 32 MiB per connection, and 64 MiB globally across queued plus setup-stage request frames. Overflow is rejected locally with `429` without forwarding the rejected turn to Copilot.

OpenAI defines `generate: false` as a no-output warmup. In the dated 2026-07-15 Copilot probe, a request without `input` returned `bad_request`, while one with `input` generated output. Until a fresh probe shows faithful support, the proxy rejects it locally with `400 unsupported_value` and `param: "generate"` before opening upstream.

</details>

### Responses-to-Claude and Codex-to-Claude limitations

<details>
<summary>Compatibility details</summary>

A Responses request translated to native Claude Messages must explicitly set `store: false`; the proxy cannot emulate the Responses default server-side persistence or make a translated response ID retrievable. Initial system/developer input becomes the top-level Anthropic system prompt. Mid-conversation instructions are preserved only in Anthropic-supported positions; an ordering that would require semantic reordering is rejected.

With Codex CLI 0.144.1, the tested default configuration included hosted/custom Responses tools that Anthropic Messages could not represent faithfully. The proxy intentionally returned HTTP `400` instead of silently dropping tools. A restricted real-machine smoke passed text and `exec_command` tool-loop coverage only with these overrides, so it does not prove default Codex-to-Claude compatibility:

```sh
-c 'web_search="disabled"' \
-c 'features.multi_agent=false' \
-c 'features.remote_plugin=false'
```

See [Copilot capability validation](docs/copilot-capability-validation.md) for the dated upstream evidence and client-smoke requirements.

</details>

## Deployment

### Docker

Build and run with a named volume so authentication survives restarts without entering the source or build context:

```sh
docker build -t copilot-proxy .
docker volume create copilot-proxy-data
docker run \
  -p 127.0.0.1:4399:4399 \
  -v copilot-proxy-data:/home/bun/.local/share/copilot-proxy \
  copilot-proxy start --host 0.0.0.0
```

The image uses a multi-stage build, a non-root user, a health check, and a base image pinned by version and digest.

<details>
<summary>Environment-file and Docker Compose examples</summary>

Store `GH_TOKEN` in a mode-`0600` env file outside this repository, then pass it at runtime:

```sh
docker run \
  -p 127.0.0.1:4399:4399 \
  --env-file "$HOME/.config/copilot-proxy/container.env" \
  copilot-proxy start --host 0.0.0.0
```

Compose example:

```yaml
services:
  copilot-proxy:
    build: .
    command: start --host 0.0.0.0
    ports:
      - '127.0.0.1:4399:4399'
    environment:
      GH_TOKEN: ${GH_TOKEN:?set GH_TOKEN in an ignored .env file}
      COPILOT_PROXY_ALLOWED_HOSTS: copilot-proxy
    volumes:
      - copilot-proxy-data:/home/bun/.local/share/copilot-proxy
    restart: unless-stopped
volumes:
  copilot-proxy-data:
```

</details>

### New API gateway

[New API](https://github.com/QuantumNous/new-api) can provide shared users, API keys, quotas, model permissions, logs, rate limits, billing, and load balancing while copilot-proxy remains the private Copilot-authenticated upstream:

```text
Clients / SDKs / Claude Code / Codex
        | New API key, quota, logging, billing
        v
New API gateway                         public/team-facing
        | private upstream channel
        v
copilot-proxy                           private
        | GitHub Copilot authentication
        v
GitHub Copilot upstream
```

1. Deploy and authenticate copilot-proxy on a network reachable only by New API, for example `http://copilot-proxy:4399`.
2. Create an OpenAI-compatible or custom New API channel with base URL `http://copilot-proxy:4399/v1`. If the form requires an upstream key, use a placeholder; copilot-proxy authenticates to GitHub itself.
3. Give clients only the New API base URL and New API keys. They do not need direct access to copilot-proxy, `/token`, or the persisted GitHub token.

Operational boundaries:

- Disable New API retries for upstream `403` and `429`. Failover through the same Copilot identity hits the same risk bucket and can amplify a restriction. copilot-proxy already performs one guarded token recovery and returns `503`, `Retry-After`, and `X-Copilot-Proxy-Recovery-State` while its recovery circuit is open.
- Add a final identity-wide bound such as `--max-concurrency 4 --max-queue 50 --queue-timeout-ms 30000` in addition to New API's per-user limits. These are local starting points, not published GitHub limits.
- If New API reaches the container as `copilot-proxy`, set `COPILOT_PROXY_ALLOWED_HOSTS=copilot-proxy`; add only exact internal hostnames that are actually used.
- Claude clients may use New API's Claude-compatible layer or a configured conversion route. For Codex catalog metadata, verify that New API preserves `/v1/models?client_version=...` query strings unchanged.

## CLI and operations

Commands below assume a global install. For one-off use, prefix them with `npx @jer-y/copilot-proxy@latest` or the equivalent runner from [Quick start](#quick-start).

| Command | Purpose |
| --- | --- |
| `start` | Start in the foreground and authenticate when needed; `-d` selects the legacy app-managed daemon |
| `auth` | Authenticate without starting; `--github-token` securely persists an existing token and exits |
| `check-usage` | Show Copilot usage and quota without a running server |
| `debug` | Show version, runtime, paths, and authentication status; `--json` emits JSON |
| `enable` / `disable` | Install or remove the native systemd/launchd/Task Scheduler auto-start service |
| `status` | Show native service status, or legacy daemon PID/port/start time as a fallback |
| `logs` | Show service or legacy daemon logs; use `-f` to follow and `-n <lines>` to set the count |
| `restart` / `stop` | Control the installed native service, or fall back to the legacy daemon |

Common recipes:

| Goal | Command |
| --- | --- |
| Custom listener and diagnostics | `copilot-proxy start --port 8080 --verbose` |
| Business or enterprise route | `copilot-proxy start --account-type business` / `enterprise` |
| Interactive request approval | `copilot-proxy start --manual` |
| Minimum request interval | `copilot-proxy start --rate-limit 30 --wait` |
| Bound shared concurrency | `copilot-proxy start --max-concurrency 4 --max-queue 50 --queue-timeout-ms 30000` |
| Persist an existing token | `copilot-proxy auth --github-token ghp_YOUR_TOKEN_HERE`, then rerun without the secret |
| Use configured proxy variables | `copilot-proxy start --proxy-env` |
| Extend slow-start timeouts | `copilot-proxy start --headers-timeout-ms 600000 --body-timeout-ms 600000` |
| Inspect usage or diagnostics | `copilot-proxy check-usage` / `copilot-proxy debug --json` |

<details>
<summary>Full <code>start</code> option reference</summary>

| Option | Description | Default | Alias |
| --- | --- | --- | --- |
| `--port` | Port to listen on | `4399` | `-p` |
| `--host` | Host/IP to bind; use `0.0.0.0` only when intentionally exposing the port | `127.0.0.1` | `-H` |
| `--verbose` | Detailed diagnostics; treat logs as sensitive | `false` | `-v` |
| `--account-type` | `individual`, `business`, or `enterprise` | `individual` | `-a` |
| `--manual` | Approve each request in an interactive foreground TTY | `false` | none |
| `--rate-limit` | Minimum seconds between requests | none | `-r` |
| `--wait` | Wait instead of error when the rate limit is hit | `false` | `-w` |
| `--max-concurrency` | Maximum concurrent Copilot upstream requests; omitted means disabled | none | none |
| `--max-queue` | Requests waiting for a concurrency slot; `0` disables queueing | `50*` | none |
| `--queue-timeout-ms` | Maximum queue wait; `0` disables waiting | `30000*` | none |
| `--headers-timeout-ms` | Upstream response-header timeout; `0` disables it | `auto*` | none |
| `--body-timeout-ms` | Upstream response-body timeout; `0` disables it | `auto*` | none |
| `--connect-timeout-ms` | Upstream connect timeout; `0` disables it | `auto*` | none |
| `--github-token` | Securely persist a GitHub token, then exit; rerun without this option | none | `-g` |
| `--claude-code` | Generate a Claude Code launch command | `false` | `-c` |
| `--show-token` | Print GitHub and Copilot tokens during fetch/refresh | `false` | none |
| `--proxy-env` | Initialize proxy handling from environment variables | `false` | none |
| `--daemon` | Use the legacy app-managed background daemon | `false` | `-d` |

The `50*` and `30000*` queue defaults apply only after `--max-concurrency` enables the limiter. On Node.js, `auto*` uses built-in defaults of `900000ms` for response headers, `900000ms` for the response body, and `30000ms` for connection setup on requests to `githubcopilot.com`. Other origins retain Node/undici defaults unless explicitly overridden. See GitHub's [subscription-based network routing documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for business and enterprise account routing.

`auth` also accepts `--verbose`, `--show-token`, `--github-token`, and `--proxy-env`. `debug` accepts `--json`; `logs` accepts `--follow`/`-f` and `--lines`/`-n`.

</details>

### Native background service

Use a stable global install or source checkout for a long-lived service:

```sh
npm i -g @jer-y/copilot-proxy
copilot-proxy auth

# Linux only, if enable cannot configure logged-out startup automatically
sudo loginctl enable-linger "$USER"

copilot-proxy enable
copilot-proxy status
copilot-proxy logs -f
```

`enable` installs a foreground `start` under systemd, launchd, or Task Scheduler. It rejects `_npx`, `pnpm dlx`, `yarn dlx`, and `bunx` cache paths because cache cleanup would break the service. Re-running it preserves the installed native configuration when no legacy daemon configuration exists; explicit options override saved values. Use `copilot-proxy enable --clear-concurrency-limit` to remove persisted concurrency settings. `stop`, `restart`, `status`, and `logs` prefer the native service and fall back to the legacy daemon; `copilot-proxy start -d` remains available for compatibility.

<details>
<summary>Local security defaults and sensitive options</summary>

- The proxy listens on `127.0.0.1` for personal local use. Do not expose it to a LAN or the Internet unless every reachable client is trusted. For containers, bind `0.0.0.0` inside and publish only to host loopback, as in `-p 127.0.0.1:4399:4399`.
- CORS allows local browser origins such as `http://localhost:*`, `http://127.0.0.1:*`, and `http://[::1]:*` by default; the hosted dashboard may access only `/usage`. Add exact origins with `COPILOT_PROXY_CORS_ORIGINS=https://internal.example.com`.
- Host validation separately prevents DNS rebinding. Add exact, port-free names with `COPILOT_PROXY_ALLOWED_HOSTS=copilot-proxy,proxy.internal`. JSON bodies require `application/json` or `application/*+json`.
- JSON bodies are limited to 32 MiB by default. Override with a positive `COPILOT_PROXY_MAX_JSON_BODY_BYTES` value.
- Native and legacy services snapshot supported `COPILOT_PROXY_*`, proxy, `NO_PROXY`, and TLS CA variables into owner-only runtime files. `--proxy-env` fails closed without a real proxy endpoint; Bun services restore this environment before runtime startup.
- Native Anthropic document URLs pass through on `/v1/messages`. Local URL fetching for translated documents is off by default. `COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH=1` enables it only for trusted clients and URLs; localhost, private networks, cloud metadata, and reserved DNS/IP targets remain blocked before fetch and after redirects.
- `/token` is off by default because loopback is not a per-user boundary. For short-lived diagnostics, `COPILOT_PROXY_EXPOSE_TOKEN=1` still requires loopback remote/Host and same-origin browser access. Disable it immediately afterward.
- `--manual` fails closed with `503` without an interactive TTY or after approval timeout, so it is unsuitable for services and unattended containers. Treat diagnostic logs as sensitive. `--show-token` prints bearer tokens and must never be used with persisted or shared logs.

</details>

## Client integrations

### Claude Code

[Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) interactive setup selects a primary and small/fast model, then copies a launch command with the required environment variables:

```sh
npx @jer-y/copilot-proxy@latest start --claude-code
```

<details>
<summary>Manual <code>.claude/settings.json</code> example</summary>

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4399",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "claude-sonnet-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-4.5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4.5",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": [
      "WebSearch"
    ]
  }
}
```

Model availability changes upstream. Query `GET /v1/models` and choose current models that advertise Anthropic Messages support; do not use a Chat-Completions-only model. See [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables) and [IDE integration](https://docs.anthropic.com/en/docs/claude-code/ide-integrations).

</details>

### Codex

Point a custom Responses provider at `http://127.0.0.1:4399/v1` and select a current model that exposes the Responses backend. Native WebSocket use additionally requires the model catalog to advertise `ws:/responses`. Codex-to-Claude translation is intentionally narrower; see the [limitations above](#responses-to-claude-and-codex-to-claude-limitations).

### Usage dashboard

On startup, the proxy prints a URL such as:

```text
https://jer-y.github.io/copilot-proxy?endpoint=http://localhost:4399/usage
```

The dashboard fetches usage automatically, shows quota progress and the full JSON response, and lets you change the `endpoint` query parameter for another compatible server or a bookmark. `start.bat` opens it automatically on Windows.

## Development and live validation

```sh
bun install --frozen-lockfile
bun run dev       # watch mode
bun run start     # production mode
```

The complete probe matrix, environment variables, semantic validators, and interpretation rules live in [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md). Keep upstream-gated decisions tied to dated live Copilot evidence rather than assuming that official OpenAI or Anthropic support also exists on Copilot.

Basic opt-in capability probe:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=claude-model-under-test \
COPILOT_LIVE_RESPONSES_MODEL=responses-model-under-test \
bun run test:live:copilot
```

For every Responses behavior change, run the paired real Codex gate:

```sh
COPILOT_LIVE_CODEX_SMOKE=1 \
CODEX_SMOKE_MODEL=gpt-5.4 \
CODEX_SMOKE_ACCOUNT_TYPE=individual \
bun run test:live:codex
```

The script invokes the installed `codex` command for both HTTP/SSE and WSS; it does not emulate a client. WSS success requires local and upstream `101` handshakes, at least two alternating tool-loop turns on one connection, and zero HTTP Responses fallback.

Latest recorded evidence in the validation document is dated 2026-07-15: `gpt-5.4` parity runs for both individual and enterprise routes exited `0` with `confirmed=7`, `inconclusive=0`, and `failed=0`. Function-tool control, `json_object`, `json_schema`, `web_search`, and `web_search_preview` were semantically supported on SSE and WSS; MCP and `file_search` showed explicit rejection parity, not feature support.

## Acknowledgments

Originally based on [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api); the codebase has since been comprehensively rebuilt.
