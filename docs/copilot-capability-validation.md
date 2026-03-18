# GitHub Copilot Capability Validation for Claude Compatibility Work

This repository already translates Anthropic-compatible requests onto GitHub Copilot upstream APIs. That means some fixes are purely local schema/translation work, while others are only safe if the Copilot upstream endpoint actually accepts the mapped field.

This document is the guardrail for that second category.

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

## Probe matrix

The executable probe definitions live in [tests/live/copilot-capability-matrix.ts](../tests/live/copilot-capability-matrix.ts).

| Probe ID | Candidate fix guarded by this probe | Copilot endpoint | Default model | Expected interpretation |
| --- | --- | --- | --- | --- |
| `baseline-claude-chat-completions` | Any Claude compatibility fix that still routes through chat completions | `/chat/completions` | `claude-opus-4.6` | Must succeed |
| `baseline-claude-responses-unsupported` | Keep Claude requests off Responses unless Copilot changes upstream support | `/responses` | `claude-opus-4.6` | Must return clean `unsupported` |
| `baseline-responses-api` | Any Anthropic -> Responses translation work | `/responses` | `gpt-5.4` | Must succeed |
| `claude-tool-choice-required` | Forward Anthropic `tool_choice` to Claude-backed Copilot chat completions | `/chat/completions` | `claude-opus-4.6` | `supported` or clean `unsupported` |
| `claude-parallel-tool-calls-false` | Map `disable_parallel_tool_use = true` on the Claude chat-completions path | `/chat/completions` | `claude-opus-4.6` | `supported` or clean `unsupported` |
| `claude-reasoning-effort-high` | Validate the default/high Claude reasoning target on chat completions | `/chat/completions` | `claude-opus-4.6` | `supported` or clean `unsupported` |
| `claude-reasoning-effort-max` | Preserve Anthropic `max` on the Claude chat-completions path | `/chat/completions` | `claude-opus-4.6` | `supported` or clean `unsupported` |
| `responses-reasoning-effort-low` | Map `output_config.effort = low` | `/responses` | `gpt-5.4` | `supported` or clean `unsupported` |
| `responses-reasoning-effort-medium` | Map `output_config.effort = medium` | `/responses` | `gpt-5.4` | `supported` or clean `unsupported` |
| `responses-reasoning-effort-high` | Map `output_config.effort = high` | `/responses` | `gpt-5.4` | `supported` or clean `unsupported` |
| `responses-reasoning-effort-xhigh` | Validate the Responses-side adaptation target for Anthropic max-effort on non-Claude models | `/responses` | `gpt-5.4` | `supported` or clean `unsupported` |
| `responses-parallel-tool-calls-false` | Map `disable_parallel_tool_use = true` | `/responses` | `gpt-5.4` | `supported` or clean `unsupported` |
| `responses-input-image-url` | Pass `image.source.type = "url"` upstream | `/responses` | `gpt-5.4` | `supported` or clean `unsupported` |

## How to run the live probes

The live suite is intentionally opt-in. It is skipped during normal `bun test` runs unless `COPILOT_LIVE_TEST=1` is set.

Required environment variables:

- `COPILOT_LIVE_TEST=1`
- `COPILOT_TOKEN=<your GitHub Copilot bearer token>`

Optional environment variables:

- `COPILOT_ACCOUNT_TYPE=individual|business|enterprise`
- `COPILOT_VSCODE_VERSION=1.104.3`
- `COPILOT_LIVE_CLAUDE_MODEL=claude-opus-4.6`
- `COPILOT_LIVE_RESPONSES_MODEL=gpt-5.4`
- `COPILOT_LIVE_IMAGE_URL=https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png`
- `COPILOT_LIVE_TIMEOUT_MS=180000`

Example:

```sh
COPILOT_LIVE_TEST=1 \
COPILOT_TOKEN=ghu_xxx \
COPILOT_LIVE_CLAUDE_MODEL=claude-opus-4.6 \
COPILOT_LIVE_RESPONSES_MODEL=gpt-5.4 \
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

## How to use the results

Use the probe outcome to decide how aggressive the proxy should be:

- If a probe is `supported`, we can confidently wire the corresponding translation path and add normal unit coverage.
- If a probe is `unsupported`, keep the local parsing improvement but omit or downgrade the upstream field.
- If a probe fails for environmental reasons, rerun the suite before making routing or translation decisions.

## Important nuance for Anthropic `output_config.effort=max`

Anthropic `max` is Claude-side reasoning semantics, not a value we should blindly forward to Copilot `/responses`.

The live validation layer therefore treats `/responses` differently:

- First, verify that Claude itself is still rejected on `/responses`.
- Then, if Anthropic-compatible requests are routed onto a Responses-backed model, probe the native Copilot/OpenAI-side high-end value `reasoning.effort = "xhigh"`.

That keeps Claude-specific `max` logic on the `/chat/completions` path where it belongs, while still giving us a validated adaptation target for non-Claude Responses-backed models.
