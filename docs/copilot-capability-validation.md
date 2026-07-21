# GitHub Copilot capability validation

This document explains what to validate, which repository command to run, and how to judge the result. It does not store dated test results because Copilot behavior can change at any time.

## Rules

1. The client-facing contract comes from the current OpenAI or Anthropic specification.
2. Copilot support comes from a live request to the exact account route, model, and endpoint being changed.
3. HTTP `200` or parser acceptance is not semantic proof.
4. Use repository tests and scripts when they already implement the validation. Do not copy their logic into ad-hoc clients.
5. Re-run the relevant live gate before enabling or changing an upstream-gated behavior.

## Command map

| Change | Command | Validation source |
| --- | --- | --- |
| Local routing or translation | `bun test tests/create-responses.test.ts tests/messages-routing.test.ts tests/routing-policy.test.ts` | Tests in `tests/` |
| Request-signal behavior | `bun test tests/request-signal-regression.test.ts` | `tests/request-signal-regression.test.ts` |
| Recovery, concurrency, or health | `bun test tests/copilot-auth-recovery.test.ts tests/auth-recovery-routes.test.ts tests/concurrency-limiter.test.ts tests/health-routes.test.ts` | Focused tests |
| Full local regression | `bun run test:coverage` | Bun tests plus the critical-file coverage gate |
| Packaged Node listener | `bun run test:node:http` | `scripts/run-node-http-listener-smoke.ts` |
| Live proxy route suite | `COPILOT_LIVE_TEST=1 COPILOT_LIVE_CHAT_MODEL=<chat-model> COPILOT_LIVE_RESPONSES_MODEL=<responses-model> COPILOT_LIVE_EMBEDDING_MODEL=<embedding-model> bun test tests/proxy-live-smoke.test.ts --timeout 600000` | Existing in-process route smoke; not a network-listener substitute |
| Live Copilot capability matrix | `bun run test:live:copilot` | [Probe definitions in the source repository](https://github.com/Jer-y/copilot-proxy/blob/main/tests/live/copilot-capability-matrix.ts) |
| Responses SSE/WSS parity | `bun run test:live:copilot:transport-parity` | `tests/live/copilot-responses-transport-parity.ts` |
| Stateless Responses replay | `bun run test:live:responses-item-replay` | `scripts/run-responses-item-replay-smoke.sh` |
| Real Codex HTTP/WSS | `bun run test:live:codex` | `scripts/run-codex-cli-smoke.sh` |
| Real Claude Code | Run the commands in [Claude Code](#real-claude-code) | Installed `claude` CLI |

## Local validation

Run the focused tests for the changed surface first, then:

```sh
bun run lint:all
bun run typecheck
bun run knip
bun run audit
bun run test:coverage
bun run build
bun run test:node:http
```

For route changes, also send a real HTTP request through a disposable local listener. Mock the Copilot boundary when deterministic fault injection is needed; do not replace the actual local route with a helper call.

## Live Copilot capability matrix

Probe definitions live in [`tests/live/copilot-capability-matrix.ts`](https://github.com/Jer-y/copilot-proxy/blob/main/tests/live/copilot-capability-matrix.ts) in the source repository. Add or change a probe there instead of documenting a manual payload here. The source link is absolute because published npm packages include this guide but do not include the repository test tree.

Required variables:

```sh
COPILOT_LIVE_TEST=1
COPILOT_TOKEN=<copilot-token>
COPILOT_LIVE_CLAUDE_MODEL=<claude-model>       # when probing Messages
COPILOT_LIVE_RESPONSES_MODEL=<responses-model> # when probing Responses
```

Optional controls include:

```sh
COPILOT_ACCOUNT_TYPE=individual|business|enterprise
COPILOT_LIVE_RESPONSES_ONLY=1
COPILOT_LIVE_ANTHROPIC_ONLY=1
COPILOT_LIVE_TIMEOUT_MS=180000
COPILOT_LIVE_RETRY_COUNT=2
```

Run:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN="$COPILOT_TOKEN" \
COPILOT_LIVE_CLAUDE_MODEL="$CLAUDE_MODEL" \
COPILOT_LIVE_RESPONSES_MODEL="$RESPONSES_MODEL" \
bun run test:live:copilot
```

Interpret results as follows:

- `supported`: the probe's configured success check passed. This is not a uniform semantic-support claim. For most Chat Completions, Responses, and raw endpoint probes, it means only that the request was accepted and the expected response envelope or body shape was returned.
- `unsupported`: the upstream returned a clean feature-specific rejection matched by that probe.
- `auth_error`, `rate_limited`, `api_error`, `network_error`, or `unexpected_response`: the run is invalid for making a product decision.

Only report semantic support when a probe or a separate live gate validates the observable feature result. Never copy a generic `status=supported` result into product documentation or a capability claim without identifying the semantic assertion that passed. In particular, the current generic matrix treats these results as acceptance evidence only:

| Probe family | What generic `supported` proves | What is still required for semantic support |
| --- | --- | --- |
| Hosted tool declarations, including web search, file search, MCP, image generation, and computer use | Copilot accepted the tool schema while the probe used `tool_choice:none` | Force or naturally trigger the tool, then validate the completed tool call, result, and citations or resource output |
| `tool_choice` and parallel-tool controls | Copilot accepted the request and returned a response envelope | Verify the requested tool was selected and that required or parallel-call constraints were obeyed |
| Structured output and JSON schema | Copilot accepted the format fields and returned a response envelope | Parse the generated output and validate it against the requested JSON/schema contract |
| Stop, state, reasoning, verbosity, and similar controls | Copilot accepted the field and returned the expected top-level response shape | Validate the observable stop reason, state transition, reasoning artifact, output constraint, or other requested behavior |

A semantic validator must check observable behavior such as:

| Feature | Required semantic evidence |
| --- | --- |
| Structured output | Output parses and satisfies the requested JSON/schema contract |
| Tool choice | The requested tool behavior is observable, not merely accepted |
| Web search | A completed search call plus the expected fact and source URL |
| MCP | Completed tool listing and tool call with the exact deterministic result |
| File search | Known sentinel in results plus the expected file citation |
| Stop conditions | The response stops for the requested reason |
| Warmup/state controls | State changes without unintended output |

## Responses HTTP and WebSocket parity

Run the same feature payload over real HTTP/SSE and native WebSocket:

```sh
COPILOT_LIVE_WS_PARITY=1 \
COPILOT_TOKEN="$COPILOT_TOKEN" \
COPILOT_LIVE_RESPONSES_MODEL="$RESPONSES_MODEL" \
COPILOT_ACCOUNT_TYPE=individual \
bun run test:live:copilot:transport-parity
```

The gate must:

- force HTTP through `stream: true` SSE;
- send the WebSocket form as `response.create`;
- use the same semantic validator for both transports;
- fail on transport-category mismatch or semantic mismatch;
- treat a missing external resource as inconclusive only when the error explicitly identifies that resource.

WebSocket eligibility must come from the current model's explicit `ws:/responses` metadata. Ordinary `/responses` support is insufficient.

For a positive file-search case, set both:

```sh
COPILOT_LIVE_VECTOR_STORE_ID=<vector-store-id>
COPILOT_LIVE_FILE_SEARCH_SENTINEL=<known-file-text>
```

## Stateless Responses replay

```sh
COPILOT_LIVE_ITEM_ID_REPLAY=1 \
COPILOT_LIVE_RESPONSES_MODEL="$RESPONSES_MODEL" \
COPILOT_ACCOUNT_TYPE=individual \
bun run test:live:responses-item-replay
```

The repository script starts a disposable real listener and verifies `store:false`, stable client-visible item IDs, encrypted-reasoning replay, semantic completion, worktree stability, and cleanup.

## Real Codex CLI

Use the installed `codex` command through the repository gate:

```sh
COPILOT_LIVE_CODEX_SMOKE=1 \
CODEX_SMOKE_MODEL=<model-with-ws:/responses> \
CODEX_SMOKE_ACCOUNT_TYPE=individual \
bun run test:live:codex
```

Do not substitute a mock client. The script already isolates `HOME` and `CODEX_HOME`, starts a disposable proxy, and checks both transports.

Success requires:

- a real HTTP/SSE tool loop;
- local and upstream WebSocket `101` handshakes;
- at least two ordered WebSocket turns on one upstream socket;
- a real local command execution;
- correct `store:false` and `previous_response_id` chaining;
- zero HTTP fallback during the WebSocket half;
- listener, temporary-state, and worktree cleanup.

## Real Claude Code

Start a disposable proxy in one terminal:

```sh
COPILOT_ACCOUNT_TYPE=individual
bun run ./src/main.ts start \
  --preset personal \
  --port 4899 \
  --account-type "$COPILOT_ACCOUNT_TYPE" \
  --verbose
```

Use an isolated home in another terminal:

```sh
CLAUDE_SMOKE_HOME="$(mktemp -d)"
CLAUDE_MODEL_UNDER_TEST=<claude-model>

env HOME="$CLAUDE_SMOKE_HOME" \
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

Require `is_error=false`, the exact fixed response, and the requested model in `modelUsage`.

Then run a real tool loop from the repository root:

```sh
env HOME="$CLAUDE_SMOKE_HOME" \
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
  "Use the Read tool to read package.json. Then output only the exact value of its top-level name field as plain text. Do not use Markdown, backticks, quotation marks, or any text before or after the value."
```

Require `is_error=false`, `num_turns >= 2`, `result` exactly equal to `@jer-y/copilot-proxy`, and the requested model in `modelUsage`. The verbose proxy summary for the follow-up `/v1/messages` request must report at least one `assistantToolUseBlocks` and one `toolResultBlocks`; these safe aggregate counts do not expose tool IDs and therefore do not by themselves prove ID matching.

Delete the temporary home and stop the listener after the run. Never use the user's normal Claude state for this smoke.

## Feature-specific cautions

- Responses translated to Messages must explicitly use `store:false`; otherwise persistence semantics cannot be preserved.
- Native Anthropic `output_config.format=json_schema` must remain on `/v1/messages`. Do not retry a native rejection through Chat Completions.
- Test `output_config.effort=max` against the selected current model before relying on it.
- Validate `generate:false` as a no-output warmup. Parser acceptance or ordinary generation is failure.
- Do not infer WebSocket support, MCP support, or file-search support from HTTP `200` alone.

## What to retain

Keep only the information needed to reproduce a result in the CI/job log or issue:

- account type;
- model ID;
- endpoint and transport;
- request shape or probe ID;
- semantic assertion;
- result category;
- relevant safe request IDs.

Do not retain tokens, Authorization headers, prompts, tool output, or raw unredacted frames. Test results are transient evidence and do not belong as dated snapshots in this document.
