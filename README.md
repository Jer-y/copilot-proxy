English | [简体中文](README.zh-CN.md)

# Copilot API Proxy

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**
> Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub's abuse-detection systems.
> You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
>
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this proxy responsibly to avoid account restrictions.

---

**Note:** If you are using [opencode](https://github.com/sst/opencode), you do not need this project. Opencode supports GitHub Copilot provider out of the box.

> [!NOTE]
> GitHub now offers first-party Anthropic / Claude experiences in some products, including the Anthropic Claude coding agent powered by Copilot and BYOK Anthropic support in Copilot CLI.
>
> - [Anthropic Claude - GitHub Docs](https://docs.github.com/en/copilot/concepts/agents/anthropic-claude)
> - [Using your own LLM models in GitHub Copilot CLI - GitHub Docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)
>
> This project is still useful when you specifically want a local OpenAI- or Anthropic-compatible API proxy, including native Responses WebSocket mode, backed by your GitHub Copilot subscription for external clients such as Claude Code, Codex, SDKs, or custom tooling.

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes your Copilot subscription through OpenAI- and Anthropic-compatible HTTP endpoints plus native Responses WebSocket mode. This lets you use GitHub Copilot with external tools that speak OpenAI Chat Completions/Responses or Anthropic Messages, including [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) and OpenAI Codex.

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) APIs, with native Claude `/v1/messages` passthrough when the upstream supports it.
- **Responses API Support**: Supports the OpenAI Responses API (`/v1/responses`) for Copilot models that expose the Responses backend. Claude requests are also reachable via `/v1/responses` when their request shape can be faithfully translated to Anthropic Messages.
- **Native Responses WebSocket Mode**: Accepts WebSocket Upgrades on `GET /v1/responses` (and `GET /responses`) and bridges each client connection one-to-one to Copilot's native `wss://.../responses` endpoint. WebSocket mode is dynamically enabled only for models whose current Copilot metadata explicitly advertises `ws:/responses`, on both Bun and Node.js; the existing HTTP `POST`/SSE Responses path remains available.
- **Responses SSE/WSS Semantic Parity Gate**: Includes an opt-in live gate that sends the same feature payload through a real HTTP `stream: true` SSE response and a WebSocket `response.create`, then compares semantic results rather than status codes alone.
- **Codex Ready for Responses-backed models**: OpenAI Codex CLI/SDK works by pointing its base URL to this proxy when the selected Copilot model exposes the Responses backend. Codex-to-Claude translation is subject to the limitations below.
- **Model-Aware Routing and Translation**: Requests are routed directly when the requested client API is supported; otherwise only `/v1/messages` and `/responses` may translate to each other. The proxy does not translate to or from `/chat/completions`. Also applies Claude prompt caching (`copilot_cache_control`), preserves adaptive-thinking / `output_config.effort` compatibility, and normalizes provider-specific model IDs when Copilot expects a different upstream name.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Gateway Friendly**: Put [New API](https://github.com/QuantumNous/new-api) in front of this proxy to get one deployment that can serve many clients with New API-managed users, API keys, quotas, logs, rate limits, and billing.
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Bounded Upstream Concurrency**: Optionally cap shared Copilot concurrency and bound the wait queue with `--max-concurrency`, `--max-queue`, and `--queue-timeout-ms`.
- **Token-Aware Self-Healing**: A request-time upstream `401`, or GitHub's correlation-ID-bearing plain-text `403 Forbidden`, triggers one single-flight short-lived token refresh and one guarded replay. Persistent rejection opens a cooldown circuit instead of creating a refresh storm.
- **Upstream Resilience Controls**: Use built-in longer Copilot upstream timeouts, tune header/body/connect timeout overrides, and emit Anthropic SSE keepalive `ping` events while waiting for the first translated stream event.
- **Manual Request Approval**: Approve or deny each request in an interactive foreground TTY; unavailable or timed-out prompts fail closed (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.
- **Native Background Services**: Register the proxy as an auto-start service on Linux (systemd), macOS (launchd), and Windows (Task Scheduler) with `enable`/`disable`. `stop`, `restart`, `status`, and `logs` prefer the native service manager when a service is installed.
- **Legacy Daemon Mode**: `start -d` remains available as an app-managed compatibility mode when you do not want to install a native service.

On Linux, `enable` installs a user systemd service and requires systemd user lingering so the service can start after boot before the user logs in. If lingering cannot be enabled automatically, run `sudo loginctl enable-linger "$USER"` and retry `enable`.

## Prerequisites

- Bun >= 1.3.6 when running from source or using `bunx --bun`
- Node.js >= 22.19.0 for global CLI installations and when using npm, npx, pnpm, Yarn, or Volta
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Installation

### Install the CLI (global)

Pick your package manager:

```sh
# npm
npm i -g @jer-y/copilot-proxy

# pnpm
pnpm add -g @jer-y/copilot-proxy

# yarn (classic)
yarn global add @jer-y/copilot-proxy

# volta (optional)
volta install @jer-y/copilot-proxy
```

Then run:

```sh
copilot-proxy start
```

### Run without installing (one-off)

```sh
# npx
npx @jer-y/copilot-proxy@latest start

# pnpm dlx
pnpm dlx @jer-y/copilot-proxy@latest start

# yarn dlx
yarn dlx @jer-y/copilot-proxy@latest start

# Bun (force the package bin to run with Bun)
bunx --bun @jer-y/copilot-proxy@latest start
```

### Install from source (development)

To install dependencies locally, run:

```sh
bun install --frozen-lockfile
```

## Using with Docker

Build image

```sh
docker build -t copilot-proxy .
```

Run the container

```sh
# Create a named volume so credentials never enter the source/build context
docker volume create copilot-proxy-data

# Run the container with the named volume to persist authentication
# This ensures your authentication survives container restarts
docker run -p 127.0.0.1:4399:4399 -v copilot-proxy-data:/home/bun/.local/share/copilot-proxy copilot-proxy start --host 0.0.0.0
```

> **Note:**
> The GitHub token and related data are stored in the Docker-managed `copilot-proxy-data` volume. Do not place token data inside the repository or Docker build context.

### Docker with Environment Variables

You can pass the GitHub token directly to the container using environment variables:

```sh
# Store GH_TOKEN in a mode-0600 env file outside this repository, then run:
docker run -p 127.0.0.1:4399:4399 --env-file "$HOME/.config/copilot-proxy/container.env" copilot-proxy start --host 0.0.0.0

# Run with additional options
docker run -p 127.0.0.1:4399:4399 --env-file "$HOME/.config/copilot-proxy/container.env" copilot-proxy start --host 0.0.0.0 --port 4399
```

### Docker Compose Example

```yaml
version: '3.8'
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

The Docker image includes:

- Multi-stage build for optimized image size
- Non-root user for enhanced security
- Health check for container monitoring
- Base image pinned by version and digest for reproducible builds

## Using with New API

[New API](https://github.com/QuantumNous/new-api) is a self-hosted AI gateway and asset-management platform. It can sit in front of multiple upstream providers, expose OpenAI/Claude/Gemini-compatible entry points, and handle user-facing API keys, token quotas, model permissions, usage logs, rate limits, billing, and load-balancing from one console.

This pairs well with copilot-proxy:

- **copilot-proxy** stays as the private upstream bridge to GitHub Copilot. It owns GitHub login, Copilot token refresh, model routing, and OpenAI/Anthropic compatibility.
- **New API** becomes the public or team-facing gateway. It owns user authentication, API keys, quotas, billing, audit logs, and client distribution.

In this topology, deploy copilot-proxy on a private network and expose only New API to users:

```text
Clients / SDKs / Claude Code / Codex
        |
        | New API key, quota, logging, billing
        v
New API gateway
        |
        | Private upstream channel
        v
copilot-proxy
        |
        | GitHub Copilot authentication
        v
GitHub Copilot upstream
```

Recommended setup:

1. Deploy and authenticate copilot-proxy first. Keep it reachable only from the New API host or container network, for example `http://copilot-proxy:4399`.
2. Deploy New API following its own Docker/Compose guide.
3. In New API, create an OpenAI-compatible or custom upstream channel that points to copilot-proxy's OpenAI-compatible base URL, for example `http://copilot-proxy:4399/v1`.
4. Put any placeholder upstream key in New API if the channel form requires one. copilot-proxy authenticates to GitHub Copilot itself and does not need New API to forward a real upstream provider key.
5. Give users New API API keys and the New API base URL. Clients should not need direct access to copilot-proxy, `/token`, or the persisted GitHub token.

Keep New API retries disabled for upstream `403` and `429` responses. A retry or failover to another channel backed by the same Copilot identity still hits the same upstream risk bucket and can amplify a temporary restriction. Let copilot-proxy perform its single guarded token recovery; when its recovery circuit is open it returns `503`, `Retry-After`, and `X-Copilot-Proxy-Recovery-State` without sending another GitHub request.

For a shared deployment, configure a final identity-wide concurrency bound on copilot-proxy in addition to New API's per-user limits, for example `--max-concurrency 4 --max-queue 50 --queue-timeout-ms 30000`. These are local protective settings, not documented GitHub service limits; tune them from your own observed workload.

When New API reaches the container using the `copilot-proxy` service name, set `COPILOT_PROXY_ALLOWED_HOSTS=copilot-proxy` on copilot-proxy. Add only the exact internal hostnames clients actually use.

For Claude-compatible clients, use New API's Claude-compatible access layer if your deployment exposes it, or let New API convert/route to the OpenAI-compatible copilot-proxy channel according to your New API channel configuration. For Codex CLI, validate that your New API deployment forwards `/v1/models?client_version=...` query strings unchanged if you want Codex-compatible model catalog and context-window metadata; copilot-proxy supports that catalog path directly.

This gives a practical "deploy once, access everywhere" layout: copilot-proxy concentrates the Copilot compatibility work in one place, while New API provides the shared access-control and API-key layer for all downstream clients.

## Using with npx (or pnpm/Bun/Yarn)

You can run the project directly using npx:

```sh
npx @jer-y/copilot-proxy@latest start
```

With options:

```sh
npx @jer-y/copilot-proxy@latest start --port 8080
```

For authentication only:

```sh
npx @jer-y/copilot-proxy@latest auth
```

> Tip: If you prefer pnpm/Bun/Yarn, replace `npx` with `pnpm dlx`, `bunx --bun`, or `yarn dlx`. The published global bin uses a Node.js shebang, so a Bun-only machine should use `bunx --bun` instead of `bun add -g`.

## Command Structure

Copilot API now uses a subcommand structure with these main commands:

- `start`: Start the Copilot API server in the foreground. This command will also handle authentication if needed. Use `-d` only for the legacy app-managed background daemon.
- `stop`: Stop the installed native service, or fall back to the legacy daemon.
- `restart`: Restart the installed native service, or fall back to the legacy daemon using saved configuration.
- `status`: Show native service status, or fall back to legacy daemon status (PID, port, start time).
- `logs`: View native service logs where supported, or fall back to legacy daemon logs. Use `-f` to follow in real time.
- `enable`: Register the proxy as a native auto-start service (systemd/launchd/Task Scheduler) that runs foreground `start`. Linux requires systemd user lingering for logged-out startup.
- `disable`: Remove the auto-start service registration.
- `auth`: Run GitHub authentication flow without starting the server. In non-interactive environments, `--github-token` can persist an existing token once; it intentionally exits, after which you start again without the secret argument.
- `check-usage`: Show your current GitHub Copilot usage and quota information directly in the terminal (no server required).
- `debug`: Display diagnostic information including version, runtime details, file paths, and authentication status. Useful for troubleshooting and support.

## Command Line Options

### Start Command Options

The following command line options are available for the `start` command:

| Option         | Description                                                                   | Default    | Alias |
| -------------- | ----------------------------------------------------------------------------- | ---------- | ----- |
| --port         | Port to listen on                                                             | 4399       | -p    |
| --host         | Host/IP to bind to. Use `0.0.0.0` only when intentionally exposing the port    | 127.0.0.1  | -H    |
| --verbose      | Enable detailed diagnostics; treat logs as sensitive                          | false      | -v    |
| --account-type | Account type to use (individual, business, enterprise)                        | individual | -a    |
| --manual       | Approve each request in an interactive foreground TTY                         | false      | none  |
| --rate-limit   | Rate limit in seconds between requests                                        | none       | -r    |
| --wait         | Wait instead of error when rate limit is hit                                  | false      | -w    |
| --max-concurrency | Maximum concurrent Copilot upstream requests; disabled when omitted        | none       | none  |
| --max-queue    | Maximum requests waiting for a concurrency slot (`0` disables queueing)        | 50*        | none  |
| --queue-timeout-ms | Maximum concurrency-queue wait in milliseconds (`0` disables waiting)     | 30000*     | none  |
| --headers-timeout-ms | Upstream HTTP response headers timeout in milliseconds (`0` disables timeout) | auto*  | none  |
| --body-timeout-ms | Upstream HTTP response body timeout in milliseconds (`0` disables timeout) | auto*      | none  |
| --connect-timeout-ms | Upstream HTTP connect timeout in milliseconds (`0` disables timeout) | auto*      | none  |
| --github-token | Persist a GitHub token to the owner-only token file, then exit; rerun `start` without this flag | none       | -g    |
| --claude-code  | Generate a command to launch Claude Code with Copilot API config              | false      | -c    |
| --show-token   | Show GitHub and Copilot tokens on fetch and refresh                           | false      | none  |
| --proxy-env    | Initialize proxy from environment variables                                   | false      | none  |
| --daemon       | Run as a legacy app-managed background daemon                                 | false      | -d    |

The `50*` and `30000*` queue defaults apply only after `--max-concurrency` enables the limiter. `auto*` means that on Node.js, requests to `githubcopilot.com` use built-in defaults of `900000ms` headers timeout, `900000ms` body timeout, and `30000ms` connect timeout when no explicit override is provided. Other origins keep Node/undici defaults unless you override them explicitly.

### Local Security Defaults

The proxy listens on `127.0.0.1` by default and is intended for personal local use. Do not bind it to a LAN or Internet-facing interface unless every client that can reach the port is trusted. If you need container port mapping, bind inside the container with `--host 0.0.0.0` and map the host port to loopback, for example `-p 127.0.0.1:4399:4399`.

CORS is restricted by default to local browser origins such as `http://localhost:*`, `http://127.0.0.1:*`, and `http://[::1]:*`. The hosted usage dashboard origin is allowed only for `/usage`. To add other exact browser origins, set `COPILOT_PROXY_CORS_ORIGINS` to a comma-separated list, for example `COPILOT_PROXY_CORS_ORIGINS=https://internal.example.com`.

Requests with a disallowed browser Origin are rejected before route execution. Request Hosts are separately restricted to loopback names to prevent DNS rebinding. When intentionally serving another hostname, add its exact hostname (without a port) to `COPILOT_PROXY_ALLOWED_HOSTS`, for example `COPILOT_PROXY_ALLOWED_HOSTS=copilot-proxy,proxy.internal`. JSON request bodies must use `Content-Type: application/json` (or an `application/*+json` media type).

Inbound JSON request bodies are limited to 32 MiB by default. To override this, set `COPILOT_PROXY_MAX_JSON_BODY_BYTES` to a positive byte count.

Legacy daemon and native-service installs snapshot the supported `COPILOT_PROXY_*`, proxy, `NO_PROXY`, and TLS CA environment into owner-only runtime files. `--proxy-env` fails closed unless a real proxy endpoint is configured. Bun services are bootstrapped with that environment before the runtime starts so Bun's startup-time proxy snapshot cannot silently bypass a restored proxy or retain an unapproved ambient proxy.

Anthropic document URL sources are forwarded natively when the selected model uses Copilot's `/v1/messages` backend. Local URL fetching for translated document requests is disabled by default. If you explicitly trust the clients and URLs, set `COPILOT_PROXY_ALLOW_DOCUMENT_URL_FETCH=1`; the proxy still rejects localhost, private network, cloud metadata, and reserved DNS/IP targets before fetching and after redirects.

`GET /token` is disabled by default because loopback is not a per-user security boundary. For a short-lived local diagnostic only, set `COPILOT_PROXY_EXPOSE_TOKEN=1`; the route still requires a loopback remote address, a loopback Host, and same-origin browser access. Disable it again immediately afterwards.

`--manual` fails closed: requests receive `503` when no interactive TTY is available or approval times out. Use it only with a foreground `start`; it is not suitable for `enable`, `start -d`, containers without a TTY, or other unattended services. Treat all diagnostic logs as sensitive. `--show-token` deliberately prints bearer tokens and must never be used with persisted or shared logs.

When a `/v1/responses` request must be translated to a native Claude `/v1/messages` backend, it must explicitly set `store: false`; the proxy cannot emulate the Responses API's default server-side persistence or make a translated response ID retrievable. Initial system/developer input is kept as the top-level Anthropic system prompt. Mid-conversation system/developer input is preserved only in Anthropic-supported positions; an unrepresentable ordering is rejected instead of being reordered.

> **Codex-to-Claude limitation:** With Codex CLI 0.144.1, the tested default configuration includes hosted/custom Responses tools that cannot be represented faithfully by Anthropic Messages. The proxy intentionally rejects that request locally with HTTP `400` instead of dropping tools or reporting a misleading success. The restricted real-machine smoke passed text and `exec_command` tool-loop coverage with the following overrides; this proves only that scoped configuration, not default Codex-to-Claude compatibility:
>
> ```sh
> -c 'web_search="disabled"' \
> -c 'features.multi_agent=false' \
> -c 'features.remote_plugin=false'
> ```

### Auth Command Options

| Option       | Description               | Default | Alias |
| ------------ | ------------------------- | ------- | ----- |
| --verbose    | Enable sensitive diagnostics | false | -v    |
| --show-token | Show GitHub token on auth | false   | none  |
| --github-token | Persist a GitHub token securely, then exit | none | -g |
| --proxy-env | Use HTTP(S)_PROXY/NO_PROXY for authentication requests | false | none |

### Debug Command Options

| Option | Description               | Default | Alias |
| ------ | ------------------------- | ------- | ----- |
| --json | Output debug info as JSON | false   | none  |

### Logs Command Options

| Option  | Description           | Default | Alias |
| ------- | --------------------- | ------- | ----- |
| --follow | Follow log output    | false   | -f    |
| --lines  | Number of lines to show | 50   | -n    |

## API Endpoints

The OpenAI-compatible Chat Completions, Models, Embeddings, and Responses routes accept both the listed `/v1/...` path and the corresponding unprefixed path. Anthropic Messages is available only under `/v1/messages`; `/usage`, `/token`, `/livez`, and `/readyz` are unprefixed auxiliary routes.

### OpenAI Compatible Endpoints

These endpoints mimic the OpenAI API structure.

| Endpoint                    | Method | Description                                               |
| --------------------------- | ------ | --------------------------------------------------------- |
| `POST /v1/chat/completions` | `POST` | Creates a model response for the given chat conversation. |
| `GET /v1/models`            | `GET`  | Lists the currently available models.                     |
| `POST /v1/embeddings`       | `POST` | Creates an embedding vector representing the input text.  |

### OpenAI Responses API Endpoint

These endpoints support the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) format. HTTP requests backed by Copilot's Responses surface are forwarded directly upstream; Claude models can use the HTTP route through a faithful Anthropic Messages translation. WebSocket turns are direct-only: the proxy opens the one-to-one Copilot bridge only after the first `response.create` selects a live model that explicitly advertises `ws:/responses`. It does not translate Claude/Anthropic Messages, Chat Completions, or the Realtime API into WebSocket support.

| Endpoint              | Method          | Description                                                               |
| --------------------- | --------------- | ------------------------------------------------------------------------- |
| `POST /v1/responses`  | `POST`          | Creates a model response using the Responses API (supports SSE streaming). |
| `GET /v1/responses`   | `GET` + Upgrade | Opens Responses WebSocket mode; the first turn must select an explicitly supported model. |

WebSocket mode follows the [official Responses WebSocket contract](https://developers.openai.com/api/docs/guides/websocket-mode): send `response.create` text events, keep at most one response in flight on a connection, and let queued turns run FIFO rather than multiplexing them. A connection lasts at most 60 minutes. If you use `store: false`, connection-local `previous_response_id` state is not available after reconnect, so start a new chain with the full required context unless you deliberately use persisted state. HTTP/SSE clients can continue using `POST /v1/responses` unchanged.

Streaming is implicit on this transport. The proxy rejects `stream: false` and malformed `stream` values before opening upstream, while treating `stream: true` or `null` as transport-compatible no-ops and stripping them from the Copilot event.

Downstream input buffering is bounded independently from upstream concurrency: each text frame is limited to 16 MiB, each connection may queue at most 8 turns or 32 MiB, and all Responses WebSocket connections share a 64 MiB request-buffer budget covering queued and setup-stage frames. A connection that exceeds either queue boundary receives a local `429` and is closed without forwarding the rejected turn to Copilot.

Compatibility note: official OpenAI WebSocket mode defines `generate: false` as a no-output state warmup. Copilot's 2026-07-15 behavior was not equivalent: it returned `bad_request` without `input` and generated output when `input` was present. The proxy therefore fails closed with `400 unsupported_value` (`param: "generate"`) before connecting upstream instead of reporting a misleading warmup success.

### Anthropic Compatible Endpoints

These endpoints are designed to be compatible with the Anthropic Messages API. Claude models use Copilot's native `/v1/messages` surface as a passthrough. Responses-backed non-Claude models are served by translating Anthropic Messages into the Responses API.

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | `POST` | Creates a model response for a given conversation.           |
| `POST /v1/messages/count_tokens` | `POST` | Calculates the number of tokens for a given set of messages. |

### Usage Monitoring Endpoints

Endpoints for monitoring your Copilot usage and quotas.

| Endpoint     | Method | Description                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| `GET /usage` | `GET`  | Get detailed Copilot usage statistics and quota information. |
| `GET /token` | `GET`  | Get the current Copilot token for local diagnostics. Disabled unless `COPILOT_PROXY_EXPOSE_TOKEN=1`, then restricted to loopback and same-origin reads. |
| `GET /livez` | `GET`  | Process liveness only; does not claim that the Copilot upstream is available. |
| `GET /readyz` | `GET` | Passive readiness and non-secret token, recovery-circuit, model-cache, and concurrency status. Returns `503` while the global recovery circuit is not closed. |

## Example Usage

Using with npx (replace with `pnpm dlx`, `bunx --bun`, or `yarn dlx` if preferred):

```sh
# Basic usage with start command
npx @jer-y/copilot-proxy@latest start

# Run on custom port with verbose logging
npx @jer-y/copilot-proxy@latest start --port 8080 --verbose

# Use with a business plan GitHub account
npx @jer-y/copilot-proxy@latest start --account-type business

# Use with an enterprise plan GitHub account
npx @jer-y/copilot-proxy@latest start --account-type enterprise

# Enable manual approval for each request
npx @jer-y/copilot-proxy@latest start --manual

# Set rate limit to 30 seconds between requests
npx @jer-y/copilot-proxy@latest start --rate-limit 30

# Wait instead of error when rate limit is hit
npx @jer-y/copilot-proxy@latest start --rate-limit 30 --wait

# Bound shared Copilot concurrency and its local wait queue
npx @jer-y/copilot-proxy@latest start --max-concurrency 4 --max-queue 50 --queue-timeout-ms 30000

# Persist a GitHub token, then start without the secret argument
npx @jer-y/copilot-proxy@latest start --github-token ghp_YOUR_TOKEN_HERE
npx @jer-y/copilot-proxy@latest start

# Run only the auth flow
npx @jer-y/copilot-proxy@latest auth

# Persist an existing token without starting the device flow
npx @jer-y/copilot-proxy@latest auth --github-token ghp_YOUR_TOKEN_HERE

# Run auth flow with verbose logging
npx @jer-y/copilot-proxy@latest auth --verbose

# Show your Copilot usage/quota in the terminal (no server needed)
npx @jer-y/copilot-proxy@latest check-usage

# Display debug information for troubleshooting
npx @jer-y/copilot-proxy@latest debug

# Display debug information in JSON format
npx @jer-y/copilot-proxy@latest debug --json

# Initialize proxy from environment variables (HTTP_PROXY, HTTPS_PROXY, etc.)
npx @jer-y/copilot-proxy@latest start --proxy-env

# Increase upstream timeouts for slower model start-up
npx @jer-y/copilot-proxy@latest start --headers-timeout-ms 600000 --body-timeout-ms 600000

# Native services must use a stable global installation, not an npx/dlx cache
npm i -g @jer-y/copilot-proxy

# Authenticate before installing a non-interactive native service
copilot-proxy auth

# Linux only: required if enable cannot turn on logged-out startup automatically
sudo loginctl enable-linger "$USER"

# Register and start a native auto-start service (systemd/launchd/Task Scheduler)
copilot-proxy enable

# Or persist bounded concurrency directly in the native service
copilot-proxy enable --max-concurrency 4 --max-queue 50 --queue-timeout-ms 30000

# Check service status
copilot-proxy status

# View service logs (last 50 lines)
copilot-proxy logs

# Follow service logs in real time
copilot-proxy logs -f

# Restart the service
copilot-proxy restart

# Stop the service
copilot-proxy stop

# Remove auto-start registration
copilot-proxy disable

# Legacy app-managed daemon mode remains available for compatibility
copilot-proxy start -d
```

`enable` rejects `_npx`, `pnpm dlx`, `yarn dlx`, and `bunx` cache paths because a long-lived service would break as soon as that cache is cleaned. A global installation or a stable source checkout is required for native auto-start. Re-running `enable` preserves the previously installed native configuration when no legacy daemon configuration is present; explicit concurrency options override it. Use `copilot-proxy enable --clear-concurrency-limit` to remove persisted concurrency and queue settings.

## Using the Usage Viewer

After starting the server, a URL to the Copilot Usage Dashboard will be displayed in your console. This dashboard is a web interface for monitoring your API usage.

1.  Start the server. For example, using npx:
    ```sh
    npx @jer-y/copilot-proxy@latest start
    ```
2.  The server will output a URL to the usage viewer. Copy and paste this URL into your browser. It will look something like this:
    `https://jer-y.github.io/copilot-proxy?endpoint=http://localhost:4399/usage`
    - If you use the `start.bat` script on Windows, this page will open automatically.

The dashboard provides a user-friendly interface to view your Copilot usage data:

- **API Endpoint URL**: The dashboard is pre-configured to fetch data from your local server endpoint via the URL query parameter. You can change this URL to point to any other compatible API endpoint.
- **Fetch Data**: Click the "Fetch" button to load or refresh the usage data. The dashboard will automatically fetch data on load.
- **Usage Quotas**: View a summary of your usage quotas for different services like Chat and Completions, displayed with progress bars for a quick overview.
- **Detailed Information**: See the full JSON response from the API for a detailed breakdown of all available usage statistics.
- **URL-based Configuration**: You can also specify the API endpoint directly in the URL using a query parameter. This is useful for bookmarks or sharing links. For example:
  `https://jer-y.github.io/copilot-proxy?endpoint=http://your-api-server/usage`

## Using with Claude Code

This proxy can be used to power [Claude Code](https://docs.anthropic.com/en/claude-code), an experimental conversational AI assistant for developers from Anthropic.

There are two ways to configure Claude Code to use this proxy:

### Interactive Setup with `--claude-code` flag

To get started, run the `start` command with the `--claude-code` flag:

```sh
npx @jer-y/copilot-proxy@latest start --claude-code
```

You will be prompted to select a primary model and a "small, fast" model for background tasks. After selecting the models, a command will be copied to your clipboard. This command sets the necessary environment variables for Claude Code to use the proxy.

Paste and run this command in a new terminal to launch Claude Code.

### Manual Configuration with `settings.json`

Alternatively, you can configure Claude Code by creating a `.claude/settings.json` file in your project's root directory. This file should contain the environment variables needed by Claude Code. This way you don't need to run the interactive setup every time.

Here is an example `.claude/settings.json` file:

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

Model availability changes upstream. Before saving this configuration, query `GET /v1/models` and choose current models that advertise Anthropic Messages support; do not use a Chat-Completions-only model for Claude Code.

You can find more options here: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables)

You can also read more about IDE integration here: [Add Claude Code to your IDE](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## Running from Source

The project can be run from source in several ways:

### Development Mode

```sh
bun run dev
```

### Production Mode

```sh
bun run start
```

### Live Copilot Capability Validation

When you change Anthropic or Claude compatibility behavior, it is worth validating whether GitHub Copilot upstream actually accepts the mapped fields before enabling them by default.

The repository includes an opt-in live probe suite:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=claude-model-under-test \
COPILOT_LIVE_RESPONSES_MODEL=responses-model-under-test \
bun run test:live:copilot
```

See [docs/copilot-capability-validation.md](docs/copilot-capability-validation.md) for the probe matrix, supported environment variables, and result interpretation.

For a Responses WebSocket change, run the focused deterministic gates before the full suite:

```sh
bun test \
  tests/responses-websocket.test.ts \
  tests/responses-websocket-upgrade.test.ts \
  tests/responses-websocket-upstream.test.ts \
  tests/copilot-responses-transport-parity.test.ts \
  tests/routing-policy.test.ts \
  tests/models-route.test.ts \
  tests/copilot-auth-recovery.test.ts \
  tests/start-shutdown.test.ts
bun run test:node:http
```

Run the live semantic-parity gate for every Copilot account route in scope:

```sh
COPILOT_LIVE_WS_PARITY=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_RESPONSES_MODEL=gpt-5.4 \
COPILOT_ACCOUNT_TYPE=individual \
bun test tests/live/copilot-responses-transport-parity.test.ts

# Repeat with COPILOT_ACCOUNT_TYPE=enterprise when validating that route.
```

The gate uses one common payload per feature, forces the HTTP side through real SSE, and sends the WebSocket side as `response.create`. A pair mismatch or semantic-validation failure fails the run; matching resource/dependency failures are only inconclusive. For positive `file_search` validation, also set `COPILOT_LIVE_VECTOR_STORE_ID` and `COPILOT_LIVE_FILE_SEARCH_SENTINEL`.

On 2026-07-15, both the `individual` and `enterprise` runs for `gpt-5.4` exited `0` with `confirmed=7`, `inconclusive=0`, and `failed=0`. Function-tool control, `json_object`, `json_schema`, `web_search`, and `web_search_preview` were semantically supported on both transports. MCP and `file_search` returned the same explicit capability-unsupported result on both transports; this confirms rejection parity, not feature support. See the [dated evidence and validators](docs/copilot-capability-validation.md#responses-ssewss-semantic-parity-gate).

For every Responses behavior change, run the paired real Codex client gate; it runs HTTP/SSE first and WSS second by default:

```sh
COPILOT_LIVE_CODEX_SMOKE=1 \
CODEX_SMOKE_MODEL=gpt-5.4 \
CODEX_SMOKE_ACCOUNT_TYPE=individual \
bun run test:live:codex
```

The script invokes the installed `codex` command for both halves; it does not emulate a Codex client. The WSS half must prove local and upstream `101` handshakes, no HTTP `POST /v1/responses` fallback, and at least two alternating tool-loop turns on one persistent connection. See [Responses WebSocket client gate](docs/copilot-capability-validation.md#responses-websocket-client-gate).

## Usage Tips

- To avoid hitting GitHub Copilot's rate limits, you can use the following flags:
  - `--manual`: Enables fail-closed approval for each request in an interactive foreground TTY. It rejects requests if the prompt cannot be shown or times out.
  - `--rate-limit <seconds>`: Enforces a minimum time interval between requests. For example, `copilot-proxy start --rate-limit 30` will ensure there's at least a 30-second gap between requests.
  - `--wait`: Use this with `--rate-limit`. It makes the server wait for the cooldown period to end instead of rejecting the request with an error. This is useful for clients that don't automatically retry on rate limit errors.
  - `--max-concurrency <count>`: Caps simultaneous upstream work for the shared Copilot identity. `--max-queue` and `--queue-timeout-ms` bound local waiting; overflow is returned without touching GitHub.
- Automatic authentication recovery is deliberately bounded: the proxy refreshes only the short-lived Copilot token, replays at most once before any downstream bytes are sent, and stops retrying when a fresh-token canary is still rejected. Do not build a service-restart or token-refresh loop around persistent `403` responses.
- If you have a GitHub business or enterprise plan account with Copilot, use the `--account-type` flag (e.g., `--account-type business`). See the [official documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/managing-copilot/managing-github-copilot-in-your-organization/managing-access-to-github-copilot-in-your-organization/managing-github-copilot-access-to-your-organizations-network#configuring-copilot-subscription-based-network-routing-for-your-enterprise-or-organization) for more details.

## Acknowledgments

This project is forked from [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api). This repository was created for personal use.
