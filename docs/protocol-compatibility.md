English | [简体中文](protocol-compatibility.zh-CN.md)

# Protocol compatibility

Client protocol requirements and Copilot's actual behavior must be validated independently. The proxy only supports forwarding within the same API family—for instance, Messages requests can only go to native Messages endpoints—applying bounded compatibility adaptations when needed.

## Route modes

| Mode | Meaning |
| --- | --- |
| `direct` | The client and Copilot sides use the same protocol family; the proxy forwards with bounded compatibility sanitization |
| `unsupported` | No native route exists, so the request is rejected locally |

Messages, Responses, Chat Completions, and Embeddings are direct-only. A request is never retried through a different protocol or model. Responses WebSocket remains a separate native transport.

### Migration from cross-protocol routing

**Breaking change:** Messages-to-Responses and Responses-to-Messages translation have been removed. Requests that previously used those paths now return a client-compatible `400 invalid_request_error` without contacting Copilot. Configure the client for a native API supported by the selected model, or select a model supporting the client's API. A model list does not make a single-protocol client support other protocols.

Routing uses endpoint capabilities, not model-brand rules. A model that advertises multiple native APIs remains usable through each of them.

For the complete operator migration checklist, including retired CLI options and diagnostics behavior, see [upgrade changes after v0.10.0](operations.md#upgrade-changes-after-v0100).

## Dynamic model catalog

Each account fetches its own Copilot model catalog at startup and keeps it in memory. HTTP routing, model selection, setup, and capability profiles use that account's fetched IDs and `supported_endpoints`; there is no bundled model table or family-prefix capability inference. Known client alias normalization remains separate from model availability.

An initial fetch failure or empty inventory leaves the account unavailable. With no cached catalog, model-dependent requests return `503 model_catalog_unavailable`; an absent model or unadvertised HTTP endpoint is rejected locally. Missing endpoint metadata means the proxy cannot offer that route, not proof that the upstream would reject every possible request. Embeddings uses the fetched model's `capabilities.type=embeddings`.

Periodic refreshes atomically replace the complete snapshot, including removals. A failed refresh retains the last valid snapshot and marks it stale; a successful empty refresh removes all models. Normal requests do not fetch the catalog again.

Proxy-generated output limits use only the fetched model limit. Explicit client limits remain unchanged. Narrow native wire-format adaptations, such as the existing GPT-5.4 Chat Completions token-field normalization, do not grant model or endpoint availability.

## Usage

Upstream usage is preserved; missing usage is not synthesized from local estimates. Treat it as unavailable, not zero. `POST /v1/messages/count_tokens` is a separate upstream-gated operation, not a replacement for actual generation usage; its [document acceptance boundary](api-reference.md#claude-code-document-boundary) differs from generation.

## Maturity labels

| Label | Product meaning |
| --- | --- |
| `stable` | A non-preview model's current catalog advertises a direct HTTP route |
| `experimental` | A preview model's catalog-advertised direct route or a native Responses WebSocket route may change quickly |
| `unsupported` | No native route is available |

These labels classify routing eligibility. They do not guarantee that every field, tool, stop condition, or output semantic works for a model.

## Responses over HTTP and SSE

`POST /v1/responses` remains available independently from WebSocket and requires a native Responses backend. Messages-only models cannot be used through this endpoint. Responses payloads and events stay in the Responses protocol, subject to the existing Copilot compatibility adaptations.

## Responses over WebSocket

`GET /v1/responses` with Upgrade is a one-to-one native Copilot WebSocket bridge. The exact current model entry must explicitly advertise `ws:/responses`; ordinary HTTP Responses metadata, Chat Completions, and Realtime do not establish eligibility.

The connection accepts `response.create` text events, keeps one response in flight, and processes queued turns in FIFO order. Connections and input memory are bounded. `stream` is implicit: `true` or `null` may be removed as transport-compatible no-ops, while `false` and malformed values are rejected. Background mode and `generate: false` warmup are rejected because forwarding them would not preserve the client contract.

Each connection lasts at most 60 minutes. A text frame is limited to 16 MiB; at most 8 turns or 32 MiB may wait on one connection, and queued plus setup-stage frames are limited to 64 MiB process-wide. With `store: false`, reconnecting cannot assume that connection-local `previous_response_id` state survives; send the complete required context for a new chain.

HTTP/SSE and WebSocket are separate transports but must preserve the same feature semantics. A WebSocket failure never silently becomes an HTTP success inside the proxy.

Codex currently selects the Responses transport at model-provider scope rather than per model. The `client_version` model-picker catalog therefore exposes as selectable only current live models that advertise both `/responses` and `ws:/responses`; incompatible bundled entries are explicitly hidden so Codex cannot merge them back into the picker. The generated profile uses non-secret command-backed auth because current Codex releases refresh custom-provider catalogs only for that auth path; a hand-written `env_key` provider retains the bundled catalog and must not rely on this filtering. Transport-exclusive models remain visible through `copilot-proxy models --client codex`, but are not offered as freely switchable picker entries. This prevents a provider configured for one transport from misrouting a model that requires the other.

The proxy catalog also sets `use_responses_lite=false` on exposed models. The generated provider serves the full Responses contract; retaining first-party bundled Lite metadata would make Codex omit hosted Responses tools such as `web_search` even when the live Copilot model supports them.

## Anthropic Messages

`POST /v1/messages` requires a native Messages backend. Responses-only models cannot be used through this endpoint. Anthropic payloads and events stay in the Messages protocol, subject to the existing Copilot compatibility adaptations.

Messages never falls back to Chat Completions for Anthropic-specific features. Tool-call acceptance is not execution: see [tool ownership and probe semantics](copilot-capability-validation.md#live-copilot-capability-matrix), and the separate [document boundary](api-reference.md#claude-code-document-boundary).

## Evidence required for capability claims

Compatibility decisions distinguish four evidence classes:

1. current Copilot catalog metadata for routing eligibility;
2. installed client metadata for client-specific eligibility, never as an upstream model or endpoint fallback;
3. live Copilot probes that validate observable semantics for the exact account, model, endpoint, and request shape;
4. real Codex or Claude Code smokes for client behavior.

Catalog metadata and HTTP success alone are not semantic proof. Re-run the relevant live probe and real-client gate whenever protocol behavior, routing, tools, structured output, transport, or client integration changes. The complete probe matrix, required environment, semantic validators, and interpretation rules are maintained in [Copilot capability validation](copilot-capability-validation.md).

For deployment support rather than wire behavior, see [Product support](product-support.md). For model and runtime inspection, see [Operations](operations.md).
