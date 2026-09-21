English | [简体中文](product-support.zh-CN.md)

# Product support

## Product definition

copilot-proxy is a local protocol adapter for one trusted operator, exposing one or more owner-configured GitHub Copilot identities through standard OpenAI- and Anthropic-compatible APIs.

A single process manages its local data directory, network listener, runtime diagnostics, and optional global concurrency limiter. Each configured Copilot identity independently maintains its access token, dynamic model catalog, circuit-breaker recovery state, account type, and optional account-level concurrency limiter. Incoming requests are routed deterministically to a specific account; if the target account is unavailable, the request fails immediately without load balancing or automatic failover. The proxy provides no downstream multi-tenant isolation, user authentication, or enterprise governance.

## Deployment support matrix

| Topology | Support | Product boundary |
| --- | --- | --- |
| One trusted user on local loopback | **Supported** | Matches the single-operator design and keeps credentials and state local |
| Private upstream behind an authenticated gateway | **Conditional** | The gateway and network must provide downstream authentication, authorization, limits, and isolation |
| Direct shared team listener | **Unsupported** | The proxy has no downstream user authentication or tenant isolation |
| Public multi-tenant API | **Unsupported** | The proxy has no public-service security boundary, credential isolation, distributed limits, billing, audit, or HA control plane |

Conditional gateway support does not mean that a listener is safe merely because it binds to `0.0.0.0`. The proxy must remain private and reachable only through the authenticated gateway. See [Deployment](deployment.md) for the required boundary.

## Non-goals

Public inference hosting, downstream user/API-key/tenant/quota/billing/audit systems, and HA or distributed control planes require a separate architecture, not exposure of this process.

The proxy is neither an upstream capability oracle based on provider documentation alone nor a compatibility layer that silently drops intent and reports success.

## Related documentation

Continue with [Getting started](getting-started.md), [Operations](operations.md), or [Deployment](deployment.md). Other tasks are in the [documentation index](README.md).
