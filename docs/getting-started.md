English | [简体中文](getting-started.zh-CN.md)

# Getting started

The setup flow consists of three steps: install the proxy, run `setup` to probe upstream support and generate client configuration, and start the local proxy before validating with a live request. For non-loopback network environments, read [Deployment](deployment.md) first.

## Requirements

- An active individual, business, or enterprise Copilot subscription and a free local port (default `4399`).
- Node.js >= 22.19.0 for the package; Git and Bun >= 1.3.6 for source development.
- Codex >= 0.134.0 on `PATH` for `setup codex`. Claude Code or an SDK application is needed when applying and testing its configuration.

## 1. Choose an installation path

These instructions describe their source revision. For a published package, use its bundled documentation and `--help`; keep all CLI commands on the same version. Before upgrading, read the [upgrade checklist](operations.md#upgrade-changes-after-v0100).

### Global package

```sh
npm install --global @jer-y/copilot-proxy@latest
copilot-proxy --help
```

### One-shot package

```sh
npx --yes @jer-y/copilot-proxy@latest --help
npx --yes @jer-y/copilot-proxy@latest setup claude
```

For subsequent commands, replace `copilot-proxy` with `npx --yes @jer-y/copilot-proxy@<version>`, using the published version selected above.

### Source checkout

```sh
git clone https://github.com/Jer-y/copilot-proxy.git
cd copilot-proxy
bun install --frozen-lockfile
```

Replace `copilot-proxy` below with `bun run ./src/main.ts` when using this checkout. Do not mix source setup with another installed version.

## 2. Validate the proxy route with setup

```sh
copilot-proxy setup claude
# Or: copilot-proxy setup codex / copilot-proxy setup openai-sdk
```

Setup may update the proxy's authentication data, but only prints client configuration: it does not save client files or launch the client. It selects a [catalog-eligible native route](protocol-compatibility.md#dynamic-model-catalog) and probes upstream connectivity through a temporary loopback listener.

- Claude and Codex require completed streaming output; OpenAI SDK setup checks the selected JSON route. A distinct Claude `--small-model` is probed separately.
- Probe timeouts or output/shutdown limits mean validation is incomplete, not that a capability is unsupported. If only the Codex WebSocket probe fails, setup retains the independently validated HTTP/SSE profile with `supports_websockets = false`.
- `setup codex` checks the installed version and usable bundled model metadata before authentication. Interactive choices and explicit `--model` use the same gate. Pass `--model <model-id>` for non-interactive use, including `--json`.
- Setup accepts `personal`, `service`, and `custom` presets on `localhost`, `127/8`, or `::1`. Wildcards, `.localhost` subdomains, scoped IPv6, and non-loopback hosts fail before authentication; `gateway-upstream` is not a setup preset.
- `--copy` explicitly copies output and cannot be combined with `--json`. Use `--shell bash|zsh|fish|powershell|pwsh|cmd|sh` if a launcher hides your shell; npm `.cmd` launchers are traced back to PowerShell when possible. Other options: `copilot-proxy setup --help`.

### Apply the generated configuration

| Client | What to do |
| --- | --- |
| Claude Code | Run the printed command with its `--settings` overlay; existing `settings.json` is not edited or selected for conflicting environment values. |
| Codex | Save the printed TOML at `copilot-proxy-home/copilot-proxy.config.toml` under the resolved normal Codex home (`CODEX_HOME`, otherwise the platform `.codex` directory); use the printed `--profile copilot-proxy` launch command. |
| OpenAI SDK | Apply the printed `OPENAI_BASE_URL`, dummy local API key, model, and native API family. The dummy key is not downstream authentication. |

Claude models advertising a 1M window use the `[1m]` client selector; proxy probes and upstream requests retain the base model ID. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` disables that client mode.

The Codex launch command uses a dedicated child `CODEX_HOME` and non-secret command-backed auth. Keep that child's `config.toml` absent and do not append the profile to your normal config. System and trusted-project settings may still override it; see [troubleshooting](#troubleshooting).

## 3. Start the long-running proxy

In another terminal, use the exact command printed by setup. The default local command is:

```sh
copilot-proxy start --preset personal
```

Keep it running while you apply the configuration and launch the client. For a background service, use [Native service management](operations.md#native-service-management). Retired start options are covered in the [upgrade checklist](operations.md#upgrade-changes-after-v0100).

### Verify the client

Setup's route probe is not a client smoke: it neither runs the generated Codex profile nor invokes the local Claude binary. Complete a real turn after applying the configuration.

For Codex, check for `Codex model catalog response: client_version=<installed-version> status=200` in proxy logs, followed by completed `POST /v1/responses` or forwarded and completed `response.create`. Neither `auth cannot be combined with env_key` nor metadata fallback should appear. The generic request log omits query values. Maintainer tool-loop procedures are in [Capability validation](copilot-capability-validation.md#real-codex-cli).

## 4. Inspect models and diagnose the service

```sh
copilot-proxy models --client all
copilot-proxy doctor --endpoint http://127.0.0.1:4399 --client all
```

Use `--client claude|codex|openai-sdk` to narrow either view and `--json` for automation. Doctor needs a running service and exits nonzero on required failures. Account selection and catalog interpretation are in [Model inspection](operations.md#model-inspection).

## Troubleshooting

| Symptom | Action |
| --- | --- |
| No compatible model | Run `copilot-proxy models --client <client> --json` for the same account. Check [native route eligibility](protocol-compatibility.md#dynamic-model-catalog). |
| Port in use | Choose another `--port` for setup and start, or stop the intended listener. |
| Setup rejects a non-loopback host | Validate on loopback; configure remote access separately under [Deployment](deployment.md). |
| Wrong Codex catalog or conflicting auth | Use only the generated child-home profile. Check system/project `model_catalog_json` and `[model_providers.copilot-proxy]` overrides; remove conflicting definitions from the configuration you control. |
| Doctor cannot reach the service | Check that the proxy is running and `--endpoint` is the base URL, not the `/diagnostics` path. |
| Corporate proxy required | Add `--proxy-env`; follow [Proxy environment](operations.md#proxy-environment). |
