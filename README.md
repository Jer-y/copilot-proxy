English | [简体中文](README.zh-CN.md)

# Copilot API Proxy

A local reverse proxy that exposes one or more owner-configured GitHub Copilot identities through standard OpenAI- and Anthropic-compatible API endpoints.

> [!WARNING]
> Unofficial and reverse-engineered; Copilot changes may break it, and excessive automation may trigger abuse controls. Review the [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github) and [Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot).
>
> Use loopback for one trusted user. There is no downstream user authentication; remote access requires an [authenticated private gateway](docs/deployment.md#authenticated-private-gateway).

## Quick start

Requires a Copilot subscription and Node.js >= 22.19.0. For `setup codex`, install Codex >= 0.134.0 on `PATH`.

```sh
npm install --global @jer-y/copilot-proxy@latest
copilot-proxy setup claude
```

Replace `claude` with `codex` or `openai-sdk` as needed. Setup may update copilot-proxy's own authentication data; it prints configuration without writing client configuration files or launching the client.

1. Start the proxy in another terminal using the exact command printed by setup.
2. Apply the printed client configuration yourself, then run the client.
3. Check the running service with `copilot-proxy doctor`.

This document describes its revision; use bundled documentation for a published package and keep CLI commands on the same version. For npx, source installation, or troubleshooting, see [Getting started](docs/getting-started.md). Existing users should read the [upgrade checklist](docs/operations.md#upgrade-changes-after-v0100).

## Capabilities

- OpenAI-compatible Chat Completions, Responses HTTP/SSE, Models, and Embeddings.
- Anthropic-compatible Messages and token counting.
- Native Responses WebSocket when advertised by the selected model.
- Deterministic multi-account routing, client setup, diagnostics, and native services.

Only native protocols are supported: no cross-protocol translation (e.g. converting between Messages and Responses), account load balancing, or automatic failover. Availability depends on the account, model, endpoint, and transport; see [Protocol compatibility](docs/protocol-compatibility.md).

## Documentation

Use the [task index](docs/README.md) for accounts, deployment, upgrades, API details, and the Dashboard. Read [Product support](docs/product-support.md) for supported topologies and [Security](SECURITY.md) before exposing a listener or sharing diagnostics.

## Development

Source development requires Git and Bun >= 1.3.6. Follow [source installation](docs/getting-started.md#source-checkout), then `bun run dev`. Build and test commands are maintained in [Local validation](docs/copilot-capability-validation.md#local-validation).

## Acknowledgments

Originally based on [ericc-ch/copilot-api](https://github.com/ericc-ch/copilot-api); the codebase has since been comprehensively rebuilt.
