English | [简体中文](README.zh-CN.md)

# Copilot API Proxy

A local, single-user adapter that exposes one GitHub Copilot identity through OpenAI- and Anthropic-compatible APIs for Claude Code, Codex, SDKs, and custom tools.

> [!IMPORTANT]
> copilot-proxy is designed for one trusted user on loopback. Business and enterprise account modes select a Copilot upstream route; they do not add downstream authentication, tenant isolation, audit, billing, or enterprise governance. See [product support](docs/product-support.md) before using a gateway or non-loopback listener.

> [!WARNING]
> This is a reverse-engineered proxy. It is not supported by GitHub and may break when Copilot changes. Excessive automated or bulk use may trigger GitHub abuse controls. Review the [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github) and [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot), and use it responsibly.

## Quick start

Requirements: a GitHub account with an individual, business, or enterprise Copilot subscription; Node.js >= 22.19.0 for a registry release, or Git and Bun >= 1.3.6 for the current source checkout. Running `setup codex` also requires Codex >= 0.134.0 on `PATH`.

From an empty directory, choose either the published package or the current source checkout. To install the registry release globally or run it once without installing:

```sh
npm install --global @jer-y/copilot-proxy@latest
copilot-proxy --help
copilot-proxy start

# One-shot alternative
npx --yes @jer-y/copilot-proxy@latest --help
npx --yes @jer-y/copilot-proxy@latest start
```

The registry's `latest` release can lag this checkout and may not yet expose `setup`, `models`, or `doctor`. Check the selected release's `--help` instead of assuming those commands exist. To use the guided workflow documented below, start from an empty directory and run:

```sh
git clone https://github.com/Jer-y/copilot-proxy.git
cd copilot-proxy
bun install --frozen-lockfile
```

1. Run setup for the client you use. Choose one:

   ```sh
   bun run ./src/main.ts setup claude
   bun run ./src/main.ts setup codex
   bun run ./src/main.ts setup openai-sdk
   ```

   Setup authenticates, selects and probes a direct route, then prints configuration without writing client configuration files. It may update copilot-proxy's own authentication data, but it does not save or launch the generated client profile. HTTP eligibility treats a non-empty live `supported_endpoints` list as authoritative and otherwise may use bundled proxy policy; WebSocket always requires explicit live `ws:/responses`. Those eligibility inputs are not live route or semantic proof—the probe is. Codex has additional installed-version and model-metadata checks; see [Getting started](docs/getting-started.md).

2. Start the proxy in another terminal with the exact command printed by setup. For the default source setup, the equivalent short form is:

   ```sh
   bun run ./src/main.ts start --preset personal
   ```

3. Apply the generated configuration. You can inspect the current catalog or diagnose the running service with:

   ```sh
   bun run ./src/main.ts models --client codex
   bun run ./src/main.ts doctor --client codex
   ```

Replace `codex` with `claude` or `openai-sdk` where appropriate. Configuration safety, non-interactive use, and troubleshooting are covered in [Getting started](docs/getting-started.md).

When the proxy starts, it prints a link to the [hosted diagnostics dashboard](https://jer-y.github.io/copilot-proxy?endpoint=http%3A%2F%2Flocalhost%3A4399%2Fdiagnostics) for the active listener. This is a remote GitHub Pages site: opening it sends the encoded local endpoint in the URL query to that site before your browser reads `/diagnostics`. Use `doctor` or `curl` instead when that endpoint must remain local. See [Operations](docs/operations.md#diagnostics-and-dashboard) for the trust boundary.

## Capabilities

| Area | Summary |
| --- | --- |
| OpenAI-compatible APIs | Chat Completions, Responses over HTTP/SSE, Models, and Embeddings |
| Anthropic-compatible APIs | Messages and token counting, with model-aware direct routing |
| Responses WebSocket | Native transport gated by explicit live `ws:/responses` metadata |
| Routing | Direct routes are preferred; bounded translation is used only where intent can be preserved |
| Operations | Client setup, model inspection, health diagnosis, service management, and a diagnostics dashboard |

Capability availability depends on the current Copilot account, model, endpoint, and transport. Read [Protocol compatibility](docs/protocol-compatibility.md) for contracts and limitations, and [Capability validation](docs/copilot-capability-validation.md) for what to validate, how to run it, and how to interpret the result.

## Product boundary

| Topology | Support |
| --- | --- |
| One trusted user on local loopback | Supported |
| Private backend behind an authenticated gateway | Conditional; the gateway must provide the missing security and governance controls |
| Direct team sharing | Unsupported |
| Public multi-tenant service | Unsupported |

The proxy deliberately keeps one Copilot identity and its runtime state in one process. It is not a multi-tenant gateway. See [Product support](docs/product-support.md) for the full rationale.

## Documentation

Use the [documentation index](docs/README.md) to continue by task. Security boundaries and private vulnerability reporting are documented in the [security policy](SECURITY.md).

## Development

Source development requires Bun >= 1.3.6.

```sh
bun install --frozen-lockfile
bun run dev
bun run build
bun run typecheck
bun run lint
bun test
bun run test:coverage
bun run knip
bun run audit
```

Use the targeted and live validation commands documented in [Capability validation](docs/copilot-capability-validation.md) when changing upstream-gated behavior.

## Acknowledgments

Originally based on [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api); the codebase has since been comprehensively rebuilt.
