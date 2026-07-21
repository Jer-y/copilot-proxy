English | [简体中文](operations.zh-CN.md)

# Operations

This page covers runtime selection, inspection, diagnostics, and service lifecycle. Network exposure and gateway requirements live in [Deployment](deployment.md). The `setup`, `models`, and `doctor` examples describe the current source tree and any published package whose own `--help` lists those commands; an older published release may not include them. From source, replace the leading `copilot-proxy` with `bun run ./src/main.ts`.

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

Plain `start` defaults to `custom`, preserving the unbounded behavior of releases that predate presets. Setup prints an explicit `--preset personal` command for new local configurations. Existing native services and commands with concurrency flags also remain `custom`; only an explicit `--preset` opts into preset values. The limiter is identity-wide and holds a lease until the upstream response body or stream finishes or is cancelled.

`gateway-upstream` is a deployment contract, not permission to expose the service publicly. It also requires `COPILOT_PROXY_ALLOWED_HOSTS`; see [Authenticated private gateway](deployment.md#authenticated-private-gateway).

## Model inspection

```sh
copilot-proxy models --client all
copilot-proxy models --client claude
copilot-proxy models --client codex --json
copilot-proxy models --client openai-sdk
```

The command authenticates and reads the current model catalog for the selected `--account-type`. Its table shows both `direct` and bounded `translated` routes, plus maturity, limits, and selected feature flags; JSON adds compact route source, target, and reason-code fields. Setup is stricter: it configures only a current **direct** route. Entries with `model_picker_enabled=false` are omitted from both `models` and diagnostics.

`models` and setup share that picker-enabled, live-route visibility baseline, but not necessarily the same candidates. `setup codex` also requires installed Codex 0.134.0 or newer and intersects direct Responses candidates with bundled entries that have usable `base_instructions` and `context_window` metadata. Because `models --client codex` does not inspect that local bundled catalog, it may show transport-specific or metadata-missing models that setup cannot configure on the current machine. The compatibility-oriented `/v1/models` response remains a separate client contract. Releases that provide `models` also include the relative documentation path returned by `models --json` in the npm package and Docker image.

These values describe current routing eligibility, not universal semantic support. Route definitions are in [Protocol compatibility](protocol-compatibility.md); live validation procedures are in [Copilot capability validation](copilot-capability-validation.md).

## Doctor

```sh
copilot-proxy doctor \
  --endpoint http://127.0.0.1:4399 \
  --client all
```

Doctor checks reachability, readiness, token lifecycle, recovery state, concurrency, model availability, client candidates, and usage availability. Pass the service base URL rather than the `/diagnostics` path. Use `--client claude`, `codex`, or `openai-sdk` to narrow model checks and `--json` for automation. Each diagnostics request has a 10-second deadline by default; use `--timeout-ms <ms>` to select another positive bounded deadline.

A failed check produces a nonzero exit status. When an older server has no `/diagnostics` endpoint, doctor labels its fallback result as legacy and partial rather than treating it as complete evidence.

## Diagnostics and dashboard

| Surface | Purpose |
| --- | --- |
| `GET /livez` | Process liveness only |
| `GET /readyz` | Passive readiness for authentication, model state, recovery, and concurrency |
| `GET /diagnostics` | Combined runtime, compact model-route, and usage snapshot; may fill the usage cache |

```sh
curl http://127.0.0.1:4399/diagnostics
```

`/diagnostics` does not refresh credentials or run a model probe, but it is not guaranteed to be upstream-passive: on a usage-cache miss it may fetch current quota data and update the short-lived usage cache. It omits bearer tokens, prompts, and downstream user keys. Use `/readyz` when a strictly passive readiness check is required.

If a scheduled model-catalog refresh fails, the proxy retains the last successful snapshot for existing request routing instead of clearing it. `/readyz` stays operationally ready while adding a `model_catalog_stale` warning and catalog lifecycle timestamps; `/diagnostics`, the dashboard, and `doctor` surface that warning as a degraded or advisory state until a later refresh succeeds. The dashboard labels the retained model matrix as stale rather than treating the diagnostics document time as the catalog refresh time. A missing catalog remains a hard readiness failure.

For the default listener, you can open the [hosted diagnostics dashboard](https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2Flocalhost%3A4399%2Fdiagnostics). `start` prints the matching hosted URL for the active listener, with its `/diagnostics` endpoint encoded in the `endpoint` query parameter; the Windows development launcher opens that URL only after its exact server instance is ready. The raw `/diagnostics` route is a JSON API, not an HTML dashboard.

The hosted dashboard is a separate remote GitHub Pages origin, not part of the local proxy trust boundary. Opening its URL sends the full `endpoint` query parameter to GitHub Pages and can retain that URL in browser history or infrastructure logs; the page then asks the browser to fetch the local diagnostics endpoint. Do not open the hosted page if revealing the endpoint hostname is unacceptable. Never put credentials or other secrets in that URL. Use local `curl`, `doctor`, or a locally hosted copy of the dashboard instead.

A dashboard deployment that matches the proxy revision provides the complete runtime, model-route, and quota view. The separately deployed dashboard also preserves legacy CLI links whose `endpoint` points to `/usage`, but that compatibility mode displays only the minimal quota summary and explicitly does not claim readiness, authentication, recovery, concurrency, or model-routing state. Other dashboard schema compatibility requires a matching proxy revision. The dashboard performs read-only GET requests and has no administration or authentication controls, but refreshing it can trigger the same usage-cache fill described above.

The dashboard accepts only exact `/diagnostics` or legacy `/usage` endpoint paths, with an optional trailing slash and no URL credentials, query, or fragment. It omits browser credentials from these requests and refuses redirects rather than following them.

Chrome 142 and later may gate requests from the hosted HTTPS dashboard to `localhost` behind [Local Network Access](https://developer.chrome.com/blog/local-network-access). If the dashboard reports that local network access is blocked, allow local network access for the dashboard origin in the browser's site settings, then retry. The dashboard shows this permission-specific guidance only when the browser exposes a matching Permissions API state as `denied`; unsupported permission descriptors, undecided permission prompts, and ordinary connection failures keep the generic reachability message. You can use `curl` or `copilot-proxy doctor` to verify the proxy independently of browser permissions.

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

`enable` installs foreground `start` under systemd, launchd, or Task Scheduler. A new installation defaults to the `service` preset. Configure a fresh service directly instead of creating a legacy daemon first, for example:

```sh
copilot-proxy enable --account-type business --port 4400 --proxy-env
```

Use `--host` only with the matching `COPILOT_PROXY_ALLOWED_HOSTS` deployment boundary described in [API and configuration reference](api-reference.md). `enable` also accepts the service-safe rate-limit, wait-policy, verbose, concurrency, and upstream-timeout options shown by `enable --help`; clear options remove persisted rate-limit, timeout, concurrency, or proxy choices. Re-running `enable` preserves installed settings unless the corresponding option is explicitly supplied. Services from releases whose install state did not yet store concurrency remain unbounded rather than being silently migrated to a preset. Persist another choice with `enable --preset personal|service|gateway-upstream|custom`.

Use `restart`, `stop`, and `disable` for the remaining lifecycle operations.

## Legacy daemon migration

The app-managed `start -d` path is deprecated and retained only for migration. Move to the native service:

```sh
copilot-proxy stop
npm i -g @jer-y/copilot-proxy@latest
copilot-proxy enable
copilot-proxy status
```

After migration, use `status`, `logs`, `restart`, and `stop`. Do not build new automation around daemon PID or log files.

## Proxy environment

Ambient `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` values are not automatically trusted. Add `--proxy-env` when a command must use the configured proxy route:

```sh
copilot-proxy start --proxy-env
copilot-proxy enable --proxy-env
copilot-proxy models --client all --proxy-env
copilot-proxy doctor --endpoint https://proxy.internal --proxy-env
```

`--proxy-env` is an explicit egress policy and fails closed when it cannot establish a usable proxy route. Proxy URLs may embed usernames or passwords. Native-service configuration persists the choice and relevant proxy/TLS environment in owner-only state, so treat that state and any copied proxy URL as credentials. Use `--proxy-env` only for infrastructure you trust.

Before sharing setup output, logs, `debug --json`, diagnostics snapshots, or shell commands, remove tokens, API keys, authenticated proxy URLs, internal endpoints, usernames, and local filesystem paths. Local output is intended for its owner; redaction at logging boundaries does not make every diagnostic artifact safe to publish. See the [Security policy](../SECURITY.md).

For the complete current command and option list, use `copilot-proxy --help` and `copilot-proxy <command> --help`. Route and security settings are summarized in [API and configuration reference](api-reference.md).
