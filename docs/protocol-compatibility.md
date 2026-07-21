English | [简体中文](protocol-compatibility.zh-CN.md)

# Protocol compatibility

copilot-proxy treats the client-facing protocol and the Copilot upstream protocol as separate contracts. A route is enabled only when the current model has a direct backend or the request can be translated without manufacturing a misleading success.

## Route modes

| Mode | Meaning |
| --- | --- |
| `direct` | The client and Copilot sides use the same protocol family; the proxy forwards with bounded compatibility sanitization |
| `translated` | The proxy converts between OpenAI Responses and Anthropic Messages, subject to request-level fidelity checks |
| `unsupported` | No faithful route exists, so the request is rejected locally |

Chat Completions is direct-only and is never used as a fallback for Responses or Messages. Embeddings is also a direct route. Responses WebSocket is transport-specific and never translated.

## Maturity labels

| Label | Product meaning |
| --- | --- |
| `stable` | A non-preview model's current catalog advertises a direct HTTP route |
| `conditional` | A bounded translation (including for preview models) or bundled routing fallback requires request- and model-specific verification |
| `experimental` | A preview model's catalog-advertised direct route or a native Responses WebSocket route may change quickly |
| `unsupported` | No direct or faithful translated route is available |

These labels classify routing eligibility. They do not guarantee that every field, tool, stop condition, or output semantic works for a model.

Preview status changes a catalog-advertised direct HTTP route from `stable` to `experimental`. It does not change a bounded translation from `conditional`; native Responses WebSocket routes are always `experimental`.

## Responses over HTTP and SSE

`POST /v1/responses` remains available independently from WebSocket. A model with a direct Responses endpoint uses that endpoint. A Messages-backed model may use the bounded Responses-to-Messages translation path.

Translated Responses requests are stateless and must explicitly set `store: false`. Server-side Responses state such as `previous_response_id`, stored prompts, or conversation objects cannot be emulated. Initial instructions may become the Anthropic system prompt, but instructions are not reordered when their original position cannot be represented.

Hosted Responses tools, file inputs, background execution, and other fields without a faithful Messages equivalent are rejected on the translated path. Function tools and supported structured-output forms are mapped only where their observable meaning can be preserved.

## Responses over WebSocket

`GET /v1/responses` with Upgrade is a one-to-one native Copilot WebSocket bridge. The exact current model entry must explicitly advertise `ws:/responses`; ordinary HTTP Responses metadata, static model defaults, Claude translation, Chat Completions, and Realtime do not establish eligibility.

The connection accepts `response.create` text events, keeps one response in flight, and processes queued turns in FIFO order. Connections and input memory are bounded. `stream` is implicit: `true` or `null` may be removed as transport-compatible no-ops, while `false` and malformed values are rejected. Background mode and `generate: false` warmup are rejected because forwarding them would not preserve the client contract.

Each connection lasts at most 60 minutes. A text frame is limited to 16 MiB; at most 8 turns or 32 MiB may wait on one connection, and queued plus setup-stage frames are limited to 64 MiB process-wide. With `store: false`, reconnecting cannot assume that connection-local `previous_response_id` state survives; send the complete required context for a new chain.

HTTP/SSE and WebSocket are separate transports but must preserve the same feature semantics. A WebSocket failure never silently becomes an HTTP success inside the proxy.

Codex currently selects the Responses transport at model-provider scope rather than per model. The `client_version` model-picker catalog therefore exposes as selectable only current live models that advertise both `/responses` and `ws:/responses`; incompatible bundled entries are explicitly hidden so Codex cannot merge them back into the picker. The generated profile uses non-secret command-backed auth because current Codex releases refresh custom-provider catalogs only for that auth path; a hand-written `env_key` provider retains the bundled catalog and must not rely on this filtering. Transport-exclusive models remain visible through `copilot-proxy models --client codex`, but are not offered as freely switchable picker entries. This prevents a provider configured for one transport from misrouting a model that requires the other.

## Anthropic Messages

`POST /v1/messages` uses native Messages when the selected model advertises that endpoint. Otherwise, a Responses-backed model may use the bounded Messages-to-Responses translation path.

The translated path rejects Anthropic server-side tools and conversation-state controls that Responses cannot represent. It also rejects request controls whose meaning would be lost, such as unsupported stop, sampling, reasoning, task-budget, tool-choice, or MCP settings. Custom function-style tools and output formats are translated only when the selected backend can preserve their contract.

Native Messages remains the source of truth for Anthropic-specific behavior. The proxy does not route Messages through Chat Completions to obtain a nominal `200` response.

## Evidence required for capability claims

Compatibility decisions distinguish four evidence classes:

1. current Copilot catalog metadata for routing eligibility;
2. bundled proxy classification policy;
3. live Copilot probes that validate observable semantics for the exact account, model, endpoint, and request shape;
4. real Codex or Claude Code smokes for client behavior.

Catalog metadata and HTTP success alone are not semantic proof. Re-run the relevant live probe and real-client gate whenever protocol behavior, routing, tools, structured output, transport, or client integration changes. The complete probe matrix, required environment, semantic validators, and interpretation rules are maintained in [Copilot capability validation](copilot-capability-validation.md).

For deployment support rather than wire behavior, see [Product support](product-support.md). For model and runtime inspection, see [Operations](operations.md).
