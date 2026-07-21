English | [简体中文](product-support.zh-CN.md)

# Product support

## Product definition

copilot-proxy is a local, single-user protocol adapter. It lets trusted clients use one GitHub Copilot identity through OpenAI- and Anthropic-compatible APIs.

One running process intentionally shares one upstream identity, account route, model-catalog snapshot, recovery circuit, concurrency boundary, and diagnostic surface. Selecting the `business` or `enterprise` account type only changes the Copilot upstream route. It does not add downstream users or enterprise controls.

## Deployment support matrix

| Topology | Support | Product boundary |
| --- | --- | --- |
| One trusted user on local loopback | **Supported** | Matches the single-identity design and keeps credentials and state local |
| Private upstream behind an authenticated gateway | **Conditional** | The gateway and network must provide downstream authentication, authorization, limits, and isolation |
| Direct shared team listener | **Unsupported** | The proxy has no downstream user authentication or tenant isolation |
| Public multi-tenant API | **Unsupported** | The proxy has no public-service security boundary, credential isolation, distributed limits, billing, audit, or HA control plane |

Conditional gateway support does not mean that a listener is safe merely because it binds to `0.0.0.0`. The proxy must remain private and reachable only through the authenticated gateway. See [Deployment](deployment.md) for the required boundary.

## Non-goals

copilot-proxy is not intended to become:

- a public hosted inference service;
- a user, API-key, tenant, quota, billing, or audit system;
- a high-availability or distributed control plane;
- an upstream capability oracle based only on OpenAI or Anthropic documentation;
- a compatibility layer that reports success after silently dropping user intent.

A public or independently multi-tenant product would require a separate control-plane architecture, not incremental exposure of this process.

## Related documentation

- [Getting started](getting-started.md): prove a first real response and generate client configuration.
- [Operations](operations.md): presets, model inspection, diagnostics, and native-service lifecycle.
- [Deployment](deployment.md): loopback, Docker, and authenticated private-gateway topologies.
- [Protocol compatibility](protocol-compatibility.md): direct and translated routes, maturity labels, and protocol boundaries.
- [Copilot capability validation](copilot-capability-validation.md): live-probe procedures and semantic validation rules.
