# GitHub Copilot Capability Validation

This repository forwards OpenAI-compatible requests, translates selected OpenAI/Anthropic request families, and bridges native Responses WebSocket connections onto GitHub Copilot upstream APIs. That means some fixes are purely local schema, transport, or translation work, while others are only safe if the selected Copilot model and endpoint actually support them.

This document is the guardrail for that second category.

This document intentionally does not record a durable support matrix for GitHub Copilot upstream behavior. Treat the executable live probes, run against the selected model and account at the time of the change, as the source of truth.

## Why this exists

Several Claude-side compatibility gaps are easy to identify from the Anthropic protocol alone:

- `thinking.type = "adaptive"`
- `output_config.effort`
- `tool_choice`
- `disable_parallel_tool_use`
- URL-based image inputs

The risky part is that "valid Anthropic input" does not automatically mean "valid GitHub Copilot upstream input". If we wire fields through blindly, we can turn a harmless proxy omission into a hard upstream request failure.

## Validation model

Use two layers:

1. Local-only fixes

These are safe to implement without a live Copilot probe, as long as unit tests cover the translation behavior.

- Accept Anthropic request shapes such as `thinking.type = "adaptive"` or `thinking.type = "disabled"`.
- Accept `tool_result.content` as either string or structured block arrays.
- Accept Anthropic `image.source.type = "url"` in request parsing.
- Improve Claude model normalization or historical-thinking handling.

2. Upstream-gated fixes

These should only be enabled after a live probe proves Copilot accepts the translated request, or after we deliberately choose a graceful fallback for unsupported cases.

- Forwarding Claude `tool_choice` to Copilot `/chat/completions`
- Mapping Anthropic `output_config.effort` or thinking hints onto Copilot `reasoning.effort`
- Mapping `disable_parallel_tool_use = true` onto `parallel_tool_calls = false`
- Passing URL image inputs through to Copilot `/responses`
- Passing Responses-native controls such as `text.verbosity`, `include`, `top_logprobs`, `prompt_cache_key`, `prompt_cache_retention`, `metadata`, `safety_identifier`, `user`, `truncation`, `context_management`, `conversation`, `prompt`, `store`, `previous_response_id`, `background`, `max_tool_calls`, `stream_options`, and `service_tier`
- Passing hosted and Responses-native tools such as `web_search`, `web_search_preview`, `file_search`, `image_generation`, `mcp`, `computer_use_preview`, `tool_search`, `local_shell`, `shell`, `custom`, `namespace`, `apply_patch`, and `code_interpreter`
- Exposing official Responses subroutes such as `/responses/{id}`, `/responses/{id}/cancel`, `/responses/{id}/input_items`, `/responses/input_tokens`, and `/responses/compact`
- Advertising or opening native Responses WebSocket transport for a model; ordinary `/responses` support is insufficient unless the current live model metadata explicitly includes `ws:/responses` or its normalized equivalent

## Probe matrix

The executable probe definitions live in [tests/live/copilot-capability-matrix.ts](../tests/live/copilot-capability-matrix.ts).

The Responses rows are aligned to the OpenAI OpenAPI `CreateResponse` schema and official Responses subroutes as of API spec `2.3.0`. The matrix intentionally emphasizes upstream-gated pass-through decisions: state/context controls, include values, streaming options, tool definitions, tool-choice forms, multimodal input shapes, structured output, and official `/responses/*` routes. Plain sampling controls such as `temperature`, `top_p`, and `max_output_tokens` are covered by normal request smoke coverage unless a Copilot-specific incompatibility appears.

Hosted tool presence probes set `tool_choice=none`, so they measure whether Copilot accepts the tool schema on the request, not whether the backend can or will execute that hosted tool.

| Probe group | Probe IDs | Copilot endpoint | Model source | How to read the result |
| --- | --- | --- | --- | --- |
| Baselines | `baseline-claude-chat-completions`, `baseline-claude-responses-unsupported`, `baseline-responses-api`, `baseline-responses-model-chat-completions-unsupported`, `responses-streaming` | `/chat/completions`, `/responses` | env configured | Establishes whether the selected model and endpoint are reachable before interpreting feature probes |
| Claude compatibility gates | `claude-tool-choice-required`, `claude-parallel-tool-calls-false`, `claude-reasoning-effort-high`, `claude-reasoning-effort-max`, `claude-response-format-json-object`, `claude-response-format-json-schema` | `/chat/completions` | env configured | Read the live summary for the selected model; do not infer support from this document |
| Responses streaming controls | `responses-stream-options-include-obfuscation-false` | `/responses` | env configured | Read the live summary for the selected model |
| Responses reasoning and output controls | `responses-reasoning-effort-none`, `responses-reasoning-effort-low`, `responses-reasoning-effort-medium`, `responses-reasoning-effort-high`, `responses-reasoning-effort-xhigh`, `responses-reasoning-effort-minimal-unsupported`, `responses-reasoning-summary-auto`, `responses-reasoning-summary-concise`, `responses-reasoning-summary-detailed`, `responses-reasoning-generate-summary-auto-deprecated`, `responses-include-encrypted-reasoning`, `responses-include-output-logprobs`, `responses-include-input-image-url`, `responses-text-verbosity-low`, `responses-text-verbosity-medium`, `responses-text-verbosity-high` | `/responses` | env configured | Read the live summary for the selected model and date |
| Responses cache and context controls | `responses-prompt-cache-key`, `responses-prompt-cache-retention-24h`, `responses-metadata`, `responses-safety-identifier`, `responses-user-deprecated`, `responses-truncation-auto`, `responses-context-management`, `responses-conversation`, `responses-prompt-template`, `responses-store-false`, `responses-store-true-unsupported`, `responses-previous-response-id-unsupported`, `responses-background-unsupported`, `responses-background-stream-unsupported`, `responses-service-tier-auto-unsupported` | `/responses` | env configured | Read the live summary for the selected model and date |
| Responses tools and structured output | `responses-max-tool-calls-1`, `responses-function-call-output-input`, `responses-parallel-tool-calls-false`, `responses-tool-choice-function-object`, `responses-tool-choice-allowed-tools`, `responses-web-search-tool`, `responses-web-search-preview-tool`, `responses-file-search-tool`, `responses-image-generation-tool`, `responses-mcp-tool`, `responses-computer-use-preview-tool`, `responses-tool-search-tool`, `responses-local-shell-tool`, `responses-shell-tool`, `responses-custom-tool`, `responses-namespace-tool`, `responses-apply-patch-tool`, `responses-code-interpreter-tool-unsupported`, `responses-text-format-json-object`, `responses-text-format-json-schema` | `/responses` | env configured | Read the live summary for the selected model and date |
| Responses multimodal and files | `responses-input-image-url`, `responses-input-image-data-url`, `responses-input-file-url` | `/responses` | env configured | Read the live summary for the selected model and date |
| Official Responses subroutes | `responses-get-by-id-unsupported`, `responses-delete-by-id-unsupported`, `responses-cancel-unsupported`, `responses-input-items-unsupported`, `responses-input-tokens-unsupported`, `responses-compact-unsupported` | `/responses/{id}`, `/responses/{id}/cancel`, `/responses/{id}/input_items`, `/responses/input_tokens`, `/responses/compact` | env configured | Read the live summary for the selected model and date |
| Native Anthropic passthrough | `native-anthropic-baseline`, `native-anthropic-hyphen-alias-baseline`, `native-anthropic-streaming`, `native-anthropic-count-tokens`, `native-anthropic-count-tokens-tools`, `native-anthropic-reasoning-effort-low`, `native-anthropic-reasoning-effort-medium`, `native-anthropic-reasoning-effort-high`, `native-anthropic-reasoning-effort-xhigh`, `native-anthropic-reasoning-effort-max`, `native-anthropic-json-schema`, `native-anthropic-thinking-display-omitted`, `native-anthropic-manual-thinking-budget`, `native-anthropic-thinking-disabled`, `native-anthropic-tool-choice-specific`, `native-anthropic-tool-choice-any-disable-parallel`, `native-anthropic-strict-custom-tool`, `native-anthropic-server-tool-code-execution`, `native-anthropic-server-tool-memory`, `native-anthropic-server-tool-bash`, `native-anthropic-server-tool-text-editor`, `native-anthropic-server-tool-web-search`, `native-anthropic-mid-conversation-system-beta`, `native-anthropic-speed-fast`, `native-anthropic-document-text`, `native-anthropic-document-url-pdf`, `native-anthropic-document-file-unsupported`, `native-anthropic-document-citations`, `native-anthropic-cache-control`, `native-anthropic-image-base64`, `native-anthropic-image-url-rejected`, `native-anthropic-models-api-unsupported`, `native-anthropic-batches-list-unsupported`, `native-anthropic-batches-create-unsupported`, `native-anthropic-files-api-unsupported` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, `/v1/messages/batches`, `/v1/files` | env configured | Read the live summary for the selected model and date |

## How to run the live probes

The live suite is intentionally opt-in. It is skipped during normal `bun test` runs unless `COPILOT_LIVE_TEST=1` is set.

The dedicated Responses SSE/WSS parity suite is separate from `bun run test:live:copilot`: it uses `COPILOT_LIVE_WS_PARITY=1` and the direct command documented in [Responses SSE/WSS semantic parity gate](#responses-ssewss-semantic-parity-gate).

Required environment variables:

- `COPILOT_LIVE_TEST=1`
- `COPILOT_TOKEN=<your GitHub Copilot bearer token>`
- `COPILOT_LIVE_CLAUDE_MODEL=<claude-model-under-test>` when Claude or Anthropic probes are enabled
- `COPILOT_LIVE_CLAUDE_MODELS=<comma-separated-claude-models-under-test>` as an alternative to run the Claude/Anthropic probes for multiple models in one suite
- `COPILOT_LIVE_RESPONSES_MODEL=<responses-model-under-test>` when Responses probes are enabled

Optional environment variables:

- `COPILOT_ACCOUNT_TYPE=individual|business|enterprise`
- `COPILOT_VSCODE_VERSION=1.104.3`
- `COPILOT_LIVE_RESPONSES_ONLY=1` to run only the configured `/responses` and raw `/responses/*` probes
- `COPILOT_LIVE_ANTHROPIC_ONLY=1` to run only native Anthropic `/v1/messages` and `/v1/files` probes
- `COPILOT_LIVE_IMAGE_URL=https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png`
- `COPILOT_LIVE_FILE_URL=https://www.berkshirehathaway.com/letters/2024ltr.pdf`
- `COPILOT_LIVE_TIMEOUT_MS=180000`
- `COPILOT_LIVE_RETRY_COUNT=2`

Example:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=<claude-model-under-test> \
COPILOT_LIVE_RESPONSES_MODEL=<responses-model-under-test> \
bun run test:live:copilot
```

Responses-only baseline:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_RESPONSES_MODEL=<responses-model-under-test> \
COPILOT_LIVE_RESPONSES_ONLY=1 \
bun run test:live:copilot
```

Anthropic-only baseline:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=<claude-model-under-test> \
COPILOT_LIVE_ANTHROPIC_ONLY=1 \
bun run test:live:copilot
```

Anthropic-only probes across current Opus variants:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODELS=claude-opus-4.8,claude-opus-4.7,claude-opus-4.6 \
COPILOT_LIVE_ANTHROPIC_ONLY=1 \
bun run test:live:copilot
```

Anthropic-only probe for a selected upstream Claude model:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=<another-claude-model-under-test> \
COPILOT_LIVE_ANTHROPIC_ONLY=1 \
bun run test:live:copilot
```

## Result semantics

Each probe is classified as one of:

- `supported`
- `unsupported`
- `auth_error`
- `rate_limited`
- `api_error`
- `network_error`
- `unexpected_response`

Interpretation rules:

- Baseline probes must return `supported`.
- Baseline negative-compatibility probes must return a clean `unsupported`.
- Optional probes pass if they return either `supported` or a clean `unsupported`.
- `auth_error`, `rate_limited`, `api_error`, `network_error`, and `unexpected_response` should be treated as environment or upstream-health failures, not product decisions.

## Point-in-time evidence record: 2026-07-15

This is a dated decision record for a dirty feature checkout based on Git commit `1d28835`. Re-run the exact probes before changing an upstream-gated behavior; a handshake alone is not semantic-support evidence.

- **Official-contract verified:** OpenAI [Responses WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode) uses `GET /v1/responses` Upgrade plus `response.create` text events. `stream` is implicit, `background` is unsupported, one connection runs one response at a time in FIFO order without multiplexing, and the connection duration is limited to 60 minutes. With `store: false`, uncached `previous_response_id` state has no persisted fallback after reconnect. OpenAI also defines `generate: false` as a no-output state warmup that returns a response ID for later continuation.
- **Implementation boundary:** the proxy accepts Upgrade requests on `/responses` and `/v1/responses`, bridges each eligible downstream connection to one Copilot `wss://.../responses` connection, and leaves HTTP `POST`/SSE Responses behavior intact. Eligibility comes from the current live model's explicit `ws:/responses` metadata; ordinary Responses support, Claude translation, Chat Completions, and Realtime do not imply this transport. Because Copilot did not preserve official warmup semantics, the proxy rejects `generate: false` locally with `400 unsupported_value`, `param: "generate"`, before opening upstream.
- **Locally reproduced:** `bun run test:coverage` completed with `927` passed, `60` skipped, `0` failed, and `2946` assertions, reached 84.80% function / 82.61% line coverage, and passed the critical coverage gate for all `21` tracked files. The focused WebSocket and transport-parity suites passed downstream/session behavior, pre-Upgrade Host/Origin policy, independent HTTP/WSS model gating, FIFO ordering, per-connection plus 64 MiB global request buffering, top-level duration-limit errors, explicit `stream: false` rejection, clean idle close versus queued-work failure handling, semantic classification, Bun/Node handshake timeout, permit lifetime, authentication recovery, bounded approval cancellation, bounded HTTP/SSE shutdown, and graceful/forced WebSocket shutdown. `bun run test:node:http` also passed its packaged Node.js HTTP, ordinary WebSocket Upgrade, and non-acknowledging raw WebSocket forced-close smoke.
- **Live-upstream verified:** using the `individual` account route and model `gpt-5.4`, both the Bun runtime and Node.js `24.11.1` completed a real local `GET /v1/responses` `101` followed by an upstream `wss://api.githubcopilot.com/responses` `101`. The Node semantic result was exactly `NODE_WS_OK`. A direct same-socket probe chained two turns with `previous_response_id` and returned exactly `LOCAL_WS_ONE` then `LOCAL_WS_TWO`; another same-socket probe began with text, added a base64 image on the second turn, completed normally, and answered `PINK`. Open-event diagnostics proved both handshake statuses; the active Bun connection did not expose an upstream request ID, so none is claimed. A separate live `generate: false` probe returned `bad_request` without `input` and actually generated output when `input` was present, which is not the official no-output warmup semantic.
- **Client-smoke verified:** the real-command gate `bun run test:live:codex` passed repeatedly on 2026-07-15 with Codex CLI `0.144.4`, `gpt-5.4`, and the `individual` Copilot route. With the isolated child environment, its HTTP/SSE half completed a real local `command_execution` tool loop with matching request/terminal evidence (three to six requests across repeated runs). Its WSS half used one active downstream connection, exactly one upstream handshake, three alternating forwarded/completed turns, and zero HTTP fallback. Turn count is intentionally bounded below rather than fixed because real agent behavior may use additional tool rounds. An earlier targeted `0.144.3` trace also verified the full `store:false`/`previous_response_id` chain and observed a separate `generate:false` prewarm socket rejected locally with zero upstream attempts. Claude Code `2.1.197` using `claude-sonnet-5` returned exactly `claude-ok`.
- **SSE/WSS semantic parity verified:** the opt-in parity test ran twice for `gpt-5.4`, once with `COPILOT_ACCOUNT_TYPE=individual` and once with `COPILOT_ACCOUNT_TYPE=enterprise`; both exited `0` with `confirmed=7`, `inconclusive=0`, and `failed=0`. Function-tool control, `json_object`, `json_schema`, `web_search`, and `web_search_preview` were semantically supported over both real SSE and WebSocket transports. MCP and `file_search` returned `explicit_capability_unsupported` on both transports, confirming rejection parity without claiming support. The HTTP side used `stream: true`, the WebSocket side used `response.create`, and each pair shared the same feature payload and validator.

## Point-in-time evidence record: 2026-07-13

This section is a dated decision record, not a durable support matrix. Re-run the exact probes before changing an upstream-gated behavior.

- Checkout: dirty working tree based on Git commit `ca0a5d1ad039a9867441835ca63a4647f942501e`.
- Copilot account routing: the proxy used its default `individual` configuration and the direct probes used `api.githubcopilot.com`. The retained evidence does not identify the account's subscription entitlement, so do not infer Business/Enterprise versus individual billing from the hostname alone.
- Local proxy: current checkout listening on `http://127.0.0.1:4899` with verbose diagnostics. Raw logs and credentials were not retained.
- Direct Copilot host: `https://api.githubcopilot.com`; every direct result below used a live token obtained from the local token boundary without printing or retaining it.
- Evidence labels used below: **official-contract verified**, **live-upstream verified**, and **locally reproduced**. These probes are not a Codex or Claude Code client smoke.

The client-facing request shapes were checked on 2026-07-13 against the current official [Anthropic model overview](https://platform.claude.com/docs/en/about-claude/models/overview), [Anthropic advisor tool guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool), [Anthropic tool-result guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls), and [OpenAI Create embeddings reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create). The Anthropic model overview records a 128K synchronous Messages maximum output for Claude Opus 4.8, 4.7, and 4.6. The advisor guide defines the `advisor-tool-2026-03-01` beta and `advisor_20260301` tool shape. The tool-result guide permits nested `text` and base64 `image` blocks. The OpenAI reference permits `encoding_format` values `float` and `base64`.

### Advisor tool: unsupported upstream and fail-closed locally

- **Official-contract verified:** the request copied the official quick-start shape: executor `claude-sonnet-5`, `max_tokens: 4096`, beta header `advisor-tool-2026-03-01`, and `tools: [{type: "advisor_20260301", name: "advisor", model: "claude-fable-5"}]`.
- **Live-upstream verified:** direct `POST https://api.githubcopilot.com/v1/messages` returned `400` with code `invalid_request_body` and observation `unsupported beta header(s): advisor-tool-2026-03-01`. Direct `POST https://api.githubcopilot.com/v1/messages/count_tokens` returned the same status, code, and observation for the same request family.
- **Locally reproduced:** local `POST /v1/messages` and `POST /v1/messages/count_tokens` each returned an Anthropic-compatible `400 invalid_request_error`. Neither route removed the advisor tool and reported a misleading success.
- **Decision:** reject requests that declare `advisor_20260301` before forwarding. A standalone advisor beta header may be removed only when no advisor-tool semantics are present.

### Rich `tool_result` image: faithful Responses translation

- **Official-contract verified:** Anthropic allows `tool_result.content` to be an array containing both a `text` block and a base64 `image` block.
- **Live-upstream verified:** direct `POST https://api.githubcopilot.com/responses` with model `gpt-5.4`, `max_output_tokens: 1024`, a matching `function_call`, and `function_call_output.output` parts `[input_text, input_image]` using a 32-by-32 base64 PNG returned `200`, `status: completed`, and the semantic answer `MAGENTA`. The request included `copilot-vision-request: true`.
- **Locally reproduced:** local `POST /v1/messages` with model `gpt-5.4`, `max_tokens: 1024`, matching `tool_use` history, and a `tool_result` containing text plus the same base64 PNG returned `200`, `stop_reason: end_turn`, and `MAGENTA`.
- **Decision:** preserve rich tool output as Responses `input_text` and `input_image` parts, and enable the Copilot vision request header when an image occurs inside `tool_result`.

### Claude Opus 128K synchronous Messages boundary

The local checks used the Copilot model IDs shown below and an exact `max_tokens: 128000` non-streaming request with a short fixed-response semantic assertion. The direct checks repeated that request against Copilot and then changed only the boundary value to `128001`.

| Copilot request model | Local `/v1/messages`, `128000` | Direct Copilot `/v1/messages`, `128000` | Direct Copilot `/v1/messages`, `128001` |
| --- | --- | --- | --- |
| `claude-opus-4.6` | `200`; requested model preserved; `end_turn`; fixed response matched | `200`; response model `claude-opus-4-6`; `end_turn`; fixed response matched | `400 invalid_request_error`; maximum reported as `128000` |
| `claude-opus-4.7` | `200`; requested model preserved; `end_turn`; fixed response matched | `200`; response model `claude-opus-4-7`; `end_turn`; fixed response matched | `400 invalid_request_error`; maximum reported as `128000` |
| `claude-opus-4.8` | `200`; requested model preserved; `end_turn`; fixed response matched | `200`; response model `claude-opus-4-8`; `end_turn`; fixed response matched | `400 invalid_request_error`; maximum reported as `128000` |

This is both **live-upstream verified** and **locally reproduced**. Together with the official 128K model limits, it justifies using 128000 as the dated verified floor for proxy-generated defaults for these three models. It does not justify clamping an explicit client value locally; explicit values remain upstream-visible so the selected backend returns the authoritative boundary error.

### Embeddings `encoding_format: base64`: proxy encoding fallback

- **Official-contract verified:** OpenAI permits `encoding_format: "base64"` and scalar string input on `POST /v1/embeddings`.
- **Live-upstream verified:** direct `POST https://api.githubcopilot.com/embeddings` with model `text-embedding-3-small`, array input, `encoding_format: "base64"`, and `dimensions: 8` returned `200`, but the embedding was an eight-element float array; the response also omitted the top-level `object` and `model` fields.
- **Locally reproduced:** local `POST /v1/embeddings` with the official scalar-input shape and the same model, encoding, and dimension count returned `200`, an embedding string that decoded to 32 bytes, `object: "list"`, and model `text-embedding-3-small`.
- **Decision:** forward `encoding_format` unchanged. If Copilot returns floats for a base64 request, encode them locally as packed little-endian Float32 bytes and normalize the client-facing envelope; if Copilot returns a valid base64 string in the future, preserve it. The local success is a proxy fallback and must not be reported as native Copilot base64 output.

## How to use the results

Use the probe outcome to decide how aggressive the proxy should be:

- Treat each live run as a point-in-time result for the selected model, account type, and Copilot backend.
- If a probe is `supported`, we can wire the corresponding translation path for that validated surface and add normal unit coverage.
- If a probe is `unsupported`, keep the local parsing improvement but omit, downgrade, or explicitly surface the upstream-aligned unsupported error for that surface.
- If a probe fails for environmental reasons, rerun the suite before making routing or translation decisions.

## Authentication-recovery and overload validation

Request-time authentication recovery is narrower than general retry logic. Validate it deterministically at a mocked Copilot boundary before using live credentials:

- A first upstream `401`, or the observed GitHub opaque rejection (`403`, plain-text `Forbidden`, correlation request ID present, no `Retry-After`), may perform exactly one single-flight short-lived token refresh and one replay.
- The replay must rebuild `Authorization` and `x-request-id`. Thirty-two concurrent failures for one endpoint/model must still produce one token exchange and one canary decision.
- Structured permission/model/organization `403`, local proxy `403`, `429`, 5xx, timeout, reset, and failures after a 2xx/SSE event must produce zero authentication replays.
- A fresh-token replay that is still rejected opens the scoped cooldown circuit. Two persistently rejected endpoint/model scopes may open the global circuit; while open, `/readyz` is `503` and new work must not reach GitHub.
- When `--max-concurrency` is enabled, prove that the lease remains active until a non-stream body or SSE stream completes/cancels, and that queue overflow returns locally without an upstream fetch.

The deterministic route gate is:

```sh
bun test \
  tests/copilot-auth-recovery.test.ts \
  tests/auth-recovery-routes.test.ts \
  tests/concurrency-limiter.test.ts \
  tests/health-routes.test.ts \
  tests/request-signal-regression.test.ts
```

For a real-machine recovery smoke, invalidate only the in-memory short-lived Copilot token in a disposable proxy process; never corrupt or replace the persisted GitHub credential. Then run one real Codex request through `/v1/responses` and one real Claude request through `/v1/messages`. Success requires a single refresh, a new upstream request ID, one terminal client response, no duplicated stream events, and a closed recovery circuit. Persistent GitHub risk enforcement must be recorded and cooled down, not induced repeatedly or bypassed by token/account/IP rotation.

## Responses WebSocket validation

Responses WebSocket is a native transport path, not a protocol translation. The proxy accepts client Upgrade requests on both `/responses` and `/v1/responses` and opens one Copilot `wss://.../responses` connection per accepted downstream connection. It must reject a model before connecting upstream unless that model's current live `supported_endpoints` explicitly contains `ws:/responses` or an equivalent normalized WebSocket endpoint. Do not infer WebSocket eligibility from ordinary `/responses`, a static model default, or a successful HTTP/SSE request.

The [official Responses WebSocket guide](https://developers.openai.com/api/docs/guides/websocket-mode) defines the client contract that this path preserves:

- Clients send text JSON `response.create` events; `stream` is implicit and `background` is unsupported. Reject `stream: false` or malformed `stream` values locally rather than reporting a streaming response as a faithful success; strip `stream: true` or `null` as transport-compatible no-ops.
- OpenAI clients may send `response.create` with `generate: false` to warm request state without model output and receive a response ID for later continuation.
- A connection processes one response at a time. Additional turns are FIFO and are not multiplexed.
- A connection lasts at most 60 minutes, after which the client reconnects.
- `previous_response_id` can use the connection-local most-recent response cache. With `store: false`, reconnecting or losing that cache means the client must start a new chain and resend the full required context; there is no persisted fallback.

Copilot did not implement the official warmup semantic in the 2026-07-15 live probe: `generate: false` without `input` returned `bad_request`, while the same field with `input` caused actual generation. Treat this as unsupported rather than parser acceptance. The proxy must return local `400 unsupported_value` with `param: "generate"` and make zero upstream attempts until a fresh live probe proves a faithful no-output warmup.

The focused deterministic gate is:

```sh
bun test \
  tests/responses-websocket.test.ts \
  tests/responses-websocket-upgrade.test.ts \
  tests/responses-websocket-upstream.test.ts \
  tests/copilot-responses-transport-parity.test.ts \
  tests/routing-policy.test.ts \
  tests/models-route.test.ts \
  tests/copilot-auth-recovery.test.ts \
  tests/start-shutdown.test.ts
bun run test:node:http
```

The Bun tests must cover direct model gating, pre-Upgrade Host/Origin rejection, text-frame validation, local `generate: false` rejection with zero upstream attempts, one in-flight turn/FIFO ordering, bounded queue behavior, terminal-event permit release, inactivity timeout, disconnect cleanup, authentication recovery before a successful handshake, no replay after a turn is sent, Codex `supports_websockets` catalog projection, and graceful/forced shutdown. `bun run test:node:http` must exercise an actual packaged Node.js listener and complete a WebSocket Upgrade in addition to the ordinary HTTP route; a Bun-only in-process test does not substitute for that runtime smoke.

Security and recovery assertions apply before and after Upgrade:

- Reject invalid Host or Origin and connection-capacity overflow before returning `101`, with zero upstream WebSocket attempts.
- Reject `generate: false` warmup locally before connecting upstream; Copilot generation under that field is not a faithful warmup fallback.
- Run manual approval and rate limiting for every `response.create`, not only once during the handshake.
- A handshake-time eligible `401`/`403` may use the normal single-flight refresh path once. After an upstream socket is open or a `response.create` has been sent, never replay that turn automatically.
- Hold the shared concurrency lease for the active turn until a terminal Responses event, cancellation, or connection failure. An idle connection between turns must not retain a turn lease.
- Keep each downstream connection isolated to one upstream connection, forward backpressure, and close both sides on disconnect or bounded shutdown. Never pass an inbound HTTP request signal into the upstream WebSocket.

### Responses SSE/WSS semantic parity gate

The official [Responses WebSocket event reference](https://developers.openai.com/api/reference/resources/responses/websocket-events#response.create) says that `response.create` uses the same top-level fields as `POST /v1/responses`, with transport-specific exceptions such as implicit streaming and unsupported background mode. The parity gate therefore compares one common feature payload across the two native Copilot transports instead of maintaining separate feature assumptions for SSE and WebSocket.

Run the deterministic classifier/validator tests first:

```sh
bun test tests/copilot-responses-transport-parity.test.ts
```

Then run the direct live gate for every account route in scope:

```sh
COPILOT_LIVE_WS_PARITY=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_RESPONSES_MODEL=gpt-5.4 \
COPILOT_ACCOUNT_TYPE=individual \
bun test tests/live/copilot-responses-transport-parity.test.ts

# Repeat with COPILOT_ACCOUNT_TYPE=enterprise for that route.
```

The live gate has these non-negotiable mechanics:

1. Build one common payload for each feature.
2. Send the HTTP attempt to Copilot `/responses` with `stream: true` and consume a real SSE event sequence through its terminal event.
3. Send the WebSocket attempt as `response.create` on Copilot `wss://.../responses` and consume its event sequence through the terminal event.
4. Apply the same feature-specific semantic validator to both attempts, then compare their outcome categories.
5. Fail on a transport/category mismatch, semantic-validation failure, or transport/API failure. Matching `resource_unavailable` or `dependency_unavailable` outcomes are only `inconclusive`. Matching `explicit_capability_unsupported` outcomes are `confirmed` rejection parity, not feature support.

The validators require observable feature behavior:

| Feature | Required semantic evidence |
| --- | --- |
| Function-tool control | Exactly one completed `parity_marker` function call with the required `transport-parity` argument and a usable call ID |
| `json_object` | Output parses as a JSON object and preserves `ok=true` plus `transport="parity"` |
| `json_schema` | Output parses and satisfies the strict schema, including `answer="4"` and no additional properties |
| `web_search`, `web_search_preview` | A completed `web_search_call`, `response.web_search_call.completed`, an affirmative statement that the H1 is `Example Domain`, and a URL citation or included action source whose URL is on `example.com` |
| MCP positive path | Completed `mcp_list_tools` and `mcp_call` events/items, discovery of `dmcp.roll`, exact `1d1` arguments, a tool output whose exact result is numeric `1`, and an assistant answer exactly equal to `1` |
| `file_search` positive path | A real vector store, completed search event/item, non-empty results and queries, a file citation, and the configured sentinel in returned evidence |

For a positive `file_search` run, set both `COPILOT_LIVE_VECTOR_STORE_ID` and `COPILOT_LIVE_FILE_SEARCH_SENTINEL`. Do not turn a missing vector store into a capability verdict. Only an error that explicitly identifies the vector store as missing is `resource_unavailable`; a bare API or WebSocket-handshake `404` is `transport_error` and fails the gate. As of 2026-07-15, the relevant Files/Vector Store management `GET` requests returned `404` on all three probed Copilot hosts, so the environment could not provision that resource through a Copilot management plane. The parity run nevertheless reached an explicit tool-schema capability rejection on both transports, which is stronger than a resource-missing result but still does not claim support. If MCP becomes available later, a successful HTTP status is insufficient: the positive path must include both `mcp_list_tools` and `mcp_call` for deterministic `roll` input `1d1`. MCP connection, protocol, or tool-listing outages are dependency failures; a completed-but-wrong result or an ordinary tool-execution failure is a hard semantic failure, not an inconclusive dependency result.

The dated `gpt-5.4` result was:

| Account route | Process result | Confirmed | Inconclusive | Failed |
| --- | --- | ---: | ---: | ---: |
| `individual` | exit `0` | 7 | 0 | 0 |
| `enterprise` | exit `0` | 7 | 0 | 0 |

| Features | SSE outcome | WSS outcome | What is confirmed |
| --- | --- | --- | --- |
| Function-tool control, `json_object`, `json_schema`, `web_search`, `web_search_preview` | `supported` | `supported` | Both transports passed the same semantic validator |
| MCP, `file_search` | `explicit_capability_unsupported` | `explicit_capability_unsupported` | Both transports rejected the capability consistently; support is not claimed |

## Codex CLI smoke tests

Use the repository's paired real `codex` CLI smoke when changing Responses routing, request adaptation, tool handling, hosted tools, structured output, image inputs, HTTP/SSE stream handling, or Responses WebSocket behavior. The script directly invokes the installed `codex` command; it does not implement a mock client. It always runs an HTTP/SSE tool loop with provider WebSockets disabled and then a native WSS tool loop with provider WebSockets enabled:

```bash
COPILOT_LIVE_CODEX_SMOKE=1 \
CODEX_SMOKE_MODEL=gpt-5.4 \
CODEX_SMOKE_ACCOUNT_TYPE=individual \
bun run test:live:codex
```

Set the exact current model and account type under test. The script owns one disposable proxy, isolated cache-backed `CODEX_HOME` directories, transport-specific provider configuration, redacted evidence summary, worktree comparison, listener cleanup, and artifact removal. In-process tests, direct service helpers, handcrafted WebSocket clients, and fixtures remain useful lower-layer checks but never count as this real Codex smoke.

The packaged command is a POSIX Bash gate and requires `curl`, `jq`, `lsof`, `rg`, and GNU `timeout`. On macOS with coreutils, set `CODEX_TIMEOUT_BIN=gtimeout`. On Windows, run the equivalent real-CLI procedure from the expanded guidance below until a native PowerShell wrapper is added; do not replace it with a mock client.

Do not replace the WSS half with a successful Codex final answer. Codex CLI `0.144.4` was locally reproduced falling back from a rejected WebSocket Upgrade to `POST /v1/responses`, then still emitting `turn.completed` and the expected final text. The paired script therefore requires proxy-side transport evidence and rejects any HTTP POST or fallback diagnostic in the WSS scenario.

### What counts as a real-machine Codex smoke

A qualifying smoke must use all of the following:

- the real `codex` executable installed on the machine
- a proxy process started from the current checkout
- a real GitHub Copilot credential, exact model ID, and account type
- real TCP traffic through the local `/v1/responses` route to the real Copilot upstream, using SSE for an HTTP smoke or an end-to-end WebSocket for a WebSocket smoke
- real local tool execution for tool-loop scenarios

In-process `server.request()` calls, direct calls to `createResponses`, `curl` requests without Codex, the live capability probe matrix, and stub/mock/fake upstreams remain useful at their own layers, but none of them substitutes for this client smoke. An HTTP `200` or WebSocket `101` alone is also insufficient: validate the Codex terminal event and the observable result.

Use Codex's `--json` event stream and `--output-last-message` for machine assertions, as documented in the [official non-interactive mode guide](https://learn.chatgpt.com/docs/non-interactive-mode). Do not rely on formatted terminal output or model self-report.

### Preflight and isolated proxy lifecycle

The executable script above is the normative gate. The expanded shell blocks below remain a manual troubleshooting and surface-specific extension reference; if used for a release or behavior claim, run both the HTTP/SSE and WebSocket sections and apply every assertion from the script. Set `CODEX_SMOKE_MODEL` to a current Responses-backed model that is also present in the installed Codex catalog with local-tool support; an unknown explicit model may run as a text-only client and invalidate the tool-loop case. On macOS, set `CODEX_TIMEOUT_BIN=gtimeout` if GNU `timeout` is installed through coreutils.

```bash
set -euo pipefail

export CODEX_SMOKE_MODEL="${CODEX_SMOKE_MODEL:?set CODEX_SMOKE_MODEL to the exact model ID}"
export CODEX_SMOKE_ACCOUNT_TYPE="${CODEX_SMOKE_ACCOUNT_TYPE:?set CODEX_SMOKE_ACCOUNT_TYPE to individual, business, or enterprise}"
export CODEX_SMOKE_EXPECTED_BACKEND="${CODEX_SMOKE_EXPECTED_BACKEND:-responses}"
export CODEX_SMOKE_PORT="${CODEX_SMOKE_PORT:-4899}"
export CODEX_SMOKE_TIMEOUT_SECONDS="${CODEX_SMOKE_TIMEOUT_SECONDS:-180}"
export CODEX_TIMEOUT_BIN="${CODEX_TIMEOUT_BIN:-timeout}"
export CODEX_SMOKE_SUPPORTS_WEBSOCKETS="${CODEX_SMOKE_SUPPORTS_WEBSOCKETS:-false}"

case "$CODEX_SMOKE_ACCOUNT_TYPE" in
  individual | business | enterprise) ;;
  *) echo "Invalid CODEX_SMOKE_ACCOUNT_TYPE: $CODEX_SMOKE_ACCOUNT_TYPE" >&2; exit 1 ;;
esac

case "$CODEX_SMOKE_SUPPORTS_WEBSOCKETS" in
  true | false) ;;
  *) echo "CODEX_SMOKE_SUPPORTS_WEBSOCKETS must be true or false." >&2; exit 1 ;;
esac

for command_name in codex curl jq lsof rg "$CODEX_TIMEOUT_BIN"; do
  command -v "$command_name" >/dev/null
done

mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
CODEX_SMOKE_ROOT="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/codex-proxy-smoke.XXXXXX")"
CODEX_SMOKE_HOME="$CODEX_SMOKE_ROOT/codex-home"
CODEX_SMOKE_WORK="$CODEX_SMOKE_ROOT/work"
CODEX_SMOKE_PROXY_LOG="$CODEX_SMOKE_ROOT/proxy.log"
mkdir -p "$CODEX_SMOKE_HOME" "$CODEX_SMOKE_WORK"
git status --short >"$CODEX_SMOKE_ROOT/git-status.before"

cleanup_codex_smoke() {
  local exit_status=$?
  trap - EXIT INT TERM
  if [ -n "${CODEX_SMOKE_PROXY_PID:-}" ] && kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
    kill "$CODEX_SMOKE_PROXY_PID" 2>/dev/null || true
    for _ in {1..40}; do
      if ! kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
      kill -KILL "$CODEX_SMOKE_PROXY_PID" 2>/dev/null || true
    fi
    wait "$CODEX_SMOKE_PROXY_PID" 2>/dev/null || true
  fi
  if lsof -nP -iTCP:"$CODEX_SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $CODEX_SMOKE_PORT is still listening after cleanup." >&2
    exit_status=1
  fi
  rm -rf "$CODEX_SMOKE_ROOT"
  exit "$exit_status"
}
trap cleanup_codex_smoke EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if lsof -nP -iTCP:"$CODEX_SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $CODEX_SMOKE_PORT already has a TCP listener; choose an unused port." >&2
  exit 1
fi

bun run ./src/main.ts start \
  --host 127.0.0.1 \
  --port "$CODEX_SMOKE_PORT" \
  --account-type "$CODEX_SMOKE_ACCOUNT_TYPE" \
  --verbose \
  >"$CODEX_SMOKE_PROXY_LOG" 2>&1 &
CODEX_SMOKE_PROXY_PID=$!

CODEX_SMOKE_READY=0
for _ in {1..60}; do
  if ! kill -0 "$CODEX_SMOKE_PROXY_PID" 2>/dev/null; then
    break
  fi
  if lsof -nP -a -p "$CODEX_SMOKE_PROXY_PID" -iTCP:"$CODEX_SMOKE_PORT" -sTCP:LISTEN >/dev/null 2>&1 \
    && curl -fsS --max-time 1 "http://127.0.0.1:$CODEX_SMOKE_PORT/" >/dev/null; then
    CODEX_SMOKE_READY=1
    break
  fi
  sleep 0.5
done

if [ "$CODEX_SMOKE_READY" -ne 1 ]; then
  sed -n '1,200p' "$CODEX_SMOKE_PROXY_LOG" >&2
  exit 1
fi

date -u +'%Y-%m-%dT%H:%M:%SZ'
git rev-parse HEAD
git status --short
command -v codex
codex --version
env CODEX_HOME="$CODEX_SMOKE_HOME" codex debug models --bundled \
  | jq -e --arg model "$CODEX_SMOKE_MODEL" \
    'any(.models[]; .slug == $model and .supported_in_api == true)' >/dev/null
printf 'account_type=%s\nmodel=%s\nexpected_backend=%s\nproxy_pid=%s\nproxy_port=%s\n' \
  "$CODEX_SMOKE_ACCOUNT_TYPE" \
  "$CODEX_SMOKE_MODEL" \
  "$CODEX_SMOKE_EXPECTED_BACKEND" \
  "$CODEX_SMOKE_PROXY_PID" \
  "$CODEX_SMOKE_PORT"
```

The preflight must fail if the chosen port already has a TCP listener, and readiness must prove that the captured proxy PID owns the new listener. This prevents a smoke from accidentally passing against an older proxy. Keep the temporary `CODEX_HOME` under the user's cache directory rather than `/tmp`: current Codex releases warn and refuse to create PATH helper aliases under a temporary-directory home, which adds avoidable noise to the result. The bundled-model check validates only the local client's selected-model capability; it is not proxy catalog evidence. `--verbose` is required because upstream status, first-event, and stream-completion evidence is logged at debug level.

Define one isolated Codex invocation and one JSONL assertion helper in the same shell:

```bash
codex_smoke() {
  local final_path=$1
  local events_path=$2
  local sandbox_mode=$3
  local codex_status
  local scenario_name
  shift 3

  set +e
  "$CODEX_TIMEOUT_BIN" "${CODEX_SMOKE_TIMEOUT_SECONDS}s" \
    env CODEX_HOME="$CODEX_SMOKE_HOME" \
    OPENAI_API_KEY=dummy \
    codex --ask-for-approval never exec \
      --ephemeral \
      --ignore-user-config \
      --ignore-rules \
      --strict-config \
      --skip-git-repo-check \
      --sandbox "$sandbox_mode" \
      --color never \
      --cd "$CODEX_SMOKE_WORK" \
      --model "$CODEX_SMOKE_MODEL" \
      --json \
      --output-last-message "$final_path" \
      -c 'model_provider="copilot-proxy"' \
      -c "model_providers.copilot-proxy={name=\"Copilot Proxy\",base_url=\"http://127.0.0.1:$CODEX_SMOKE_PORT/v1\",env_key=\"OPENAI_API_KEY\",wire_api=\"responses\",supports_websockets=$CODEX_SMOKE_SUPPORTS_WEBSOCKETS}" \
      "$@" \
    >"$events_path" \
    </dev/null
  codex_status=$?
  set -e

  scenario_name="${events_path##*/}"
  scenario_name="${scenario_name%.jsonl}"
  printf 'scenario=%s codex_exit=%s\n' "$scenario_name" "$codex_status" \
    >>"$CODEX_SMOKE_ROOT/codex-exits.txt"
  printf 'codex_exit=%s\n' "$codex_status"
  if [ "$codex_status" -ne 0 ]; then
    sed -n '1,200p' "$CODEX_SMOKE_PROXY_LOG" >&2
  fi
  return "$codex_status"
}

assert_codex_events() {
  local events_path=$1
  jq -s -e 'any(.[]; .type == "thread.started")' "$events_path" >/dev/null
  jq -s -e 'any(.[]; .type == "turn.started")' "$events_path" >/dev/null
  jq -s -e \
    'any(.[]; .type == "item.completed" and .item.type == "agent_message")' \
    "$events_path" >/dev/null
  jq -s -e 'any(.[]; .type == "turn.completed")' "$events_path" >/dev/null
  if jq -s -e 'any(.[]; .type == "error" or .type == "turn.failed")' "$events_path" >/dev/null; then
    echo "Codex emitted an error or turn.failed event." >&2
    return 1
  fi
}
```

`OPENAI_API_KEY=dummy` only satisfies Codex's custom-provider validation. The local proxy authenticates to Copilot with its normal credential and must not log or copy that token into smoke artifacts. `--json` writes JSONL to stdout while Codex diagnostics remain on stderr, so keep the streams separate; do not use `2>&1` when creating the events file.

### Minimum HTTP/SSE real-machine gate

This is the first half of `bun run test:live:codex`; the script fixes `supports_websockets=false` for this scenario so it cannot accidentally consume the WSS path.

#### 1. Streaming baseline

```bash
CODEX_BASELINE_EVENTS="$CODEX_SMOKE_ROOT/baseline.jsonl"
CODEX_BASELINE_FINAL="$CODEX_SMOKE_ROOT/baseline-final.txt"

codex_smoke \
  "$CODEX_BASELINE_FINAL" \
  "$CODEX_BASELINE_EVENTS" \
  read-only \
  'Reply with exactly: proxy-ok'

assert_codex_events "$CODEX_BASELINE_EVENTS"
test "$(cat "$CODEX_BASELINE_FINAL")" = 'proxy-ok'
rg -q -- '--> POST /v1/responses 200' "$CODEX_SMOKE_PROXY_LOG"
rg -q 'Upstream /responses headers received: .*status: 200, stream: true' "$CODEX_SMOKE_PROXY_LOG"
rg -q 'Upstream /responses first SSE event:' "$CODEX_SMOKE_PROXY_LOG"
rg -q "event: 'response.created'" "$CODEX_SMOKE_PROXY_LOG"
rg -q "event: 'response.completed'" "$CODEX_SMOKE_PROXY_LOG"
test "$(rg -c 'tools: [1-9][0-9]*' "$CODEX_SMOKE_PROXY_LOG")" -ge 1
```

For a Responses-backed model, require a local `POST /v1/responses`, at least one advertised tool under the selected Codex model/configuration, upstream `/responses` status `200`, `stream: true`, a first SSE event, a terminal `response.completed` event, and a terminal Codex event. Record upstream iterator completion when the client remains connected through EOF, but do not require it after a valid terminal event because Codex may close the stream immediately. The final message must match exactly; seeing only a process exit code or HTTP status is not enough.

#### 2. Forced read-only tool loop

This case verifies the agentic path that the fixed-string baseline cannot exercise: model tool call, real local command execution, tool result submission, a second Responses turn, and the final answer.

```bash
CODEX_TOOL_SENTINEL="codex-tool-loop-$(date +%s)-$$"
printf '%s\n' "$CODEX_TOOL_SENTINEL" >"$CODEX_SMOKE_WORK/sentinel.txt"
CODEX_TOOL_EVENTS="$CODEX_SMOKE_ROOT/tool-loop.jsonl"
CODEX_TOOL_FINAL="$CODEX_SMOKE_ROOT/tool-loop-final.txt"
CODEX_TOOL_LOG_START="$(wc -l <"$CODEX_SMOKE_PROXY_LOG")"

codex_smoke \
  "$CODEX_TOOL_FINAL" \
  "$CODEX_TOOL_EVENTS" \
  read-only \
  'You must use the exec_command tool to read sentinel.txt. Do not guess or answer before reading it. Reply with only the exact file contents.'

assert_codex_events "$CODEX_TOOL_EVENTS"
jq -s -e \
  'any(.[]; .type == "item.completed" and .item.type == "command_execution" and .item.status == "completed" and .item.exit_code == 0)' \
  "$CODEX_TOOL_EVENTS" >/dev/null
test "$(cat "$CODEX_TOOL_FINAL")" = "$CODEX_TOOL_SENTINEL"

tail -n "+$((CODEX_TOOL_LOG_START + 1))" \
  "$CODEX_SMOKE_PROXY_LOG" \
  >"$CODEX_SMOKE_ROOT/tool-loop-proxy.log"
test "$(rg -c 'Responses API request summary' "$CODEX_SMOKE_ROOT/tool-loop-proxy.log")" -ge 2
test "$(rg -c 'functionCalls: [1-9][0-9]*' "$CODEX_SMOKE_ROOT/tool-loop-proxy.log")" -ge 1
test "$(rg -c 'functionCallOutputs: [1-9][0-9]*' "$CODEX_SMOKE_ROOT/tool-loop-proxy.log")" -ge 1
test "$(rg -c "event: 'response.completed'" "$CODEX_SMOKE_ROOT/tool-loop-proxy.log")" -ge 2
```

The second request must carry the matching tool-call history and `function_call_output`. Assert terminal `response.completed` events rather than requiring the upstream iterator to reach EOF for every turn: Codex may close the client stream immediately after the terminal event. When auditing exact fields, capture and inspect them at the proxy boundary; do not ask the model whether it received or sent them.

### Responses WebSocket client gate

This is the mandatory second half of `bun run test:live:codex`, not an optional add-on reserved for WebSocket-only changes. The script invokes the real `codex` command with `supports_websockets=true`; the provider opt-in is required in addition to the selected model's live proxy-catalog capability. Run it for every Responses behavior change so future Codex client updates cannot silently turn a green HTTP smoke into assumed WSS coverage.

For Codex CLI `0.144.4`, WebSocket selection is provider-level. The old `responses_websockets` and `responses_websockets_v2` feature flags are removed, and the bundled model catalog does not contain a per-model WebSocket flag. Do not use `--enable` as smoke evidence: set the provider's `supports_websockets` value explicitly, then check the proxy's live `/v1/models?client_version=...` projection for the selected model.

First prove that the proxy's Codex catalog view derives the selected model's flag from current live Copilot metadata:

```bash
export CODEX_SMOKE_SUPPORTS_WEBSOCKETS=true
CODEX_CLIENT_VERSION="$(codex --version | awk '{print $2}')"
curl -fsS \
  "http://127.0.0.1:$CODEX_SMOKE_PORT/v1/models?client_version=$CODEX_CLIENT_VERSION" \
  | jq -e --arg model "$CODEX_SMOKE_MODEL" \
    'any(.models[]; .slug == $model and .supports_websockets == true)' >/dev/null
```

Then repeat the forced read-only tool loop over the WebSocket-enabled provider:

```bash
CODEX_WS_SENTINEL="codex-ws-tool-loop-$(date +%s)-$$"
printf '%s\n' "$CODEX_WS_SENTINEL" >"$CODEX_SMOKE_WORK/ws-sentinel.txt"
CODEX_WS_EVENTS="$CODEX_SMOKE_ROOT/ws-tool-loop.jsonl"
CODEX_WS_FINAL="$CODEX_SMOKE_ROOT/ws-tool-loop-final.txt"
CODEX_WS_LOG_START="$(wc -l <"$CODEX_SMOKE_PROXY_LOG")"

codex_smoke \
  "$CODEX_WS_FINAL" \
  "$CODEX_WS_EVENTS" \
  read-only \
  'You must use the exec_command tool to read ws-sentinel.txt. Do not guess or answer before reading it. Reply with only the exact file contents.'

assert_codex_events "$CODEX_WS_EVENTS"
jq -s -e \
  'any(.[]; .type == "item.completed" and .item.type == "command_execution" and .item.status == "completed" and .item.exit_code == 0)' \
  "$CODEX_WS_EVENTS" >/dev/null
test "$(cat "$CODEX_WS_FINAL")" = "$CODEX_WS_SENTINEL"

tail -n "+$((CODEX_WS_LOG_START + 1))" \
  "$CODEX_SMOKE_PROXY_LOG" \
  >"$CODEX_SMOKE_ROOT/ws-tool-loop-proxy.log"
test "$(rg -c 'Forwarded Responses WebSocket request' "$CODEX_SMOKE_ROOT/ws-tool-loop-proxy.log")" -ge 2
! rg -q -- '--> POST /v1/responses' "$CODEX_SMOKE_ROOT/ws-tool-loop-proxy.log"
```

The paired script is the mandatory base client gate. When the change affects WebSocket connection state, chaining, prewarm, recovery, queueing, or lifecycle behavior, the full WebSocket claim additionally requires all of the following from a temporary redacted transport trace plus Codex JSONL and proxy diagnostics:

- The client uses `GET /v1/responses` with WebSocket Upgrade and receives `101`; the proxy opens `wss://<selected-copilot-host>/responses` and receives a separate upstream `101`.
- The scenario contains no local `POST /v1/responses`, no Codex `transport.fallback_to_http`, and no reconnect between the two turns. A correct final answer after HTTP fallback is a failed WebSocket smoke.
- If Codex opens a separate prewarm socket with `generate: false`, require a local `400 unsupported_value` and zero upstream attempts for that socket. Do not count this expected fail-closed compatibility result as a reconnect or HTTP fallback on the active tool-loop socket.
- One downstream connection maps to one upstream connection. It carries at least two FIFO `response.create` events: the first produces the real local tool call, and the second carries the matching tool output plus the first response's `previous_response_id`. Both requests use `store: false` for the stateless smoke.
- Both Responses turns emit a terminal event (`response.completed`, `response.failed`, `response.incomplete`, or `error`), with the successful scenario requiring `response.completed` for both; Codex emits `turn.completed`, no error/failed event, and the final sentinel matches.
- The active-turn concurrency lease is released after each terminal event, and closing Codex closes both WebSocket sides without a leaked listener, session, queue item, or permit.

The script consumes existing redacted proxy diagnostics for the downstream Upgrade, upstream handshake, forwarded-request connection ID, terminal-event connection ID, HTTP route, `storeFalse`, presence of `previous_response_id`, and whether that ID matches the preceding terminal response. It requires exactly one active connection, at least two alternating forwarded/completed turns with equal counts, `store:false` on every turn, no previous ID on the first turn, a matching previous ID on every later turn, one upstream handshake, and zero HTTP fallback. Its final summary records UTC date, Git SHA and dirty state, local/upstream `101` counts, turn/terminal counts, active-socket count, chain counts, and fallback count. It never retains authorization headers, tokens, response IDs, raw frames, complete prompts, or tool output. Do not claim `generate:false` prewarm evidence when Codex did not send such an event; if it does send one, validate the actual local rejection and zero upstream attempts before recording it. Do not add a fake Codex implementation to obtain that evidence.

The `101` statuses must come from actual handshake evidence. The `Forwarded Responses WebSocket request` debug count proves that frames crossed the proxy but does not, by itself, prove both Upgrade statuses. Do not retain tokens, Authorization headers, complete prompts, tool output, or raw unredacted frames in the evidence record.

### Surface-specific real-machine cases

Run the minimum HTTP/SSE gate for every Responses behavior change so the existing transport remains covered, then add the matching scenario below. WebSocket changes must also run [Responses WebSocket client gate](#responses-websocket-client-gate). A schema merely being present in the first request does not prove that the feature works.

| Changed surface | Required real Codex scenario | Semantic evidence |
| --- | --- | --- |
| Tool handling or `apply_patch` | Isolated `workspace-write` file lifecycle | Codex invokes a real tool, the follow-up request contains the result, and the file is verified outside Codex |
| Structured output | `--output-schema <schema>` | Final output parses and satisfies the schema |
| Image input | `--image <known-local-fixture>` | The real Codex image request succeeds and the answer proves the known image fact |
| Web search | A prompt that requires an actual search | Codex JSONL contains a web-search event and the result uses returned evidence |
| MCP | A disposable real MCP server with a deterministic tool | Codex JSONL contains the MCP call/result and the final answer uses the returned value |
| Responses WebSocket | WebSocket-enabled provider plus the forced tool loop above | Local and upstream `101`, one persistent one-to-one bridge, at least two alternating `response.create`/terminal pairs with equal counts, no `POST` fallback, and the semantic sentinel matches |
| Responses-to-Anthropic translation | The exact Claude model and intended Codex configuration | Proxy logs prove `/v1/responses` translated to the real `/v1/messages` upstream and the terminal SSE is client-compatible |
| Streaming cancellation | Interrupt the real Codex process after the first upstream SSE event | Codex exits within a bound, the captured proxy request does not finish with route status `500`, the proxy listener remains healthy, and an immediate baseline rerun succeeds |

For an `apply_patch` or writable-tool change, use only a temporary Git repository and verify the file from the shell:

```bash
CODEX_SMOKE_WORK="$CODEX_SMOKE_ROOT/write-work"
mkdir -p "$CODEX_SMOKE_WORK"
git -C "$CODEX_SMOKE_WORK" init -q
printf 'before\n' >"$CODEX_SMOKE_WORK/edit-me.txt"

codex_smoke \
  "$CODEX_SMOKE_ROOT/write-final.txt" \
  "$CODEX_SMOKE_ROOT/write.jsonl" \
  workspace-write \
  'Use apply_patch to replace the complete contents of edit-me.txt with a single line containing after. Read the file back, then reply with exactly: write-ok'

assert_codex_events "$CODEX_SMOKE_ROOT/write.jsonl"
jq -s -e \
  'any(.[]; .type == "item.completed" and .item.type == "file_change" and .item.status == "completed")' \
  "$CODEX_SMOKE_ROOT/write.jsonl" >/dev/null
test "$(cat "$CODEX_SMOKE_ROOT/write-final.txt")" = 'write-ok'
test "$(cat "$CODEX_SMOKE_WORK/edit-me.txt")" = 'after'
```

For structured output, validate the artifact rather than accepting a plausible-looking response:

```bash
cat >"$CODEX_SMOKE_ROOT/schema.json" <<'JSON'
{
  "type": "object",
  "properties": {
    "status": { "type": "string", "enum": ["proxy-ok"] }
  },
  "required": ["status"],
  "additionalProperties": false
}
JSON

CODEX_SMOKE_WORK="$CODEX_SMOKE_ROOT/structured-work"
mkdir -p "$CODEX_SMOKE_WORK"
codex_smoke \
  "$CODEX_SMOKE_ROOT/structured-final.json" \
  "$CODEX_SMOKE_ROOT/structured.jsonl" \
  read-only \
  --output-schema "$CODEX_SMOKE_ROOT/schema.json" \
  'Return status proxy-ok.'

assert_codex_events "$CODEX_SMOKE_ROOT/structured.jsonl"
jq -e '.status == "proxy-ok"' "$CODEX_SMOKE_ROOT/structured-final.json" >/dev/null
```

For a Claude translation change, test the default Codex tool set first. Do not silently disable hosted or custom tools just to obtain a green text response. If the intended supported configuration requires overrides, record the default result and then run the restricted positive case, listing every override. A restricted success proves only that scoped configuration, not general Codex-to-Claude compatibility.

### Model-catalog boundary

As verified with `codex-cli 0.144.1` on 2026-07-13, `codex debug models` with a custom provider prints Codex's bundled catalog and does not request that provider's `/v1/models?client_version=...` endpoint. Re-check this behavior after Codex upgrades. Until an actual Codex surface is observed making that request, validate the route separately and label it a route smoke, not a Codex real-machine smoke:

```bash
CODEX_CLIENT_VERSION="$(codex --version | awk '{print $2}')"
curl -fsS \
  "http://127.0.0.1:$CODEX_SMOKE_PORT/v1/models?client_version=$CODEX_CLIENT_VERSION" \
  | jq -e '.models | type == "array" and length > 0' >/dev/null
```

### Evidence record and cleanup

Record the UTC date, Git SHA and dirty state, `codex` path and version, Copilot account type, exact model ID, expected backend, scenario IDs, configuration overrides, Codex exit status, terminal event, semantic assertion, local route, upstream endpoint/status, and stream completion when the client remains connected through EOF. For a WebSocket smoke, additionally record the provider and model `supports_websockets` decisions, local and upstream handshake statuses, downstream/upstream connection correlation, `response.create` and terminal-event counts, `POST` fallback count, reconnect count, and whether both turns used `store: false` with the expected `previous_response_id` chain. Record a `generate: false` prewarm rejection and zero upstream attempts only when the captured client traffic actually contained that event. Emit a redacted summary before cleanup; retain that summary in the surrounding job or terminal log when it supports an upstream-gated decision. Never retain authorization headers, tokens, raw proxy logs, or unredacted user content.

The minimum gate can emit a machine-readable summary without preserving its raw temporary artifacts:

```bash
emit_codex_smoke_summary() {
  local git_dirty
  if [ -s "$CODEX_SMOKE_ROOT/git-status.before" ]; then
    git_dirty=true
  else
    git_dirty=false
  fi

  printf 'date_utc=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
  printf 'git_sha=%s\n' "$(git rev-parse HEAD)"
  printf 'git_dirty=%s\n' "$git_dirty"
  printf 'codex_path=%s\n' "$(command -v codex)"
  printf 'codex_version=%s\n' "$(codex --version)"
  printf 'account_type=%s\n' "$CODEX_SMOKE_ACCOUNT_TYPE"
  printf 'model=%s\n' "$CODEX_SMOKE_MODEL"
  printf 'expected_backend=%s\n' "$CODEX_SMOKE_EXPECTED_BACKEND"
  printf 'proxy_pid=%s\n' "$CODEX_SMOKE_PROXY_PID"
  printf 'proxy_port=%s\n' "$CODEX_SMOKE_PORT"
  cat "$CODEX_SMOKE_ROOT/codex-exits.txt"
  printf 'baseline_turn_completed=true\n'
  printf 'baseline_final_match=true\n'
  printf 'tool_command_completed=true\n'
  printf 'tool_final_match=true\n'
  printf 'local_responses_200=%s\n' \
    "$(rg -c -- '--> POST /v1/responses 200' "$CODEX_SMOKE_PROXY_LOG")"
  printf 'upstream_responses_200=%s\n' \
    "$(rg -c 'Upstream /responses headers received: .*status: 200' "$CODEX_SMOKE_PROXY_LOG")"
  printf 'terminal_response_completed=%s\n' \
    "$(rg -c "event: 'response.completed'" "$CODEX_SMOKE_PROXY_LOG")"
  printf 'upstream_stream_completed=%s\n' \
    "$(rg -c 'Upstream /responses stream completed:' "$CODEX_SMOKE_PROXY_LOG")"
}

emit_codex_smoke_summary
```

Add equivalent scenario-specific assertion fields when running writable tools, structured output, images, web search, MCP, translation, cancellation, or WebSocket cases. For WebSocket, the minimum summary fields are `local_websocket_101=true`, `upstream_websocket_101=true`, `response_create_count>=2`, `terminal_response_completed>=2`, `http_post_fallback_count=0`, `reconnect_count=0`, and `final_match=true`; derive them from redacted evidence rather than hard-coding success. Add `generate_false_local_rejections` and `generate_false_upstream_attempts` only when a real `generate:false` event was observed.

Before leaving the shell, verify that the repository did not change:

```bash
git status --short >"$CODEX_SMOKE_ROOT/git-status.after"
cmp -s \
  "$CODEX_SMOKE_ROOT/git-status.before" \
  "$CODEX_SMOKE_ROOT/git-status.after"
```

Exiting the shell runs the trap, sends `TERM` only to the captured proxy PID, escalates to `KILL` after a bounded wait, verifies that the selected port is no longer listening, and removes the temporary `CODEX_HOME`, work directories, JSONL, final outputs, and logs. Do not modify or delete the user's real `~/.codex` state.

## Claude Code CLI smoke tests

Use a real `claude` CLI smoke when changing Anthropic `/v1/messages` routing, native passthrough sanitization, thinking/output_config handling, tool translation, or Claude Code-specific beta behavior.

Start the proxy on a disposable port first:

```sh
bun run ./src/main.ts start -p 4899
```

Then run Claude Code with temporary local state:

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL="$CLAUDE_MODEL_UNDER_TEST" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model "$CLAUDE_MODEL_UNDER_TEST" \
  --output-format json \
  --no-session-persistence \
  "Reply with exactly: proxy-ok"
```

Expected behavior:

- Claude Code respects `ANTHROPIC_BASE_URL` and calls `POST /v1/messages?beta=true`.
- `ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer ...`; `ANTHROPIC_API_KEY` is sent as `x-api-key`.
- The request normally uses SSE streaming and includes Claude Code beta headers, adaptive thinking, `context_management`, `output_config.effort`, cache-control hints, metadata, and built-in tool schemas.
- The proxy should return a normal Claude Code `result` with `is_error=false`.

Additional high-value smokes:

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL="$CLAUDE_MODEL_UNDER_TEST" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model "$CLAUDE_MODEL_UNDER_TEST" \
  --output-format json \
  --no-session-persistence \
  --permission-mode bypassPermissions \
  --allowedTools=Read \
  --disallowedTools=Bash,Edit \
  "Read package.json and answer with only the package name."
```

This verifies a real tool_use/tool_result loop through `/v1/messages`.

For changes that affect Claude Code request adaptation, native `/v1/messages`
passthrough, tool schemas, thinking/output_config handling, or local tool loops,
run the fuller Claude Code smoke matrix across the current Opus variants instead
of only checking one basic prompt. At minimum, cover each model with:

- a no-tool basic prompt that must return a fixed string
- a `Read`-only local file read from `package.json`
- `--json-schema` structured output and validation of the `structured_output`
  object in Claude Code's JSON result
- an isolated temporary-directory file lifecycle that creates, edits, reads back,
  and externally verifies a file. Use `Write` then `Edit` when the installed
  Claude Code exposes both tools. Claude Code 2.1.197 exposes `Edit` and `Read`
  but not `Write`, so its equivalent chain is `Edit` with an empty old value to
  create the file, another `Edit` to update it, and then `Read`.
- `--effort max` with a fixed-string response

Use temporary `HOME` and temporary work directories for every run. Do not modify
the user's `~/.claude` state or repository files while running this matrix.

```sh
CLAUDE_MODELS_UNDER_TEST="claude-opus-4.8 claude-opus-4.7 claude-opus-4.6"
for CLAUDE_MODEL_UNDER_TEST in $CLAUDE_MODELS_UNDER_TEST; do
  # 1. Basic no-tool fixed response
  # 2. Read-only package.json tool loop
  # 3. --json-schema structured_output validation
  # 4. Temporary file lifecycle using the installed CLI's writable tool surface
  # 5. --effort max fixed response
  # Keep each HOME and writable work directory under /tmp.
  :
done
```

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL="$CLAUDE_MODEL_UNDER_TEST" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model "$CLAUDE_MODEL_UNDER_TEST" \
  --output-format json \
  --no-session-persistence \
  --json-schema '{"type":"object","properties":{"status":{"type":"string"}},"required":["status"],"additionalProperties":false}' \
  "Return status proxy-ok."
```

Claude Code implements `--json-schema` by adding a `StructuredOutput` tool. It does not send Anthropic `output_config.format=json_schema`, so this smoke should succeed when normal tool calls work.

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
env HOME=/tmp/claude-code-proxy-smoke \
ANTHROPIC_BASE_URL=http://127.0.0.1:4899 \
ANTHROPIC_AUTH_TOKEN=dummy \
ANTHROPIC_MODEL="$CLAUDE_MODEL_UNDER_TEST" \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 \
claude --bare -p \
  --model "$CLAUDE_MODEL_UNDER_TEST" \
  --effort max \
  --output-format json \
  --no-session-persistence \
  "Reply with exactly: effort-ok"
```

This smoke is only meaningful after a fresh live probe shows how the selected model handles `output_config.effort="max"`. If the live probe reports a clean unsupported result, Claude Code should surface that API error rather than route around it.

```sh
CLAUDE_MODEL_UNDER_TEST=<claude-model-under-test>
curl -sS http://127.0.0.1:4899/v1/messages/count_tokens \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d "{\"model\":\"$CLAUDE_MODEL_UNDER_TEST\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"Count this short prompt.\"}]}"
```

This checks the Claude-compatible token counting route.

## Important nuance for Anthropic `output_config.format=json_schema`

Do not encode an expected accept/reject result for Anthropic `output_config.format.type="json_schema"` in this document. Run the native Anthropic live probe for the selected model and use that result.

Keep Anthropic `output_config.format.type="json_schema"` on native `/v1/messages` when it is forwarded. Do not route a native rejection through Claude `/chat/completions` as `response_format=json_schema`, because that can produce a schema-invalid 200 response with different semantics.

## Important nuance for Anthropic `output_config.effort=max`

Anthropic `max` is Claude-side reasoning semantics, not a value we should blindly forward to Copilot `/responses` or assume Copilot native Claude accepts.

Do not encode an expected accept/reject result for `output_config.effort` values in this document. Run the live probe for the selected model. If the selected upstream model rejects an effort value cleanly, surface that unsupported error instead of silently changing the request semantics.

The live validation layer therefore treats `/responses` differently:

- First, probe the selected Claude model on its native endpoint.
- Then, if Anthropic-compatible requests are routed onto a Responses-backed model, separately probe the native Copilot/OpenAI-side high-end effort value.

That keeps Claude-specific effort semantics separate from Responses-backed model semantics, with the live probe result as the source of truth.
