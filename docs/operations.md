English | [简体中文](operations.zh-CN.md)

# Operations

Commands below use the installed `copilot-proxy`; for source, use `bun run ./src/main.ts`. Follow the [installation/version guidance](getting-started.md#1-choose-an-installation-path) and [deployment requirements](deployment.md) for your environment.

## Runtime presets

| Preset | Defaults | Intended use |
| --- | --- | --- |
| `personal` | `127.0.0.1`; concurrency 2; queue 8; 30-second wait | Recommended foreground preset and setup default for one local user |
| `service` | `127.0.0.1`; concurrency 4; queue 32; 30-second wait | Long-running private local service |
| `gateway-upstream` | `0.0.0.0`; concurrency 4; queue 50; 30-second wait | Private backend reachable only through an authenticated gateway |
| `custom` | `127.0.0.1`; no concurrency limit by default | Expert-owned host and limiter values |

```sh
copilot-proxy start
copilot-proxy start --preset service
copilot-proxy start --preset custom --max-concurrency 3 --max-queue 10
```

Plain `start` defaults to `custom`, preserving the unbounded behavior of releases that predate presets. Setup prints an explicit `--preset personal` command for new local configurations. Existing native services and commands with concurrency flags also remain `custom`; only an explicit `--preset` opts into preset values. The global limiter holds a lease until the upstream response body or stream finishes or is cancelled. When an account also has `maxConcurrency`, its account lease is acquired before the global lease so one busy account cannot occupy global capacity while waiting for its own slot.

`gateway-upstream` is a deployment contract, not permission to expose the service publicly. It also requires `COPILOT_PROXY_ALLOWED_HOSTS`; see [Authenticated private gateway](deployment.md#authenticated-private-gateway).

## Multiple Copilot accounts

Multi-account mode is for one trusted operator who owns several GitHub Copilot identities. It is deterministic routing, not multi-tenancy, load balancing, quota pooling, or automatic failover.

Before the first `accounts` mutation after upgrading from a build without multi-account runtime locks, stop or restart every foreground proxy that was launched by the older build. Installed native services are detected and restarted transactionally, but an older foreground process cannot publish `runtime.lock`; leaving it running would keep serving its old in-memory single-account state.

```sh
# Device flow
copilot-proxy accounts add personal --account-type individual
copilot-proxy accounts add work --account-type enterprise

# Or provide an existing token without putting it in argv
printf '%s\n' "$TOKEN" | copilot-proxy accounts auth work --token-stdin --yes

copilot-proxy accounts default personal --yes
copilot-proxy accounts route set 'claude-*' work --yes
copilot-proxy accounts route set 'gpt-5*' personal --yes
copilot-proxy accounts list
copilot-proxy accounts route list

# Optional per-account concurrency and required startup/readiness routes
copilot-proxy accounts concurrency set work 2 --yes
copilot-proxy accounts required-route set responses-http gpt-5.4 --yes
copilot-proxy accounts required-route list
```

`accounts.json` and `tokens/<account-id>` live in the normal owner-only data directory. Account IDs are lowercase, at most 32 characters, and limited to letters, digits, `_`, and `-`. At most eight accounts are accepted. `--token-stdin` reads at most 8 KiB, removes one final newline, and rejects empty or whitespace-bearing input. When `accounts.json` exists, the early `--github-token` bootstrap is rejected; use `accounts auth <id>` instead.

`accounts concurrency set <id> <max>` stores a positive account-specific `maxConcurrency`; `accounts concurrency clear <id>` removes that narrower limiter. If it is absent, the account has no separate limiter but still participates in any configured global limiter. The account-specific limiter uses the bounded default queue of 50 requests and a 30-second wait.

`accounts required-route set <surface> <model>` makes the selected model route a startup and readiness requirement; it does not add fallback or account switching. Supported surfaces are `responses-http`, `responses-websocket`, `anthropic-messages`, `chat-completions`, and `embeddings`. The model's normal static route selects the account, and the set operation validates the resulting required-route capabilities before committing. Use the exact pair with `accounts required-route remove <surface> <model>`, and inspect the configured gates with `accounts required-route list [--json]`.

Request selection order is:

1. An already pinned Responses WebSocket account.
2. `x-copilot-account: <id>`.
3. A `<account-id>/<model-id>` model prefix.
4. The first matching `accounts.json` route glob.
5. `defaultAccount`.

Selectors that disagree return `409`. An unavailable statically bound account returns `503`; the proxy does not scan another account. Responses WebSocket selects on the first `response.create` unless the Upgrade request already supplied `x-copilot-account`, then remains pinned for the connection.

`GET /readyz?account=<id>` checks one account. The ordinary `/readyz` response includes safe per-account availability, identity verification state, token/recovery state, and global/per-account concurrency. GitHub login and numeric user ID remain hidden from HTTP responses unless `COPILOT_PROXY_EXPOSE_ACCOUNT_IDENTITY=1` (or foreground `start --expose-account-identity`) is explicitly enabled. `COPILOT_PROXY_EXPOSE_ACCOUNT_MODELS=1` or `start --expose-account-models` adds `<account>/<model>` aliases only to non-Codex model-list requests.

Account, route, concurrency, and required-route writes use an owner-only lock and atomic files. If a native service is running, the CLI restarts it, probes the affected account and overall readiness, and rolls disk state back on failure. A foreground proxy using the same data directory must be stopped first. When a native service uses a custom data directory, `accounts` and `auth --account` target that installed directory by default; set `COPILOT_PROXY_DATA_DIR` explicitly to manage a separate instance. A second proxy process cannot use the same data directory.

## Model inspection

```sh
copilot-proxy models --client all
copilot-proxy models --account work --client codex --json
copilot-proxy check-usage --account work
```

With `accounts.json`, both commands default to `defaultAccount`; `--account <id>` selects another account. They verify its persisted token against the recorded numeric GitHub identity, never falling back to the legacy `github_token` or Device Flow. Without that file, `models --account-type` and single-account authentication retain their meaning.

`models` shows the selected account's live catalog, including models reachable only by explicit account selection, not just its unprefixed route bindings. Use `--client claude|codex|openai-sdk` to filter; output includes direct/unsupported routes, maturity, limits, and feature flags. JSON also includes account ID/type, route source/reason codes, and a documentation path shipped in npm and Docker. Both models and diagnostics omit `model_picker_enabled=false`.

Setup shares the native-route baseline but `setup codex` additionally checks installed bundled `base_instructions` and `context_window` metadata. Thus `models --client codex` can list models setup cannot configure. The HTTP `/v1/models` catalog separately applies account-route bindings and [Codex transport filtering](protocol-compatibility.md#responses-over-websocket); it is not a static model table. Catalog eligibility is not proof of feature semantics.

## Doctor

```sh
copilot-proxy doctor --endpoint http://127.0.0.1:4399 --client all
```

- Pass the service base URL, not `/diagnostics`. Doctor checks readiness, token lifecycle, recovery, concurrency, client model availability, and usage.
- Use `--client claude|codex|openai-sdk` and `--json` as needed. The default deadline is 10 seconds; `--timeout-ms <ms>` accepts a positive bounded override.
- A required failure gives a nonzero exit. Missing `/diagnostics` (`404`) gives exit `1`, without falling back to other endpoints. Check the base URL/reverse proxy or upgrade the server. JSON `mode: "full"` describes the report format, not success.

## Diagnostics and dashboard

| Surface | Purpose |
| --- | --- |
| `GET /livez` | Process liveness only |
| `GET /readyz` | Passive readiness for authentication, model state, recovery, and concurrency |
| `GET /diagnostics` | Combined runtime, model-route, and usage snapshot |

```sh
curl http://127.0.0.1:4399/diagnostics
```

`/diagnostics` omits credentials and prompts. It does not refresh tokens or probe models, but a usage-cache miss can fetch upstream quota data. Use `/readyz` for a strictly passive check. These and `/v1/models` and `/usage` remain independent endpoints.

A failed model-catalog refresh retains the last valid snapshot: `/readyz` stays ready with `model_catalog_stale` and lifecycle timestamps; diagnostics, doctor, and the dashboard show a warning/degraded view until refresh succeeds. The dashboard uses catalog freshness, not the diagnostics document timestamp. A missing catalog is a hard readiness failure.

Open the [hosted diagnostics dashboard](https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2Flocalhost%3A4399%2Fdiagnostics), or the listener-specific URL printed by `start`. The Windows launcher opens it only after its own instance is ready. `/diagnostics` itself is a JSON API, not an HTML dashboard.

The hosted page sends your endpoint URL to GitHub Pages and reads diagnostics in the browser. Never include secrets in its URL; use local `doctor`/`curl` or a self-hosted copy when that disclosure is unacceptable. See [Diagnostics privacy](../SECURITY.md#diagnostics-privacy).

- Use a dashboard matching the proxy revision. It only performs GETs, has no administration/authentication controls, and can trigger the usage-cache fill above.
- Endpoint URLs must have exactly `/diagnostics` (optional trailing slash), with no credentials, query, or fragment. Requests omit browser credentials and reject redirects. See the [upgrade checklist](#upgrade-changes-after-v0100) for old links.
- Chrome 142+ may require [Local Network Access](https://developer.chrome.com/blog/local-network-access). Allow it for the dashboard origin if explicitly reported as blocked. That guidance appears only for a matching Permissions API `denied` state; unsupported/pending permissions or ordinary failures use generic reachability guidance. Verify independently with local doctor or curl.

## Native service management

Install from a stable global path or use a stable source checkout. Ephemeral package-runner cache paths are unsuitable for a boot service.

```sh
npm i -g @jer-y/copilot-proxy
copilot-proxy auth

# Linux only, when logged-out startup requires lingering
sudo loginctl enable-linger "$USER"

copilot-proxy enable
copilot-proxy status
copilot-proxy logs -f
```

`enable` installs foreground `start` under systemd, launchd, or Task Scheduler. A new installation defaults to the `service` preset. Configure a fresh service directly, for example:

```sh
copilot-proxy enable --account-type business --port 4400 --proxy-env
```

Use `--host` only with the matching `COPILOT_PROXY_ALLOWED_HOSTS` deployment boundary described in [API and configuration reference](api-reference.md). `enable` also accepts the service-safe rate-limit, wait-policy, verbose, concurrency, and upstream-timeout options shown by `enable --help`; clear options remove persisted rate-limit, timeout, concurrency, or proxy choices. Re-running `enable` preserves installed settings unless the corresponding option is explicitly supplied. Services from releases whose install state did not yet store concurrency remain unbounded rather than being silently migrated to a preset. Persist another choice with `enable --preset personal|service|gateway-upstream|custom`.

Use `restart`, `stop`, and `disable` for the remaining lifecycle operations.

## Upgrade changes after v0.10.0

Changes below compare v0.10.0 with this source revision, not an announcement of publication. Check the target package's bundled documentation before upgrading; existing account files and credentials are not reset.

| Change | What to do |
| --- | --- |
| Messages ↔ Responses translation removed | Select a model supporting the client's native API; incompatible pairs fail locally. See [protocol migration](protocol-compatibility.md#migration-from-cross-protocol-routing). |
| Static model/capability fallback removed | Use `copilot-proxy models --client all --json` (`--account <id>` for explicit accounts); resolve authentication/catalog failures. See [dynamic catalogs](protocol-compatibility.md#dynamic-model-catalog). |
| `--manual` and saved `manual: true` rejected | Remove the option or set `manual: false` only after accepting unattended forwarding; there is no per-request approval. |
| `start --claude-code` / `start -c` removed | Run `copilot-proxy setup claude` and follow its output; add `--copy` only if needed. See [setup](getting-started.md#2-validate-the-proxy-route-with-setup). |
| Doctor requires `/diagnostics` | Check the base URL/reverse proxy or upgrade the server; there is no old multi-endpoint fallback. See [Doctor](#doctor). |
| Plaintext diagnostics retired: `/token`, `--show-token`, `COPILOT_PROXY_EXPOSE_TOKEN`, `showToken` | Remove retired options/settings; use `doctor` or `/diagnostics`, not token output. See [API reference](api-reference.md#routes) and saved-setting behavior below. |
| Hosted Dashboard rejects `/usage` links | Change the endpoint path to `/diagnostics`; the server `/usage` API remains available. See [Dashboard](#diagnostics-and-dashboard). |
| Local token usage estimates removed | Treat absent upstream usage as unavailable; see [Usage](protocol-compatibility.md#usage). |
| General Anthropic `document.source` adaptation removed | Send local text as text or `tool_result`; follow the [document boundary](api-reference.md#claude-code-document-boundary) for PDFs and token counting. |

The retired `--manual`, `--show-token`, and `start --claude-code`/`-c` options fail before authentication or token persistence. Saved settings: legacy `manual: false` remains readable; `manual: true` fails. Historical `showToken` booleans are discarded, with warnings for enabled values; the retired environment option is ignored and warns when enabled. Reads do not rewrite files; the next normal save omits retired fields.

After reviewing launch arguments, service settings, and client configuration, run `copilot-proxy models --client <client> --json`, `copilot-proxy doctor --endpoint <base-url> --client <client>`, and a real client turn. Substitute your client/base URL; from source use `bun run ./src/main.ts`. Catalog and health checks do not replace a real request or tool loop. Older services also need the [pre-v0.10.0 migration](#upgrade-from-pre-v0100-installations).

## Upgrade from pre-v0.10.0 installations

Before upgrading from a release that still supported the app-managed daemon or an older native-service state, first move to the final migration-capable release and refresh the native service state:

```sh
npm i -g @jer-y/copilot-proxy@0.9.3
copilot-proxy enable
copilot-proxy status
npm i -g @jer-y/copilot-proxy@0.10.0
copilot-proxy restart
copilot-proxy status
```

`v0.10.0` no longer runs `start -d` or uses daemon PID files. The v0.9.3 `enable` step above persists the complete native-service control state before the old runtime is removed. If v0.10.0 was installed first, `enable` and `restart` accept a validated `daemon.json` only as a migration fallback when that control state lacks its config; run `enable` to persist the migrated config. Afterwards, use only `enable`, `status`, `logs`, `restart`, `stop`, and `disable`.

## Proxy environment

Ambient proxy variables are ignored unless the command opts in with `--proxy-env`:

```sh
copilot-proxy start --proxy-env
copilot-proxy enable --proxy-env
copilot-proxy accounts add work --account-type enterprise --proxy-env
copilot-proxy accounts auth work --proxy-env
copilot-proxy models --client all --proxy-env
copilot-proxy doctor --endpoint https://proxy.internal --proxy-env
```

Opt-in uses `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` and fails closed if a usable proxy route cannot be established. Account add/auth perform their own identity, token, and catalog checks: a native service's saved proxy choice does not opt those CLI commands in.

Service configuration persists proxy/TLS settings in owner-only files. Treat those files and authenticated proxy URLs as credentials; use only trusted infrastructure and follow [Security](../SECURITY.md) before sharing output.

For all options, use `copilot-proxy <command> --help`; route and environment fields are listed in [API reference](api-reference.md).
