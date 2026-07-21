English | [简体中文](deployment.zh-CN.md)

# Deployment

copilot-proxy owns one GitHub Copilot identity and has no downstream user authentication. Choose a topology from the [Product support matrix](product-support.md#deployment-support-matrix) before changing its listener.

## Local loopback

The supported default is one trusted user on loopback:

```sh
copilot-proxy start --preset personal
```

This binds to `127.0.0.1` and applies bounded identity-wide concurrency. Keep credentials and the application data directory private to the operating-system user. A dummy API key generated for a client satisfies client validation only; it is not a security boundary.

Use the `service` preset with the native service when the same private listener must survive terminal and login sessions. See [Operations](operations.md#native-service-management).

## Local Docker

Publish the container port only on host loopback and persist authentication state outside the image:

```sh
docker build -t copilot-proxy .
docker volume create copilot-proxy-data
docker run \
  -p 127.0.0.1:4399:4399 \
  -v copilot-proxy-data:/home/bun/.local/share/copilot-proxy \
  copilot-proxy start --preset personal --host 0.0.0.0
```

The process binds to all interfaces inside the container so Docker can forward traffic, while the host publishes it only on loopback. Do not change the host-side mapping to `0.0.0.0:4399` for direct sharing.

## Authenticated private gateway

The conditionally supported shared topology is:

```text
Clients -> authenticated gateway -> private copilot-proxy -> GitHub Copilot
```

The gateway must own users, API keys, authorization, per-user quota, model permissions, audit, billing, and downstream limits. copilot-proxy remains a single-identity private upstream.

Set a comma-separated allowlist containing the exact non-loopback Host value used on the gateway's private hop, then start the private backend:

```sh
export COPILOT_PROXY_ALLOWED_HOSTS=proxy.internal
copilot-proxy start --preset gateway-upstream
```

The preset fails closed unless the whole allowlist is valid and contains at least one non-loopback hostname or IP address. Schemes, ports, paths, wildcards, empty entries, and a loopback-only list are invalid. Hostnames are matched after normalization; the gateway must actually send one of the listed values in the HTTP `Host` header. If it uses more than one internal name, list each one explicitly.

The deployment must also:

- restrict the network so only the gateway can reach copilot-proxy;
- authenticate and authorize every external client at the gateway;
- terminate TLS at a trusted boundary and protect the private hop as required by the environment;
- keep per-user limits at the gateway and an identity-wide final limit in copilot-proxy;
- avoid retry storms: do not retry upstream `403` or `429` blindly, and honor the proxy's local circuit-open `503`, `Retry-After`, and `X-Copilot-Proxy-Recovery-State` response;
- preserve required client protocol and model-catalog query behavior;
- prevent untrusted access to diagnostics and token-related surfaces;
- own logging, audit retention, incident response, updates, backups, and availability objectives.

If any of those controls are absent, the result is unsupported direct sharing rather than a supported private gateway.

The same circuit state appears on `/readyz`: a globally open recovery circuit makes readiness return `503` with `Retry-After`. Gateways should propagate or respect that backoff rather than restarting the proxy or switching identities/endpoints in a loop.

## Listener and browser security

- Keep `COPILOT_PROXY_EXPOSE_TOKEN` unset. `/token` is disabled by default and is not an authentication endpoint. If this variable is included in a native-service environment, it remains enabled across restarts until the persisted setting is removed.
- Add exact non-local browser origins to `COPILOT_PROXY_CORS_ORIGINS` only when they are required.
- Add exact non-loopback request hostnames to `COPILOT_PROXY_ALLOWED_HOSTS`; do not use it as a substitute for authentication.
- Never persist `--show-token` output in shared logs.
- Do not use interactive `--manual` approval in a background service.
- Treat `/diagnostics` and the hosted dashboard as visibility tools, not access-control surfaces.

Runtime presets and service lifecycle are documented in [Operations](operations.md). Protocol behavior does not change because a gateway is present; see [Protocol compatibility](protocol-compatibility.md). Review the [Security policy](../SECURITY.md) before exposing any listener.
