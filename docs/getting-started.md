English | [简体中文](getting-started.zh-CN.md)

# Getting started

This guide validates a proxy route, generates client configuration, and starts the service. copilot-proxy is designed for one trusted user; review [Product support](product-support.md) before using a non-loopback deployment.

## Requirements

- A GitHub account with an active individual, business, or enterprise Copilot subscription.
- Node.js 22.19.0 or later for the published CLI, or Git and Bun 1.3.6 or later for a source checkout and `bunx --bun`.
- Codex 0.134.0 or later must be installed on `PATH` to run `setup codex` or apply and test its generated profile; Claude Code or an OpenAI SDK application is required only when applying and testing the corresponding generated configuration.
- A free local TCP port; the default is `4399`.

## 1. Choose an installation path

Both paths below work from an empty directory. For the published registry package, either install the CLI globally or use the one-shot runner:

```sh
# Global installation
npm install --global @jer-y/copilot-proxy@latest
copilot-proxy --help
copilot-proxy start

# Or run the published CLI without installing it
npx --yes @jer-y/copilot-proxy@latest --help
npx --yes @jer-y/copilot-proxy@latest start
```

The registry's `latest` tag selects a particular published package, not the source checkout. Treat `--help` from that selected package as authoritative for `setup`, `models`, and `doctor`; use a command through the package only when that package lists it.

The guided setup in the rest of this document uses the current source checkout. From an empty directory, prepare it with:

```sh
git clone https://github.com/Jer-y/copilot-proxy.git
cd copilot-proxy
bun install --frozen-lockfile
```

Commands below intentionally use `bun run ./src/main.ts` so they refer to that checkout. Once a registry release lists the same commands in `--help`, you may use `copilot-proxy` or the same one-shot package runner consistently instead.

## 2. Validate the proxy route with setup

Run setup for the client you will actually use:

```sh
# Choose one
bun run ./src/main.ts setup claude
bun run ./src/main.ts setup codex
bun run ./src/main.ts setup openai-sdk
```

`setup` authenticates when needed, reads the current Copilot model catalog, selects a **direct** route, and probes it through a disposable loopback listener. When a model's `supported_endpoints` list is present and non-empty, that live metadata is authoritative for HTTP. When `supported_endpoints` is missing or empty, setup may instead fall back to copilot-proxy's bundled routing policy as an eligibility input. Responses WebSocket never uses this fallback: the current model entry must explicitly advertise `ws:/responses`. Codex further intersects the HTTP Responses-eligible models with the usable installed bundled entries.

The probe requires an observable completed response before configuration is generated. Codex and Claude use real streaming requests and a terminal sentinel; OpenAI SDK setup validates the selected direct JSON route. A distinct Claude small model, when selected, is probed separately. Probe deadlines, output budgets, and shutdown grace keep this disposable service bounded: reaching one means validation was incomplete, not that the upstream capability is unsupported. If only the Codex WebSocket probe fails, setup reports that result and keeps the independently validated HTTP/SSE profile with `supports_websockets = false`.

`setup codex` also requires installed Codex 0.134.0 or newer and usable bundled metadata for the selected model. Its generated profile uses a dedicated child `CODEX_HOME` and command-backed, non-secret placeholder auth so Codex refreshes the proxy-filtered model catalog. This excludes the normal-home base configuration, but system and trusted-project configuration can still override the generated provider; see troubleshooting below.

These are separate evidence layers: installed-client metadata and routing policy determine eligibility; the setup route probes separately validate observable proxy-route semantics; neither proves that the generated profile was saved and executed by the real client. Setup does not write client configuration files or launch the final profile. For each Codex version you use, save the output at the printed path, run the exact generated command, and complete a real turn. Confirm proxy logs contain `Codex model catalog response: client_version=<installed-version> status=200` plus completed `POST /v1/responses` for HTTP/SSE or a forwarded and completed `response.create` for WebSocket, and confirm Codex reports neither `auth cannot be combined with env_key` nor metadata fallback. The generic request log deliberately omits query values. The Claude setup probe does not invoke the local `claude` binary.

| Client | Generated result |
| --- | --- |
| Claude Code | A launch command with a CLI `--settings` overlay, so conflicting user `settings.json` environment values are not edited or selected |
| Codex | TOML content to save manually as `copilot-proxy-home/copilot-proxy.config.toml` under the resolved normal Codex home (`CODEX_HOME` when set, otherwise the platform `.codex` directory), including non-secret command-backed auth for catalog refresh, plus a launch command that scopes `CODEX_HOME` to `copilot-proxy-home` and selects `--profile copilot-proxy` |
| OpenAI SDK | `OPENAI_BASE_URL`, a dummy local API key, the selected model, and the validated direct API family |

Useful setup options:

```sh
bun run ./src/main.ts setup codex --model <model-id>
bun run ./src/main.ts setup claude --small-model <model-id>
bun run ./src/main.ts setup openai-sdk --port 4400
bun run ./src/main.ts setup codex --account-type business
bun run ./src/main.ts setup codex --json --model <model-id>
bun run ./src/main.ts setup codex --copy
bun run ./src/main.ts setup openai-sdk --shell powershell
```

Setup supports the `personal`, `service`, and `custom` presets, but its unauthenticated disposable listener must use a directly bindable loopback `--host`: `localhost`, a `127/8` IPv4 address, or `::1`. Wildcards, `.localhost` subdomains, scoped IPv6 addresses, and other non-loopback hosts are rejected before authentication. The `gateway-upstream` preset belongs to a separately secured deployment and is intentionally unavailable in setup. Detected client files are preserved; clipboard output happens only with `--copy`, which cannot be combined with machine-readable `--json`.

Interactive Codex setup offers the intersection of direct HTTP Responses candidates and usable installed bundled metadata. An explicit `--model` must pass the same checks. In `--json` or another non-interactive run, pass `--model` explicitly.

Setup follows one-shot npm `.cmd` launchers back to the invoking PowerShell when it can. Use `--shell bash|zsh|fish|powershell|pwsh|cmd|sh` when a wrapper or automation layer hides the destination shell.

## 3. Start the long-running proxy

Use the exact start command printed by setup. A shortened form of the default local source command is:

```sh
bun run ./src/main.ts start --preset personal
```

Keep that foreground process running, then apply the generated configuration and launch the client in another terminal.

For an operating-system-managed process, follow [Native service management](operations.md#native-service-management).

## 4. Inspect models and diagnose the service

`models` reads the current Copilot catalog and shows routes appropriate for each client:

```sh
bun run ./src/main.ts models --client all
bun run ./src/main.ts models --client claude
bun run ./src/main.ts models --client codex --json
bun run ./src/main.ts models --client openai-sdk
```

Catalog metadata supports routing decisions; it does not prove every request semantic. See [Protocol compatibility](protocol-compatibility.md) for that distinction.

After the long-running proxy starts, diagnose it by base URL:

```sh
bun run ./src/main.ts doctor \
  --endpoint http://127.0.0.1:4399 \
  --client codex
```

Use `--json` for automation. Doctor exits nonzero when a required check fails. Operational details and the dashboard are documented in [Operations](operations.md).

## Troubleshooting

- **No compatible model:** run `models --client <client> --json` with the same account type. Setup deliberately requires a current direct route.
- **Port already in use:** stop the existing listener or pass another `--port` to setup and start.
- **Non-loopback setup host rejected:** setup deliberately exposes no LAN/container listener because the disposable proxy has no downstream client authentication. Validate on loopback, then configure the long-running deployment separately.
- **Existing client configuration or wrong Codex catalog:** setup does not overwrite client files. Save Codex output only at the generated path inside `copilot-proxy-home`, keep that home's `config.toml` absent, and do not append it to the main configuration. If logs lack a successful `Codex model catalog response` entry for the installed version or Codex reports metadata fallback, remove conflicting `model_catalog_json` or `[model_providers.copilot-proxy]` definitions from system and trusted-project configuration. Claude uses a runtime settings overlay rather than editing `settings.json`.
- **Doctor cannot reach the service:** confirm the printed long-running start command is still running and that `--endpoint` is the base URL, not `/diagnostics`.
- **A corporate proxy is required:** add `--proxy-env` and review [Proxy environment](operations.md#proxy-environment).

For non-loopback listeners, containers, or gateways, continue with [Deployment](deployment.md).
