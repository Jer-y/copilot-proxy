import type { AnthropicMessagesPayload } from '~/lib/translation/types'
import type { ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload } from '~/services/copilot/create-responses'

export interface LiveCopilotProbeConfig {
  claudeModel: string
  responsesModel: string
  imageUrl: string
  fileUrl: string
}

export interface ProbeErrorDetails {
  status: number
  code?: string
  message?: string
  rawBody?: string
}

export type CapabilityProbeEndpoint = 'chat-completions' | 'responses' | 'responses-raw' | 'anthropic-messages' | 'anthropic-raw' | 'anthropic-files'
export type CapabilityProbeTier = 'baseline' | 'optional'
export type CapabilityProbeExpectation
  = | 'must_support'
    | 'must_be_unsupported'
    | 'support_or_clean_unsupported'

export interface CapabilityProbeBase {
  id: string
  title: string
  tier: CapabilityProbeTier
  endpoint: CapabilityProbeEndpoint
  candidateFix: string
  candidateMapping: string
  rationale: string
  expectation: CapabilityProbeExpectation
  isUnsupported?: (details: ProbeErrorDetails) => boolean
}

export interface ChatCompletionsCapabilityProbe extends CapabilityProbeBase {
  endpoint: 'chat-completions'
  buildPayload: (config: LiveCopilotProbeConfig) => ChatCompletionsPayload
}

export interface ResponsesCapabilityProbe extends CapabilityProbeBase {
  endpoint: 'responses'
  buildPayload: (config: LiveCopilotProbeConfig) => ResponsesPayload | ResponsesReasoningProbePayload
}

export interface RawResponsesProbeRequest {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: Record<string, unknown>
  expectedBody?: 'any' | 'response' | 'response_stream' | 'input_tokens'
  model?: string
}

export interface RawResponsesCapabilityProbe extends CapabilityProbeBase {
  endpoint: 'responses-raw'
  buildRequest: (config: LiveCopilotProbeConfig) => RawResponsesProbeRequest
}

export interface AnthropicMessagesCapabilityProbe extends CapabilityProbeBase {
  endpoint: 'anthropic-messages'
  buildPayload: (config: LiveCopilotProbeConfig) => AnthropicMessagesPayload
}

export interface RawAnthropicProbeRequest {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  body?: Record<string, unknown>
  headers?: Record<string, string>
  expectedBody?: 'any' | 'message_stream' | 'input_tokens' | 'list'
  model?: string
}

export interface RawAnthropicCapabilityProbe extends CapabilityProbeBase {
  endpoint: 'anthropic-raw'
  buildRequest: (config: LiveCopilotProbeConfig) => RawAnthropicProbeRequest
}

export interface AnthropicFilesCapabilityProbe extends CapabilityProbeBase {
  endpoint: 'anthropic-files'
  buildPayload: (config: LiveCopilotProbeConfig) => { headers?: Record<string, string> }
}

export type CapabilityProbe = ChatCompletionsCapabilityProbe | ResponsesCapabilityProbe | RawResponsesCapabilityProbe | AnthropicMessagesCapabilityProbe | RawAnthropicCapabilityProbe | AnthropicFilesCapabilityProbe

interface ResponsesReasoningProbePayload extends Omit<ResponsesPayload, 'reasoning'> {
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    summary?: 'auto' | 'concise' | 'detailed' | 'none'
    generate_summary?: 'auto' | 'concise' | 'detailed' | null
  }
}

const NOOP_TOOL_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const

const TINY_PNG_DATA_URL
  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABjElEQVR4nAXBkQIAIAxAweEwDMMwDMNhOByGw/39604QQYUmdGEIU1jCFo5gwhVcCOEJKZQIoqjSlK4MZSpL2cpRTLmKK6E8JZVSQRraaI3eGI3ZWI3dOA1r3IY3ovEa2agmSEc7rdM7ozM7q7M7p2Od2/FOdF4nO9UFGeigDfpgDOZgDfbgDGxwBz6IwRvkoIYgE520SZ+MyZysyZ6ciU3uxCcxeZOc1BRkoYu26IuxmIu12IuzsMVd+CIWb5GLWoJsdNM2fTM2c7M2e3M2trkb38TmbXJTW5CDHtqhH8ZhHtZhH87BDvfghzi8Qx7qCGKo0YxuDGMay9jGMcy4hhthPCONMkEuemmXfhmXeVmXfTkXu9yLX+LyLnmpK4ijTnO6M5zpLGc7xzHnOu6E85x0ygUJNGhBD0YwgxXs4AQW3MCDCF6QQYUgD320R3+Mx3ysx36chz3uwx/xeI981BMk0aQlPRnJTFayk5NYchNPInlJJpWCFFq0ohejmMUqdnEKK27hRRSvyKLqA5W0dxDdq+ReAAAAAElFTkSuQmCC'

function buildUnsupportedMatcher(fieldTerms: Array<string>) {
  return (details: ProbeErrorDetails): boolean => {
    const haystack = [
      details.code,
      details.message,
      details.rawBody,
    ]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n')
      .toLowerCase()

    if (!haystack) {
      return false
    }

    if (haystack.includes('unsupported_api_for_model')) {
      return true
    }

    if (
      haystack.includes('allowedpartnermodelfeatures')
      || haystack.includes('disallowed feature')
      || haystack.includes('organization policy constraint')
    ) {
      return true
    }

    const mentionsField = fieldTerms.some(term => haystack.includes(term.toLowerCase()))
    if (!mentionsField) {
      return false
    }

    return [
      'unsupported',
      'not supported',
      'does not support',
      'unknown',
      'unrecognized',
      'unexpected',
      'invalid',
      'must be one of',
      'additional properties',
      'not allowed',
      'not permitted',
      'does not match',
    ].some(term => haystack.includes(term))
  }
}

function buildNotFoundOrUnsupportedMatcher(fieldTerms: Array<string>) {
  const unsupportedMatcher = buildUnsupportedMatcher(fieldTerms)
  return (details: ProbeErrorDetails): boolean => details.status === 404 || unsupportedMatcher(details)
}

function buildResponsesReasoningProbePayload(
  config: LiveCopilotProbeConfig,
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
): ResponsesReasoningProbePayload {
  return {
    model: config.responsesModel,
    input: 'Reply with the single word OK.',
    max_output_tokens: 16,
    reasoning: {
      effort,
    },
  }
}

function buildBasicResponsesPayload(config: LiveCopilotProbeConfig): ResponsesPayload {
  return {
    model: config.responsesModel,
    input: 'Reply with the single word OK.',
    max_output_tokens: 16,
  }
}

function buildAnthropicBasicPayload(config: LiveCopilotProbeConfig, model = config.claudeModel): AnthropicMessagesPayload {
  return {
    model,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
  }
}

function toAnthropicHyphenAlias(model: string): string {
  return model.replace(/-(\d)\.(\d)$/, '-$1-$2')
}

function buildNoopResponsesToolPayload(config: LiveCopilotProbeConfig): ResponsesPayload {
  return {
    model: config.responsesModel,
    input: 'Call the noop tool exactly once.',
    max_output_tokens: 64,
    tools: [
      {
        type: 'function',
        name: 'noop',
        description: 'A no-op tool used for capability probing.',
        parameters: { ...NOOP_TOOL_SCHEMA },
      },
    ],
    tool_choice: 'required',
  }
}

function buildHostedToolPresencePayload(
  config: LiveCopilotProbeConfig,
  tool: NonNullable<ResponsesPayload['tools']>[number],
): ResponsesPayload {
  return {
    model: config.responsesModel,
    input: 'Reply with OK without using tools.',
    max_output_tokens: 16,
    tools: [tool],
    tool_choice: 'none',
  }
}

export const copilotCapabilityProbes: Array<CapabilityProbe> = [
  {
    id: 'baseline-claude-chat-completions',
    title: 'Claude model works on /chat/completions',
    tier: 'baseline',
    endpoint: 'chat-completions',
    candidateFix: 'Any Claude compatibility fix that still routes through /chat/completions.',
    candidateMapping: 'Claude-compatible Anthropic payload -> Copilot /chat/completions',
    rationale: 'This establishes that the upstream Claude path is healthy before testing feature-specific flags.',
    expectation: 'must_support',
    buildPayload: config => ({
      model: config.claudeModel,
      messages: [
        {
          role: 'user',
          content: 'Reply with the single word OK.',
        },
      ],
      max_tokens: 16,
      temperature: 0,
    }),
  },
  {
    id: 'baseline-claude-responses-unsupported',
    title: 'Claude model is rejected on /responses',
    tier: 'baseline',
    endpoint: 'responses',
    candidateFix: 'Keep Claude-compatible Anthropic requests pinned to Copilot /chat/completions unless this probe changes upstream.',
    candidateMapping: 'Claude model -> Copilot /responses',
    rationale: 'Before translating Claude-specific features, confirm the model is still chat-completions-only upstream rather than assuming it from static config.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'unsupported_api_for_model',
      'responses api',
      'does not support responses',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      input: 'Reply with the single word OK.',
      max_output_tokens: 16,
    }),
  },
  {
    id: 'baseline-responses-api',
    title: 'Responses-capable model works on /responses',
    tier: 'baseline',
    endpoint: 'responses',
    candidateFix: 'Any Anthropic -> Responses translation that targets Copilot /responses.',
    candidateMapping: 'Anthropic-compatible request -> Copilot /responses',
    rationale: 'This confirms credentials, endpoint health, and the chosen Responses model before optional feature probes run.',
    expectation: 'must_support',
    buildPayload: config => ({
      model: config.responsesModel,
      input: 'Reply with the single word OK.',
      max_output_tokens: 16,
    }),
  },
  {
    id: 'baseline-responses-model-chat-completions-unsupported',
    title: 'Responses-only model is rejected on /chat/completions',
    tier: 'baseline',
    endpoint: 'chat-completions',
    candidateFix: 'Keep the configured Responses-only model routed to Copilot /responses.',
    candidateMapping: 'Responses-only model -> Copilot /chat/completions',
    rationale: 'This catches accidental fallback of the configured Responses-only model to /chat/completions.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'unsupported_api_for_model',
      'chat completions',
      'chat/completions',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      messages: [
        {
          role: 'user',
          content: 'Reply with the single word OK.',
        },
      ],
      max_tokens: 16,
      temperature: 0,
    }),
  },
  {
    id: 'responses-streaming',
    title: 'Responses streaming emits SSE lifecycle events',
    tier: 'baseline',
    endpoint: 'responses-raw',
    candidateFix: 'Keep streaming Requests on Copilot /responses for Responses-only models.',
    candidateMapping: 'OpenAI Responses stream=true -> Copilot /responses SSE',
    rationale: 'Streaming is a core Responses API mode and cannot be validated through the non-streaming createResponses helper.',
    expectation: 'must_support',
    buildRequest: config => ({
      method: 'POST',
      path: '/responses',
      body: {
        model: config.responsesModel,
        input: 'Say hello.',
        stream: true,
        max_output_tokens: 32,
      },
      expectedBody: 'response_stream',
      model: config.responsesModel,
    }),
  },
  {
    id: 'responses-stream-options-include-obfuscation-false',
    title: 'Responses streaming accepts stream_options.include_obfuscation=false',
    tier: 'optional',
    endpoint: 'responses-raw',
    candidateFix: 'Forward stream_options only if Copilot accepts the official Responses streaming options object.',
    candidateMapping: 'OpenAI Responses stream_options.include_obfuscation=false -> Copilot /responses SSE',
    rationale: 'stream_options is part of the official streaming request surface and is not exercised by plain stream=true.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'stream_options',
      'include_obfuscation',
      'obfuscation',
    ]),
    buildRequest: config => ({
      method: 'POST',
      path: '/responses',
      body: {
        model: config.responsesModel,
        input: 'Say hello.',
        stream: true,
        stream_options: {
          include_obfuscation: false,
        },
        max_output_tokens: 32,
      },
      expectedBody: 'response_stream',
      model: config.responsesModel,
    }),
  },
  {
    id: 'claude-tool-choice-required',
    title: 'Claude /chat/completions accepts tool_choice=required',
    tier: 'optional',
    endpoint: 'chat-completions',
    candidateFix: 'Forward Anthropic tool_choice to Claude-backed Copilot chat-completions only if upstream accepts it.',
    candidateMapping: 'Anthropic tool_choice:any/tool -> Copilot chat-completions tool_choice',
    rationale: 'This probe tells us whether the selected Claude chat-completions path accepts tool choice constraints upstream.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'tool_choice',
      'tool choice',
      'tools',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      messages: [
        {
          role: 'user',
          content: 'Call the noop tool exactly once.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'noop',
            description: 'A no-op tool used for capability probing.',
            parameters: { ...NOOP_TOOL_SCHEMA },
          },
        },
      ],
      tool_choice: 'required',
      max_tokens: 64,
      temperature: 0,
    }),
  },
  {
    id: 'claude-parallel-tool-calls-false',
    title: 'Claude /chat/completions accepts parallel_tool_calls=false',
    tier: 'optional',
    endpoint: 'chat-completions',
    candidateFix: 'Map Anthropic disable_parallel_tool_use=true to Claude-backed Copilot chat-completions only if upstream accepts parallel_tool_calls=false.',
    candidateMapping: 'Anthropic tool_choice.disable_parallel_tool_use=true -> Copilot chat-completions parallel_tool_calls=false',
    rationale: 'Parallel tool execution control is part of Claude compatibility too, so we should validate it on the actual Claude upstream path rather than infer it from Responses behavior.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'parallel_tool_calls',
      'parallel tool calls',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      messages: [
        {
          role: 'user',
          content: 'Reply with the single word OK without using tools.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'noop',
            description: 'A no-op tool used for capability probing.',
            parameters: { ...NOOP_TOOL_SCHEMA },
          },
        },
      ],
      parallel_tool_calls: false,
      max_tokens: 64,
      temperature: 0,
    }),
  },
  {
    id: 'claude-reasoning-effort-high',
    title: 'Claude /chat/completions accepts reasoning_effort=high',
    tier: 'optional',
    endpoint: 'chat-completions',
    candidateFix: 'Map Anthropic adaptive/default reasoning onto Copilot chat-completions reasoning_effort=high only if the Claude upstream accepts it.',
    candidateMapping: 'Anthropic adaptive/high reasoning -> Copilot chat-completions reasoning_effort=high',
    rationale: 'Claude-compatible adaptive thinking needs a validated chat-completions-side effort target before we send it by default.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning_effort',
      'reasoning effort',
      'high',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      messages: [
        {
          role: 'user',
          content: 'Reply with the single word OK.',
        },
      ],
      reasoning_effort: 'high',
      max_tokens: 16,
      temperature: 0,
    }),
  },
  {
    id: 'claude-reasoning-effort-max',
    title: 'Claude /chat/completions accepts reasoning_effort=max',
    tier: 'optional',
    endpoint: 'chat-completions',
    candidateFix: 'Preserve Anthropic output_config.effort=max on the Claude chat-completions path only if Copilot accepts raw reasoning_effort=max.',
    candidateMapping: 'Anthropic output_config.effort=max -> Copilot chat-completions reasoning_effort=max',
    rationale: 'Anthropic max-effort is Claude-specific, so this probe tells us whether we can preserve it directly on the Claude path for this model.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning_effort',
      'reasoning effort',
      'max',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      messages: [
        {
          role: 'user',
          content: 'Reply with the single word OK.',
        },
      ],
      reasoning_effort: 'max',
      max_tokens: 16,
      temperature: 0,
    }),
  },
  {
    id: 'responses-reasoning-effort-none',
    title: 'Responses accepts reasoning.effort=none',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Allow explicit no-reasoning Responses requests only if Copilot accepts reasoning.effort=none.',
    candidateMapping: 'OpenAI Responses reasoning.effort=none -> Copilot /responses',
    rationale: 'The selected Responses model may accept or cleanly reject none as a latency-first reasoning setting.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'effort',
      'none',
    ]),
    buildPayload: config => buildResponsesReasoningProbePayload(config, 'none'),
  },
  {
    id: 'responses-reasoning-effort-low',
    title: 'Responses accepts reasoning.effort=low',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Map Anthropic output_config.effort or thinking hints to Copilot reasoning.effort only if low is accepted.',
    candidateMapping: 'Anthropic output_config.effort=low -> Responses reasoning.effort=low',
    rationale: 'Low effort is the least risky mapping and the cheapest first signal for upstream reasoning support.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'effort',
      'low',
    ]),
    buildPayload: config => buildResponsesReasoningProbePayload(config, 'low'),
  },
  {
    id: 'responses-reasoning-effort-medium',
    title: 'Responses accepts reasoning.effort=medium',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Map Anthropic output_config.effort or thinking hints to Copilot reasoning.effort only if medium is accepted.',
    candidateMapping: 'Anthropic output_config.effort=medium -> Responses reasoning.effort=medium',
    rationale: 'Medium effort is a plausible default for translated Anthropic requests once we know Copilot accepts it.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'effort',
      'medium',
    ]),
    buildPayload: config => buildResponsesReasoningProbePayload(config, 'medium'),
  },
  {
    id: 'responses-reasoning-effort-high',
    title: 'Responses accepts reasoning.effort=high',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Map Anthropic output_config.effort or thinking hints to Copilot reasoning.effort only if high is accepted.',
    candidateMapping: 'Anthropic output_config.effort=high -> Responses reasoning.effort=high',
    rationale: 'High effort is a likely translation target for Claude-thinking heuristics in the proxy.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'effort',
      'high',
    ]),
    buildPayload: config => buildResponsesReasoningProbePayload(config, 'high'),
  },
  {
    id: 'responses-reasoning-effort-xhigh',
    title: 'Responses accepts reasoning.effort=xhigh',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'If Anthropic max-effort needs an adaptation on Responses-backed models, only target Copilot reasoning.effort=xhigh once upstream support is confirmed.',
    candidateMapping: 'Anthropic output_config.effort=max -> Responses reasoning.effort=xhigh',
    rationale: 'Anthropic max-effort is Claude-specific; this probe validates the selected Responses model before using xhigh as a mapping target.',
    expectation: 'must_support',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'effort',
      'xhigh',
    ]),
    buildPayload: config => buildResponsesReasoningProbePayload(config, 'xhigh'),
  },
  {
    id: 'responses-reasoning-effort-minimal-unsupported',
    title: 'Responses rejects reasoning.effort=minimal',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Do not send reasoning.effort=minimal to Copilot /responses unless upstream starts accepting it.',
    candidateMapping: 'OpenAI Responses reasoning.effort=minimal -> Copilot /responses',
    rationale: 'Some OpenAI clients can emit minimal; this probe records whether the selected Responses model accepts or cleanly rejects it.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'effort',
      'minimal',
    ]),
    buildPayload: config => buildResponsesReasoningProbePayload(config, 'minimal'),
  },
  {
    id: 'responses-reasoning-summary-auto',
    title: 'Responses accepts reasoning.summary=auto',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve reasoning.summary=auto for Responses-backed models if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses reasoning.summary=auto -> Copilot /responses',
    rationale: 'Reasoning summaries are a Responses-native capability and should be probed independently from effort values.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'summary',
    ]),
    buildPayload: config => ({
      ...buildResponsesReasoningProbePayload(config, 'low'),
      reasoning: {
        effort: 'low',
        summary: 'auto',
      },
    }),
  },
  {
    id: 'responses-reasoning-summary-concise',
    title: 'Responses accepts reasoning.summary=concise',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve reasoning.summary=concise for Responses-backed models if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses reasoning.summary=concise -> Copilot /responses',
    rationale: 'The official Responses reasoning schema exposes concise summaries separately from auto.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'summary',
      'concise',
    ]),
    buildPayload: config => ({
      ...buildResponsesReasoningProbePayload(config, 'low'),
      reasoning: {
        effort: 'low',
        summary: 'concise',
      },
    }),
  },
  {
    id: 'responses-reasoning-summary-detailed',
    title: 'Responses accepts reasoning.summary=detailed',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve reasoning.summary=detailed for Responses-backed models if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses reasoning.summary=detailed -> Copilot /responses',
    rationale: 'Detailed summaries are a distinct official reasoning-summary level and can have different model support from auto or concise.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'summary',
      'detailed',
    ]),
    buildPayload: config => ({
      ...buildResponsesReasoningProbePayload(config, 'low'),
      reasoning: {
        effort: 'low',
        summary: 'detailed',
      },
    }),
  },
  {
    id: 'responses-reasoning-generate-summary-auto-deprecated',
    title: 'Responses accepts deprecated reasoning.generate_summary=auto',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward or normalize deprecated generate_summary only after Copilot behavior is known.',
    candidateMapping: 'OpenAI Responses reasoning.generate_summary=auto -> Copilot /responses',
    rationale: 'The OpenAPI schema lists generate_summary as deprecated, so older clients may emit it.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'reasoning',
      'generate_summary',
      'summary',
    ]),
    buildPayload: config => ({
      ...buildResponsesReasoningProbePayload(config, 'low'),
      reasoning: {
        effort: 'low',
        generate_summary: 'auto',
      },
    }),
  },
  {
    id: 'responses-include-encrypted-reasoning',
    title: 'Responses accepts include=reasoning.encrypted_content',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Pass encrypted reasoning include flags through for stateless Responses clients only if Copilot accepts them.',
    candidateMapping: 'OpenAI Responses include reasoning.encrypted_content -> Copilot /responses',
    rationale: 'Encrypted reasoning is the official stateless alternative to server-side response state.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'include',
      'encrypted_content',
      'reasoning.encrypted_content',
    ]),
    buildPayload: config => ({
      ...buildResponsesReasoningProbePayload(config, 'low'),
      include: ['reasoning.encrypted_content'],
      store: false,
    }),
  },
  {
    id: 'responses-include-output-logprobs',
    title: 'Responses accepts include=message.output_text.logprobs',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward output logprob requests only if Copilot accepts both include and top_logprobs.',
    candidateMapping: 'OpenAI Responses include message.output_text.logprobs + top_logprobs -> Copilot /responses',
    rationale: 'The official include enum exposes output text logprobs, and top_logprobs is the corresponding output-control field.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'include',
      'message.output_text.logprobs',
      'top_logprobs',
      'logprobs',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      include: ['message.output_text.logprobs'],
      top_logprobs: 1,
    }),
  },
  {
    id: 'responses-include-input-image-url',
    title: 'Responses accepts include=message.input_image.image_url',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward input image URL include flags only if Copilot accepts the include value with image input.',
    candidateMapping: 'OpenAI Responses include message.input_image.image_url -> Copilot /responses',
    rationale: 'The official include enum can ask the response to echo input image URLs, which is separate from accepting the image part itself.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'include',
      'message.input_image.image_url',
      'image_url',
      'input_image',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Reply with OK.',
            },
            {
              type: 'input_image',
              image_url: TINY_PNG_DATA_URL,
            },
          ],
        },
      ],
      include: ['message.input_image.image_url'],
      max_output_tokens: 16,
    }),
  },
  {
    id: 'responses-text-verbosity-low',
    title: 'Responses accepts text.verbosity=low',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve text.verbosity=low for Responses-backed models if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses text.verbosity=low -> Copilot /responses',
    rationale: 'Some Responses models expose verbosity as a first-class output-length control.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'text',
      'verbosity',
      'low',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      text: { verbosity: 'low' },
    }),
  },
  {
    id: 'responses-text-verbosity-medium',
    title: 'Responses accepts text.verbosity=medium',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve text.verbosity=medium for Responses-backed models if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses text.verbosity=medium -> Copilot /responses',
    rationale: 'Medium is the documented neutral verbosity setting for Responses models that support verbosity.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'text',
      'verbosity',
      'medium',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      text: { verbosity: 'medium' },
    }),
  },
  {
    id: 'responses-text-verbosity-high',
    title: 'Responses accepts text.verbosity=high',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve text.verbosity=high for Responses-backed models if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses text.verbosity=high -> Copilot /responses',
    rationale: 'High verbosity should be validated separately because it changes generation constraints without changing reasoning effort.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'text',
      'verbosity',
      'high',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      text: { verbosity: 'high' },
    }),
  },
  {
    id: 'responses-prompt-cache-key',
    title: 'Responses accepts prompt_cache_key',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward prompt_cache_key for Responses requests only if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses prompt_cache_key -> Copilot /responses',
    rationale: 'Prompt cache keys are part of the official cache-control surface for repeated traffic.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'prompt_cache_key',
      'cache',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      prompt_cache_key: 'copilot-proxy-live-probe',
    }),
  },
  {
    id: 'responses-prompt-cache-retention-24h',
    title: 'Responses accepts prompt_cache_retention=24h',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward prompt_cache_retention only if Copilot accepts the official cache-retention field.',
    candidateMapping: 'OpenAI Responses prompt_cache_retention=24h -> Copilot /responses',
    rationale: 'The official Responses schema exposes prompt cache retention separately from prompt_cache_key, and GPT-5.5 requires 24h extended prompt caching.',
    expectation: 'must_support',
    isUnsupported: buildUnsupportedMatcher([
      'prompt_cache_retention',
      'cache retention',
      'cache',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      prompt_cache_retention: '24h',
    }),
  },
  {
    id: 'responses-metadata',
    title: 'Responses accepts metadata',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve metadata on Responses requests only if Copilot accepts the official metadata field.',
    candidateMapping: 'OpenAI Responses metadata -> Copilot /responses',
    rationale: 'Metadata is part of the shared Responses request surface and can be emitted by OpenAI-compatible clients.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'metadata',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      metadata: {
        probe: 'copilot-capability-matrix',
      },
    }),
  },
  {
    id: 'responses-safety-identifier',
    title: 'Responses accepts safety_identifier',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward safety_identifier only if Copilot accepts the official abuse-detection identifier field.',
    candidateMapping: 'OpenAI Responses safety_identifier -> Copilot /responses',
    rationale: 'The OpenAPI schema replaces the deprecated user field with safety_identifier for abuse detection.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'safety_identifier',
      'safety identifier',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      safety_identifier: 'copilot-proxy-live-probe',
    }),
  },
  {
    id: 'responses-user-deprecated',
    title: 'Responses accepts deprecated user',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward or normalize deprecated user only after Copilot behavior is known.',
    candidateMapping: 'OpenAI Responses user -> Copilot /responses',
    rationale: 'The OpenAPI schema still accepts user as a deprecated compatibility field, and older clients may still send it.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'user',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      user: 'copilot-proxy-live-probe',
    }),
  },
  {
    id: 'responses-truncation-auto',
    title: 'Responses accepts truncation=auto',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward truncation=auto for Responses requests only if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses truncation=auto -> Copilot /responses',
    rationale: 'Automatic truncation is part of the official Responses context-window management surface.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'truncation',
      'auto',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      truncation: 'auto',
    }),
  },
  {
    id: 'responses-context-management',
    title: 'Responses accepts context_management',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward server-side context_management only if Copilot accepts the documented shape.',
    candidateMapping: 'OpenAI Responses context_management -> Copilot /responses',
    rationale: 'Server-side context management is a distinct official Responses capability from the compact endpoint.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'context_management',
      'compact_threshold',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      store: false,
      context_management: [
        {
          type: 'compaction',
          compact_threshold: 1000,
        },
      ],
    }),
  },
  {
    id: 'responses-conversation',
    title: 'Responses accepts conversation state field',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward the official conversation field only with live coverage for the selected Responses model.',
    candidateMapping: 'OpenAI Responses conversation -> Copilot /responses',
    rationale: 'Conversation state and previous_response_id can have different upstream support; probe them separately for the selected model.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'conversation',
      'conv_live_probe_missing',
      'not found',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      conversation: 'conv_live_probe_missing',
    }),
  },
  {
    id: 'responses-prompt-template',
    title: 'Responses accepts prompt template references',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward prompt template references only if Copilot accepts the official prompt object.',
    candidateMapping: 'OpenAI Responses prompt.id -> Copilot /responses',
    rationale: 'Reusable prompt templates are part of the official Responses request surface, but Copilot may not expose OpenAI prompt resources.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'prompt',
      'pmpt_live_probe_missing',
      'not found',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      prompt: {
        id: 'pmpt_live_probe_missing',
        variables: {},
      },
    }),
  },
  {
    id: 'responses-store-false',
    title: 'Responses accepts store=false',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve store=false for stateless Responses clients if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses store=false -> Copilot /responses',
    rationale: 'Stateless clients use store=false together with returned items or encrypted reasoning.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'store',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      store: false,
    }),
  },
  {
    id: 'responses-store-true-unsupported',
    title: 'Responses rejects store=true',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Do not claim server-side stored response state unless Copilot accepts store=true.',
    candidateMapping: 'OpenAI Responses store=true -> Copilot /responses',
    rationale: 'Stored response state is required by previous_response_id and retrieve/cancel flows; this probe records whether the selected backend exposes it.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'store',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      store: true,
    }),
  },
  {
    id: 'responses-previous-response-id-unsupported',
    title: 'Responses rejects previous_response_id',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Keep multi-turn state stateless until Copilot supports previous_response_id.',
    candidateMapping: 'OpenAI Responses previous_response_id -> Copilot /responses',
    rationale: 'previous_response_id is the official stateful follow-up mechanism, but it depends on stored response state.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'previous_response_id',
      'previous response',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      previous_response_id: 'resp_live_probe_missing',
    }),
  },
  {
    id: 'responses-background-unsupported',
    title: 'Responses rejects background=true',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Do not advertise background Responses jobs unless Copilot supports background=true.',
    candidateMapping: 'OpenAI Responses background=true -> Copilot /responses',
    rationale: 'Background mode is required for long-running async Responses and cancellation flows.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'background',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      background: true,
    }),
  },
  {
    id: 'responses-background-stream-unsupported',
    title: 'Responses rejects background=true with stream=true',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Do not combine background and streaming on Copilot unless upstream begins accepting that mode.',
    candidateMapping: 'OpenAI Responses background+stream -> Copilot /responses',
    rationale: 'Background streaming is a separate async event flow from plain streaming.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'background',
      'stream',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      background: true,
      stream: true,
    }),
  },
  {
    id: 'responses-service-tier-auto-unsupported',
    title: 'Responses rejects service_tier=auto',
    tier: 'optional',
    endpoint: 'responses-raw',
    candidateFix: 'Avoid forwarding unsupported service_tier values to Copilot unless upstream changes.',
    candidateMapping: 'OpenAI Responses service_tier=auto -> Copilot /responses',
    rationale: 'OpenAI-compatible clients may send service_tier. This probe bypasses local sanitization so it tests the GitHub backend directly.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'service_tier',
      'service tier',
    ]),
    buildRequest: config => ({
      method: 'POST',
      path: '/responses',
      body: {
        model: config.responsesModel,
        input: 'Reply with the single word OK.',
        max_output_tokens: 16,
        service_tier: 'auto',
      },
      expectedBody: 'response',
      model: config.responsesModel,
    }),
  },
  {
    id: 'responses-max-tool-calls-1',
    title: 'Responses accepts max_tool_calls=1',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward max_tool_calls for Responses-backed tool loops only if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses max_tool_calls -> Copilot /responses',
    rationale: 'Tool-loop limiting is part of the official Responses agentic control surface.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'max_tool_calls',
      'max tool calls',
    ]),
    buildPayload: config => ({
      ...buildNoopResponsesToolPayload(config),
      max_tool_calls: 1,
    }),
  },
  {
    id: 'responses-function-call-output-input',
    title: 'Responses accepts function_call_output input items',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Pass stateless tool-result turns through Responses only if Copilot accepts function_call/function_call_output input items.',
    candidateMapping: 'OpenAI Responses function_call_output input -> Copilot /responses',
    rationale: 'Stateless tool loops in Responses can replay function call items directly in input, independent of previous_response_id.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'function_call',
      'function_call_output',
      'call_id',
      'input',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: [
        {
          type: 'function_call',
          id: 'fc_live_probe_noop',
          call_id: 'call_live_probe_noop',
          name: 'noop',
          arguments: '{}',
          status: 'completed',
        },
        {
          type: 'function_call_output',
          call_id: 'call_live_probe_noop',
          output: '{"ok":true}',
        },
        {
          role: 'user',
          content: 'Use the tool output and reply with OK.',
        },
      ],
      max_output_tokens: 16,
      store: false,
    }),
  },
  {
    id: 'responses-parallel-tool-calls-false',
    title: 'Responses accepts parallel_tool_calls=false',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Map Anthropic disable_parallel_tool_use=true only if Copilot honors or cleanly rejects parallel_tool_calls=false.',
    candidateMapping: 'Anthropic tool_choice.disable_parallel_tool_use=true -> Responses parallel_tool_calls=false',
    rationale: 'Parallel tool execution control is easy to drop accidentally, so we need a probe before wiring it through.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'parallel_tool_calls',
      'parallel tool calls',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: 'Call the noop tool exactly once.',
      max_output_tokens: 64,
      parallel_tool_calls: false,
      tools: [
        {
          type: 'function',
          name: 'noop',
          description: 'A no-op tool used for capability probing.',
          parameters: { ...NOOP_TOOL_SCHEMA },
        },
      ],
      tool_choice: 'required',
    }),
  },
  {
    id: 'responses-tool-choice-function-object',
    title: 'Responses accepts tool_choice function object',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward structured function tool_choice only if Copilot accepts the official object form.',
    candidateMapping: 'OpenAI Responses tool_choice={type:function,name} -> Copilot /responses',
    rationale: 'The official Responses tool_choice schema includes object forms beyond none/auto/required strings.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'tool_choice',
      'tool choice',
      'function',
    ]),
    buildPayload: config => ({
      ...buildNoopResponsesToolPayload(config),
      tool_choice: {
        type: 'function',
        name: 'noop',
      },
    }),
  },
  {
    id: 'responses-tool-choice-allowed-tools',
    title: 'Responses accepts tool_choice allowed_tools object',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward allowed_tools constraints only if Copilot accepts the official tool_choice shape.',
    candidateMapping: 'OpenAI Responses tool_choice={type:allowed_tools,...} -> Copilot /responses',
    rationale: 'Allowed-tools constraints are a distinct official tool-routing control for large tool sets.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'tool_choice',
      'allowed_tools',
      'allowed tools',
    ]),
    buildPayload: config => ({
      ...buildNoopResponsesToolPayload(config),
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [
          {
            type: 'function',
            name: 'noop',
          },
        ],
      },
    }),
  },
  {
    id: 'responses-web-search-tool',
    title: 'Responses accepts web_search tool',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward web_search tools for Responses-backed models only if Copilot accepts them.',
    candidateMapping: 'OpenAI hosted web_search tool -> Copilot /responses',
    rationale: 'Web search is one of the core OpenAI-hosted Responses tools and should be tracked separately from function tools.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'web_search',
      'web search',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'web_search',
    }),
  },
  {
    id: 'responses-web-search-preview-tool',
    title: 'Responses accepts web_search_preview tool',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward web_search_preview tools for Responses-backed models only if Copilot accepts them.',
    candidateMapping: 'OpenAI hosted web_search_preview tool -> Copilot /responses',
    rationale: 'The official OpenAPI still exposes the preview web search tool alongside the newer web_search shape.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'web_search_preview',
      'web search',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'web_search_preview',
    }),
  },
  {
    id: 'responses-file-search-tool',
    title: 'Responses accepts file_search tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward file_search tools only after Copilot accepts the official tool shape and resource behavior is understood.',
    candidateMapping: 'OpenAI hosted file_search tool -> Copilot /responses',
    rationale: 'File search is a core hosted Responses tool and is distinct from raw input_file parts.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'file_search',
      'file search',
      'vector_store',
      'vector store',
      'tool',
      'not found',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'file_search',
      vector_store_ids: ['vs_live_probe_missing'],
    }),
  },
  {
    id: 'responses-image-generation-tool',
    title: 'Responses accepts image_generation tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward image_generation tools only if Copilot accepts the official hosted image tool shape.',
    candidateMapping: 'OpenAI hosted image_generation tool -> Copilot /responses',
    rationale: 'Image generation is part of the official Responses tool union and has a separate schema from image inputs.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'image_generation',
      'image generation',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'image_generation',
      quality: 'low',
      size: '1024x1024',
    }),
  },
  {
    id: 'responses-mcp-tool',
    title: 'Responses accepts mcp tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward remote MCP tools only if Copilot accepts the official mcp tool shape.',
    candidateMapping: 'OpenAI Responses mcp tool -> Copilot /responses',
    rationale: 'Remote MCP is an official Responses tool family and should be probed separately from local proxy MCP handling.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'mcp',
      'server_url',
      'server_label',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'mcp',
      server_label: 'live_probe',
      server_url: 'https://example.com/mcp',
    }),
  },
  {
    id: 'responses-computer-use-preview-tool',
    title: 'Responses accepts computer_use_preview tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward computer use tools only if Copilot accepts the official computer_use_preview shape.',
    candidateMapping: 'OpenAI hosted computer_use_preview tool -> Copilot /responses',
    rationale: 'Computer use is part of the official Responses hosted-tool union and has required display/environment fields.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'computer_use_preview',
      'computer use',
      'display_width',
      'display_height',
      'environment',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'computer_use_preview',
      environment: 'browser',
      display_width: 1024,
      display_height: 768,
    }),
  },
  {
    id: 'responses-tool-search-tool',
    title: 'Responses accepts tool_search shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward tool_search shapes only if Copilot accepts the hosted-tool discovery surface.',
    candidateMapping: 'OpenAI Responses tool_search -> Copilot /responses',
    rationale: 'Tool search lets large tool catalogs defer definitions, and it has a different schema from normal function tools.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'tool_search',
      'tool search',
      'tools',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: 'Reply with OK without using tools.',
      max_output_tokens: 16,
      tools: [
        {
          type: 'tool_search',
          execution: 'server',
        },
        {
          type: 'function',
          name: 'deferred_noop',
          description: 'A deferred no-op tool used for capability probing.',
          parameters: { ...NOOP_TOOL_SCHEMA },
          defer_loading: true,
        },
      ],
      tool_choice: 'none',
    }),
  },
  {
    id: 'responses-local-shell-tool',
    title: 'Responses accepts local_shell tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward local_shell tool declarations only if Copilot accepts the official local shell tool shape.',
    candidateMapping: 'OpenAI Responses local_shell tool -> Copilot /responses',
    rationale: 'Local shell is part of the Responses tool union used by coding agents.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'local_shell',
      'local shell',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'local_shell',
    }),
  },
  {
    id: 'responses-shell-tool',
    title: 'Responses accepts shell tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward shell tool declarations only if Copilot accepts the official shell tool shape.',
    candidateMapping: 'OpenAI Responses shell tool -> Copilot /responses',
    rationale: 'Hosted/container shell is part of the official Responses tool union and has a different schema from local_shell.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'shell',
      'container_auto',
      'environment',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'shell',
      environment: {
        type: 'container_auto',
      },
    }),
  },
  {
    id: 'responses-custom-tool',
    title: 'Responses accepts custom tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward custom tools only if Copilot accepts the official Responses custom tool shape.',
    candidateMapping: 'OpenAI Responses custom tool -> Copilot /responses',
    rationale: 'Custom tools are a separate official tool family from JSON-schema function tools.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'custom',
      'format',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'custom',
      name: 'noop_custom',
      format: {
        type: 'text',
      },
    }),
  },
  {
    id: 'responses-namespace-tool',
    title: 'Responses accepts namespace tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward namespace tools only if Copilot accepts the official grouped-tool shape.',
    candidateMapping: 'OpenAI Responses namespace tool -> Copilot /responses',
    rationale: 'Namespace tools are part of the Responses tool union and affect large tool-catalog routing.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'namespace',
      'tools',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'namespace',
      name: 'probe',
      description: 'Live probe namespace.',
      tools: [
        {
          type: 'function',
          name: 'noop',
          parameters: { ...NOOP_TOOL_SCHEMA },
        },
      ],
    }),
  },
  {
    id: 'responses-apply-patch-tool',
    title: 'Responses accepts apply_patch tool shape',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward apply_patch tools only if Copilot accepts the official coding-agent tool shape.',
    candidateMapping: 'OpenAI Responses apply_patch tool -> Copilot /responses',
    rationale: 'Apply patch is now part of the official Responses tool union and is relevant to coding-agent traffic.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'apply_patch',
      'apply patch',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'apply_patch',
    }),
  },
  {
    id: 'responses-code-interpreter-tool-unsupported',
    title: 'Responses rejects code_interpreter tool',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Do not advertise code_interpreter passthrough until Copilot accepts the hosted tool.',
    candidateMapping: 'OpenAI hosted code_interpreter tool -> Copilot /responses',
    rationale: 'Code interpreter is an official hosted tool; this probe records whether the selected Responses model accepts or cleanly rejects it.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'code_interpreter',
      'code interpreter',
      'tool',
    ]),
    buildPayload: config => buildHostedToolPresencePayload(config, {
      type: 'code_interpreter',
      container: {
        type: 'auto',
      },
    }),
  },
  {
    id: 'claude-response-format-json-object',
    title: 'Claude /chat/completions accepts response_format=json_object',
    tier: 'optional',
    endpoint: 'chat-completions',
    candidateFix: 'Map Anthropic output_config.format.type=json_object to Claude-backed Copilot chat-completions only if upstream accepts response_format=json_object.',
    candidateMapping: 'Anthropic output_config.format=json_object -> Copilot chat-completions response_format=json_object',
    rationale: 'Structured output is safe to translate only if the native Claude chat-completions path accepts the OpenAI-compatible json_object switch.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'response_format',
      'response format',
      'json_object',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      messages: [
        {
          role: 'user',
          content: 'Reply with a valid JSON object containing ok=true.',
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 32,
      temperature: 0,
    }),
  },
  {
    id: 'claude-response-format-json-schema',
    title: 'Claude /chat/completions parameter acceptance for response_format=json_schema',
    tier: 'optional',
    endpoint: 'chat-completions',
    candidateFix: 'Do not route Anthropic json_schema structured-output requests through Copilot chat-completions unless upstream proves schema enforcement, not only parameter acceptance.',
    candidateMapping: 'Direct Copilot chat-completions response_format=json_schema probe only; no automatic Anthropic output_config.format=json_schema mapping.',
    rationale: 'Copilot native /v1/messages rejects output_config.format, and Claude chat-completions can accept response_format=json_schema without reliably enforcing equivalent schema output.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'response_format',
      'response format',
      'json_schema',
      'schema',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      messages: [
        {
          role: 'user',
          content: 'What is 2+2? Return JSON with answer as a string.',
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'math_answer',
          strict: true,
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
      max_tokens: 64,
      temperature: 0,
    }),
  },
  {
    id: 'responses-text-format-json-object',
    title: 'Responses accepts text.format=json_object',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Map Anthropic output_config.format.type=json_object to Copilot Responses text.format only if upstream accepts text.format=json_object.',
    candidateMapping: 'Anthropic output_config.format=json_object -> Responses text.format=json_object',
    rationale: 'This is the native Responses-side structured-output target for Anthropic requests routed away from chat-completions.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'text',
      'format',
      'json_object',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: 'Reply with a valid JSON object containing ok=true.',
      text: {
        format: {
          type: 'json_object',
        },
      },
      max_output_tokens: 32,
    }),
  },
  {
    id: 'responses-text-format-json-schema',
    title: 'Responses accepts text.format=json_schema',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Map Chat Completions response_format=json_schema or Anthropic json_schema output to Responses text.format=json_schema only if upstream accepts it.',
    candidateMapping: 'OpenAI/Anthropic structured output -> Responses text.format=json_schema',
    rationale: 'Official OpenAI structured outputs support json_schema on the Responses surface.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'text',
      'format',
      'json_schema',
      'schema',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: 'What is 2+2? Return JSON with answer as a string.',
      text: {
        format: {
          type: 'json_schema',
          name: 'math_answer',
          strict: true,
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
      max_output_tokens: 64,
    }),
  },
  {
    id: 'responses-input-image-url',
    title: 'Responses accepts URL-based image input',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Map Anthropic image.source.type=url only if Copilot accepts URL image parts on /responses.',
    candidateMapping: 'Anthropic image.source.type=url -> Responses input_image.image_url',
    rationale: 'The proxy can parse URL images locally, but upstream still needs to accept the part shape end-to-end.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'image_url',
      'image url',
      'input_image',
      'input image',
      'url',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Reply with the single word image if you can inspect the image.',
            },
            {
              type: 'input_image',
              image_url: config.imageUrl,
            },
          ],
        },
      ],
      max_output_tokens: 16,
    }),
  },
  {
    id: 'responses-input-image-data-url',
    title: 'Responses accepts data URL image input',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Forward data URL image inputs only if Copilot accepts the official input_image image_url data URL form.',
    candidateMapping: 'OpenAI Responses input_image.image_url=data URL -> Copilot /responses',
    rationale: 'OpenAI-compatible clients commonly use data URLs for inline images, which differs from externally fetched URL images.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'image_url',
      'data url',
      'data:',
      'input_image',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Reply with OK if you can accept this image input.',
            },
            {
              type: 'input_image',
              image_url: TINY_PNG_DATA_URL,
            },
          ],
        },
      ],
      max_output_tokens: 16,
    }),
  },
  {
    id: 'responses-input-file-url',
    title: 'Responses accepts file_url input_file parts',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve Responses input_file parts only if Copilot upstream accepts file_url-based input_file payloads.',
    candidateMapping: 'Responses input_file.file_url -> Copilot /responses input_file',
    rationale: 'Official OpenAI Responses supports input_file parts; we need a direct probe to separate proxy bugs from backend incompatibility.',
    expectation: 'support_or_clean_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'input_file',
      'file_url',
      'file url',
      'file type',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Reply with yes if you can read this file.' },
            { type: 'input_file', file_url: config.fileUrl },
          ],
        },
      ],
      max_output_tokens: 128,
    }),
  },
  {
    id: 'responses-get-by-id-unsupported',
    title: 'Responses retrieve by ID is not exposed',
    tier: 'optional',
    endpoint: 'responses-raw',
    candidateFix: 'Forward /responses/{id} but do not claim stored response retrieval until Copilot stops returning 404.',
    candidateMapping: 'OpenAI GET /responses/{id} -> Copilot /responses/{id}',
    rationale: 'Retrieval is required for stored/background response flows and is separate from POST /responses generation.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'responses',
      'response_id',
      'not found',
    ]),
    buildRequest: () => ({
      method: 'GET',
      path: '/responses/resp_live_probe_missing',
      expectedBody: 'response',
      model: 'N/A',
    }),
  },
  {
    id: 'responses-delete-by-id-unsupported',
    title: 'Responses delete by ID is not exposed',
    tier: 'optional',
    endpoint: 'responses-raw',
    candidateFix: 'Forward DELETE /responses/{id} but do not claim stored response deletion until Copilot stops returning 404.',
    candidateMapping: 'OpenAI DELETE /responses/{id} -> Copilot /responses/{id}',
    rationale: 'Deletion only makes sense when stored responses are available.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'responses',
      'response_id',
      'not found',
    ]),
    buildRequest: () => ({
      method: 'DELETE',
      path: '/responses/resp_live_probe_missing',
      expectedBody: 'any',
      model: 'N/A',
    }),
  },
  {
    id: 'responses-cancel-unsupported',
    title: 'Responses cancel endpoint is not exposed',
    tier: 'optional',
    endpoint: 'responses-raw',
    candidateFix: 'Forward /responses/{id}/cancel but do not claim cancellation until Copilot supports background jobs.',
    candidateMapping: 'OpenAI POST /responses/{id}/cancel -> Copilot /responses/{id}/cancel',
    rationale: 'Cancel depends on background response state; this probe records whether the selected backend exposes the route.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'cancel',
      'background',
      'not found',
    ]),
    buildRequest: () => ({
      method: 'POST',
      path: '/responses/resp_live_probe_missing/cancel',
      expectedBody: 'response',
      model: 'N/A',
    }),
  },
  {
    id: 'responses-input-items-unsupported',
    title: 'Responses input_items endpoint is not exposed',
    tier: 'optional',
    endpoint: 'responses-raw',
    candidateFix: 'Forward /responses/{id}/input_items but do not claim stored input item retrieval until Copilot supports it.',
    candidateMapping: 'OpenAI GET /responses/{id}/input_items -> Copilot /responses/{id}/input_items',
    rationale: 'Input item retrieval is part of official stored Responses state, not plain generation.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'input_items',
      'input items',
      'not found',
    ]),
    buildRequest: () => ({
      method: 'GET',
      path: '/responses/resp_live_probe_missing/input_items',
      expectedBody: 'any',
      model: 'N/A',
    }),
  },
  {
    id: 'responses-input-tokens-unsupported',
    title: 'Responses input_tokens endpoint is not exposed',
    tier: 'optional',
    endpoint: 'responses-raw',
    candidateFix: 'Forward /responses/input_tokens but keep local token counting separate until Copilot supports this OpenAI route.',
    candidateMapping: 'OpenAI POST /responses/input_tokens -> Copilot /responses/input_tokens',
    rationale: 'The official Responses API has a dedicated input token counting endpoint.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'input_tokens',
      'input tokens',
      'not found',
    ]),
    buildRequest: config => ({
      method: 'POST',
      path: '/responses/input_tokens',
      body: {
        model: config.responsesModel,
        input: 'Tell me a joke.',
      },
      expectedBody: 'input_tokens',
      model: config.responsesModel,
    }),
  },
  {
    id: 'responses-compact-unsupported',
    title: 'Responses compact endpoint is not exposed',
    tier: 'optional',
    endpoint: 'responses-raw',
    candidateFix: 'Forward /responses/compact but do not claim server-side compaction until Copilot supports the route.',
    candidateMapping: 'OpenAI POST /responses/compact -> Copilot /responses/compact',
    rationale: 'Compaction is an official long-running conversation feature distinct from context_management on POST /responses.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildNotFoundOrUnsupportedMatcher([
      'compact',
      'compaction',
      'not found',
    ]),
    buildRequest: config => ({
      method: 'POST',
      path: '/responses/compact',
      body: {
        model: config.responsesModel,
        input: [
          {
            role: 'user',
            content: 'Summarize this state.',
          },
        ],
      },
      expectedBody: 'any',
      model: config.responsesModel,
    }),
  },

  // Native Anthropic /v1/messages probes
  {
    id: 'native-anthropic-baseline',
    title: 'Native Anthropic baseline',
    tier: 'baseline',
    endpoint: 'anthropic-messages',
    expectation: 'must_support',
    candidateFix: 'N/A',
    candidateMapping: 'N/A',
    rationale: 'Verifies native /v1/messages passthrough works for Claude models.',
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Say hi' }],
    }),
  },
  {
    id: 'native-anthropic-hyphen-alias-baseline',
    title: 'Native Anthropic official hyphen model alias',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward official Anthropic model aliases when Copilot accepts them; otherwise keep local normalization.',
    candidateMapping: 'claude-opus-4-8 style alias -> Copilot /v1/messages',
    rationale: 'Current Anthropic SDK examples use hyphen aliases, while Copilot historically used dotted aliases.',
    isUnsupported: buildUnsupportedMatcher([
      'model',
      'not found',
      'unsupported',
    ]),
    buildPayload: config => buildAnthropicBasicPayload(config, toAnthropicHyphenAlias(config.claudeModel)),
  },
  {
    id: 'native-anthropic-streaming',
    title: 'Native Anthropic streaming SSE',
    tier: 'baseline',
    endpoint: 'anthropic-raw',
    expectation: 'must_support',
    candidateFix: 'Keep Claude Code streaming requests on native /v1/messages.',
    candidateMapping: 'Anthropic stream=true -> Copilot /v1/messages SSE',
    rationale: 'Claude Code normally streams /v1/messages and expects Anthropic SSE lifecycle events.',
    buildRequest: config => ({
      method: 'POST',
      path: '/v1/messages',
      body: {
        ...buildAnthropicBasicPayload(config),
        stream: true,
      },
      expectedBody: 'message_stream',
      model: config.claudeModel,
    }),
  },
  {
    id: 'native-anthropic-count-tokens',
    title: 'Native Anthropic count_tokens',
    tier: 'baseline',
    endpoint: 'anthropic-raw',
    expectation: 'must_support',
    candidateFix: 'Use native /v1/messages/count_tokens for Claude token counting.',
    candidateMapping: 'Anthropic count_tokens -> Copilot /v1/messages/count_tokens',
    rationale: 'Claude Code and Anthropic SDK clients need model-specific token counts.',
    buildRequest: config => ({
      method: 'POST',
      path: '/v1/messages/count_tokens',
      body: {
        model: config.claudeModel,
        messages: [{ role: 'user', content: 'Count this short prompt.' }],
      },
      expectedBody: 'input_tokens',
      model: config.claudeModel,
    }),
  },
  {
    id: 'native-anthropic-count-tokens-tools',
    title: 'Native Anthropic count_tokens with tools',
    tier: 'optional',
    endpoint: 'anthropic-raw',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward tool schemas to count_tokens when Copilot accepts them.',
    candidateMapping: 'Anthropic count_tokens tools -> Copilot /v1/messages/count_tokens tools',
    rationale: 'Claude clients often include tools in token-count estimates.',
    isUnsupported: buildUnsupportedMatcher([
      'tools',
      'tool',
    ]),
    buildRequest: config => ({
      method: 'POST',
      path: '/v1/messages/count_tokens',
      body: {
        model: config.claudeModel,
        tools: [{ name: 'noop', description: 'No-op', input_schema: { ...NOOP_TOOL_SCHEMA } }],
        messages: [{ role: 'user', content: 'Count this tool prompt.' }],
      },
      expectedBody: 'input_tokens',
      model: config.claudeModel,
    }),
  },
  {
    id: 'native-anthropic-reasoning-effort-low',
    title: 'Native Anthropic output_config.effort=low',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward low effort on native passthrough when Copilot accepts it.',
    candidateMapping: 'Anthropic output_config.effort=low -> Copilot /v1/messages output_config.effort',
    rationale: 'Low effort is used by clients trying to reduce latency and cost.',
    isUnsupported: buildUnsupportedMatcher([
      'output_config.effort',
      'reasoning_effort',
      'low',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      output_config: { effort: 'low' },
    }),
  },
  {
    id: 'native-anthropic-reasoning-effort-medium',
    title: 'Native Anthropic output_config.effort=medium',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward medium effort on native passthrough when Copilot accepts it.',
    candidateMapping: 'Anthropic output_config.effort=medium -> Copilot /v1/messages output_config.effort',
    rationale: 'Medium effort is a common balanced setting.',
    isUnsupported: buildUnsupportedMatcher([
      'output_config.effort',
      'reasoning_effort',
      'medium',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      output_config: { effort: 'medium' },
    }),
  },
  {
    id: 'native-anthropic-reasoning-effort-high',
    title: 'Native Anthropic output_config.effort=high',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward high effort on native passthrough when Copilot accepts it; otherwise surface the upstream invalid_reasoning_effort rejection unchanged.',
    candidateMapping: 'Anthropic output_config.effort=high -> Copilot /v1/messages output_config.effort',
    rationale: 'Copilot Anthropic effort support is model-dependent; high may be accepted or cleanly rejected depending on the selected upstream model.',
    isUnsupported: buildUnsupportedMatcher([
      'output_config.effort',
      'reasoning_effort',
      'high',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 32,
      output_config: {
        effort: 'high',
      },
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    }),
  },
  {
    id: 'native-anthropic-reasoning-effort-xhigh',
    title: 'Native Anthropic output_config.effort=xhigh',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward xhigh on native passthrough when Copilot accepts it; otherwise surface the upstream invalid_reasoning_effort rejection unchanged.',
    candidateMapping: 'Anthropic output_config.effort=xhigh -> Copilot /v1/messages output_config.effort',
    rationale: 'Copilot Anthropic effort support is model-dependent; xhigh may be accepted or cleanly rejected depending on the selected upstream model.',
    isUnsupported: buildUnsupportedMatcher([
      'output_config.effort',
      'reasoning_effort',
      'xhigh',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 32,
      output_config: {
        effort: 'xhigh',
      },
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    }),
  },
  {
    id: 'native-anthropic-reasoning-effort-max',
    title: 'Native Anthropic output_config.effort=max',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward max on native passthrough when Copilot accepts it; otherwise surface the upstream invalid_reasoning_effort rejection unchanged.',
    candidateMapping: 'Anthropic output_config.effort=max -> Copilot /v1/messages output_config.effort',
    rationale: 'Copilot Anthropic max-effort support is model-dependent; max may be accepted or cleanly rejected depending on the selected upstream model.',
    isUnsupported: buildUnsupportedMatcher([
      'output_config.effort',
      'reasoning_effort',
      'max',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 32,
      output_config: {
        effort: 'max',
      },
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
    }),
  },
  {
    id: 'native-anthropic-json-schema',
    title: 'Native Anthropic json_schema structured output',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Use native passthrough for Anthropic json_schema structured output when Copilot accepts it; otherwise surface the upstream validation error unchanged.',
    candidateMapping: 'Anthropic output_config.format=json_schema -> Copilot /v1/messages output_config.format',
    rationale: 'Copilot native json_schema structured output support is model-dependent across Claude models.',
    isUnsupported: buildUnsupportedMatcher([
      'output_config.format',
      'format',
      'json_schema',
      'extra inputs',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 128,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: 'What is 2+2? Return as JSON.' }],
    }),
  },
  {
    id: 'native-anthropic-thinking-display-omitted',
    title: 'Native Anthropic thinking display=omitted',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward adaptive thinking display options when Copilot accepts them; otherwise surface the upstream thinking validation error unchanged.',
    candidateMapping: 'Anthropic thinking.display=omitted -> Copilot /v1/messages thinking.display',
    rationale: 'Adaptive thinking display support is model-dependent; models without adaptive thinking reject this field cleanly.',
    isUnsupported: buildUnsupportedMatcher([
      'thinking',
      'adaptive',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 8192,
      thinking: { type: 'adaptive', display: 'omitted' },
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    }),
  },
  {
    id: 'native-anthropic-manual-thinking-budget',
    title: 'Native Anthropic manual thinking budget',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward legacy thinking.type=enabled only when Copilot accepts it for the selected model.',
    candidateMapping: 'Anthropic thinking.type=enabled -> Copilot /v1/messages thinking',
    rationale: 'Opus 4.6 and older-compatible clients may still emit budget_tokens; newer Opus models reject it.',
    isUnsupported: buildUnsupportedMatcher([
      'thinking.type.enabled',
      'thinking',
      'budget_tokens',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      max_tokens: 2048,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: 'What is 11 + 31? Answer briefly.' }],
    }),
  },
  {
    id: 'native-anthropic-thinking-disabled',
    title: 'Native Anthropic thinking disabled',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward thinking.type=disabled only when Copilot accepts it for the selected model.',
    candidateMapping: 'Anthropic thinking.type=disabled -> Copilot /v1/messages thinking',
    rationale: 'Some Claude clients explicitly disable thinking instead of omitting the field.',
    isUnsupported: buildUnsupportedMatcher([
      'thinking',
      'disabled',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      thinking: { type: 'disabled' },
    }),
  },
  {
    id: 'native-anthropic-tool-choice-specific',
    title: 'Native Anthropic tool_choice specific tool',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward native Anthropic tool_choice on Claude-routed models when Copilot accepts it.',
    candidateMapping: 'Anthropic tool_choice.tool -> Copilot /v1/messages tool_choice',
    rationale: 'Claude Code and SDK clients can constrain tool use through Anthropic tool_choice.',
    isUnsupported: buildUnsupportedMatcher([
      'tool_choice',
      'tool',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      max_tokens: 128,
      tools: [{ name: 'noop', description: 'No-op', input_schema: { ...NOOP_TOOL_SCHEMA } }],
      tool_choice: { type: 'tool', name: 'noop' },
      messages: [{ role: 'user', content: 'Call noop exactly once.' }],
    }),
  },
  {
    id: 'native-anthropic-tool-choice-any-disable-parallel',
    title: 'Native Anthropic tool_choice any with disable_parallel_tool_use',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward native disable_parallel_tool_use on Claude-routed models when Copilot accepts it.',
    candidateMapping: 'Anthropic tool_choice.disable_parallel_tool_use -> Copilot /v1/messages',
    rationale: 'Parallel tool control is part of Anthropic tool semantics and differs by model/backend.',
    isUnsupported: buildUnsupportedMatcher([
      'disable_parallel_tool_use',
      'parallel',
      'tool_choice',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      max_tokens: 128,
      tools: [{ name: 'noop', description: 'No-op', input_schema: { ...NOOP_TOOL_SCHEMA } }],
      tool_choice: { type: 'any', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: 'Call one tool.' }],
    }),
  },
  {
    id: 'native-anthropic-strict-custom-tool',
    title: 'Native Anthropic strict custom tool schema',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Preserve strict custom tools when Copilot accepts structured-output enforcement for the selected model.',
    candidateMapping: 'Anthropic strict custom tool -> Copilot /v1/messages tool schema',
    rationale: 'Strict tools are model/policy-dependent and should not be inferred from non-strict tool support.',
    isUnsupported: buildUnsupportedMatcher([
      'strict',
      'structured_outputs',
      'tool',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      max_tokens: 128,
      tools: [{ name: 'strict_noop', description: 'No-op', strict: true, input_schema: { ...NOOP_TOOL_SCHEMA } }],
      tool_choice: { type: 'tool', name: 'strict_noop' },
      messages: [{ role: 'user', content: 'Call strict_noop exactly once.' }],
    }),
  },
  {
    id: 'native-anthropic-server-tool-code-execution',
    title: 'Native Anthropic code_execution server tool schema',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Allow Anthropic code_execution tools through native passthrough only when Copilot accepts the schema.',
    candidateMapping: 'Anthropic code_execution_20260120 -> Copilot /v1/messages tools',
    rationale: 'Server-side tool schemas vary by Claude model and backend policy.',
    isUnsupported: buildUnsupportedMatcher([
      'code_execution_20260120',
      'code_execution',
      'tools.0',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      tools: [{ type: 'code_execution_20260120', name: 'code_execution' }],
      messages: [{ role: 'user', content: 'Reply OK without using tools.' }],
    }),
  },
  {
    id: 'native-anthropic-server-tool-memory',
    title: 'Native Anthropic memory server tool schema',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Allow Anthropic memory tools through native passthrough only when Copilot accepts the schema.',
    candidateMapping: 'Anthropic memory_20250818 -> Copilot /v1/messages tools',
    rationale: 'Memory is a Claude server-side tool schema used by newer SDKs.',
    isUnsupported: buildUnsupportedMatcher([
      'memory_20250818',
      'memory',
      'tools.0',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      tools: [{ type: 'memory_20250818', name: 'memory' }],
      messages: [{ role: 'user', content: 'Reply OK without using tools.' }],
    }),
  },
  {
    id: 'native-anthropic-server-tool-bash',
    title: 'Native Anthropic bash server tool schema',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Allow Anthropic bash tools through native passthrough only when Copilot accepts the schema.',
    candidateMapping: 'Anthropic bash_20250124 -> Copilot /v1/messages tools',
    rationale: 'Claude Code-style local tool loops rely on client tools, but server-side bash schema support still affects SDK compatibility.',
    isUnsupported: buildUnsupportedMatcher([
      'bash_20250124',
      'bash',
      'tools.0',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      tools: [{ type: 'bash_20250124', name: 'bash' }],
      messages: [{ role: 'user', content: 'Reply OK without using tools.' }],
    }),
  },
  {
    id: 'native-anthropic-server-tool-text-editor',
    title: 'Native Anthropic text editor server tool schema',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Allow Anthropic text editor tools through native passthrough only when Copilot accepts the schema.',
    candidateMapping: 'Anthropic text_editor_20250728 -> Copilot /v1/messages tools',
    rationale: 'Claude Code-compatible edit tools have versioned Anthropic schema names.',
    isUnsupported: buildUnsupportedMatcher([
      'text_editor_20250728',
      'text_editor',
      'tools.0',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      tools: [{ type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' }],
      messages: [{ role: 'user', content: 'Reply OK without using tools.' }],
    }),
  },
  {
    id: 'native-anthropic-server-tool-web-search',
    title: 'Native Anthropic web_search server tool schema',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Do not add a local rejection if Copilot accepts web_search for any selected Claude model.',
    candidateMapping: 'Anthropic web_search_20260209 -> Copilot /v1/messages tools',
    rationale: 'Web search is a documented Anthropic server-side tool but may be unavailable through Copilot.',
    isUnsupported: buildUnsupportedMatcher([
      'web_search_20260209',
      'web search',
      'web_search',
    ]),
    buildPayload: config => ({
      ...buildAnthropicBasicPayload(config),
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Reply OK without using tools.' }],
    }),
  },
  {
    id: 'native-anthropic-mid-conversation-system-beta',
    title: 'Native Anthropic mid-conversation system beta',
    tier: 'optional',
    endpoint: 'anthropic-raw',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward mid-conversation system messages when the selected Claude model and beta header accept them.',
    candidateMapping: 'Anthropic role=system in messages + beta -> Copilot /v1/messages',
    rationale: 'Newer Anthropic SDKs can emit system messages inside the message array under a model-gated beta.',
    isUnsupported: buildUnsupportedMatcher([
      'mid-conversation-system',
      'system',
      'anthropic-beta',
    ]),
    buildRequest: config => ({
      method: 'POST',
      path: '/v1/messages',
      headers: { 'anthropic-beta': 'mid-conversation-system-2026-04-07' },
      body: {
        model: config.claudeModel,
        max_tokens: 32,
        messages: [
          { role: 'user', content: 'Say any one word.' },
          { role: 'system', content: 'Answer OK only.' },
        ],
      },
      expectedBody: 'any',
      model: config.claudeModel,
    }),
  },
  {
    id: 'native-anthropic-speed-fast',
    title: 'Native Anthropic speed=fast',
    tier: 'optional',
    endpoint: 'anthropic-raw',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward speed hints when Copilot accepts them for the selected Claude model.',
    candidateMapping: 'Anthropic speed=fast + beta -> Copilot /v1/messages',
    rationale: 'Claude Code can emit latency-oriented speed hints.',
    isUnsupported: buildUnsupportedMatcher([
      'speed',
      'fast',
      'anthropic-beta',
    ]),
    buildRequest: config => ({
      method: 'POST',
      path: '/v1/messages',
      headers: { 'anthropic-beta': 'fast-mode-2026-02-01' },
      body: {
        ...buildAnthropicBasicPayload(config),
        speed: 'fast',
      },
      expectedBody: 'any',
      model: config.claudeModel,
    }),
  },
  {
    id: 'native-anthropic-document-text',
    title: 'Native Anthropic document source=data',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'must_support',
    candidateFix: 'N/A',
    candidateMapping: 'N/A',
    rationale: 'Official inline plain-text document source uses source.type=text with a data field.',
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Hello world.' } },
          { type: 'text', text: 'What does the document say?' },
        ],
      }],
    }),
  },
  {
    id: 'native-anthropic-document-url-pdf',
    title: 'Native Anthropic document source=url (real PDF)',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Use native passthrough when Copilot accepts URL-backed documents; otherwise fetch/extract locally or surface the clean upstream unsupported error.',
    candidateMapping: 'Anthropic document source=url -> Copilot /v1/messages document source=url, or local fetch/extract fallback when unsupported',
    rationale: 'Copilot native document URL support is model-dependent; this probe records whether the selected upstream model accepts or cleanly rejects URL-backed documents.',
    isUnsupported: buildUnsupportedMatcher([
      'url sources',
      'url',
      'document',
      'image.source',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'url', url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' } },
          { type: 'text', text: 'Is there text in this PDF?' },
        ],
      }],
    }),
  },
  {
    id: 'native-anthropic-document-file-unsupported',
    title: 'Native Anthropic document source=file is unsupported without Files API',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'must_be_unsupported',
    candidateFix: 'Do not claim document.source=file support unless the proxy implements real file-id content semantics or Copilot exposes Files API.',
    candidateMapping: 'Anthropic document source=file -> Copilot /v1/messages document source=file',
    rationale: 'A successful Files API shim without model-readable file contents would create a false success.',
    isUnsupported: buildUnsupportedMatcher([
      'file',
      'files api',
      'source.type',
      'document',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id: 'file_live_probe_missing' } },
          { type: 'text', text: 'What is in this file?' },
        ],
      }],
    }),
  },
  {
    id: 'native-anthropic-document-citations',
    title: 'Native Anthropic document citations',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'must_support',
    candidateFix: 'N/A',
    candidateMapping: 'N/A',
    rationale: 'Official citations feature for document inputs.',
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 128,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'The capital of France is Paris.' }, citations: { enabled: true } },
          { type: 'text', text: 'What is the capital?' },
        ],
      }],
    }),
  },
  {
    id: 'native-anthropic-cache-control',
    title: 'Native Anthropic top-level cache_control',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'support_or_clean_unsupported',
    candidateFix: 'Forward top-level cache_control only through native passthrough when Copilot accepts it; otherwise surface the upstream validation error cleanly.',
    candidateMapping: 'Anthropic top-level cache_control -> Copilot /v1/messages cache_control',
    rationale: 'Copilot top-level cache_control support is model-dependent; this probe records whether the selected upstream model accepts or cleanly rejects the field.',
    isUnsupported: buildUnsupportedMatcher([
      'cache_control',
      'extra inputs',
    ]),
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 32,
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: 'Say hi' }],
    }),
  },
  {
    id: 'native-anthropic-image-base64',
    title: 'Native Anthropic base64 image',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'must_support',
    candidateFix: 'N/A',
    candidateMapping: 'N/A',
    rationale: 'Copilot upstream supports native base64 image input.',
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              // 1x1 red PNG
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
            },
          },
          { type: 'text', text: 'What color is this image?' },
        ],
      }],
    }),
  },
  {
    id: 'native-anthropic-image-url-rejected',
    title: 'Native Anthropic URL image (expected rejection)',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'must_be_unsupported',
    candidateFix: 'N/A',
    candidateMapping: 'N/A',
    rationale: 'Copilot upstream does not support external image URLs.',
    isUnsupported: details => details.status === 400,
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: config.imageUrl } },
          { type: 'text', text: 'What is this?' },
        ],
      }],
    }),
  },
  {
    id: 'native-anthropic-models-api-unsupported',
    title: 'Anthropic Models API is not exposed by Copilot',
    tier: 'optional',
    endpoint: 'anthropic-raw',
    expectation: 'must_be_unsupported',
    candidateFix: 'Use Copilot /models for local model listing; do not rely on upstream Anthropic /v1/models.',
    candidateMapping: 'Anthropic GET /v1/models -> Copilot /v1/models',
    rationale: 'The official Claude SDK exposes Models API, but Copilot upstream may not expose it on Anthropic paths.',
    isUnsupported: details => details.status === 404 || buildUnsupportedMatcher(['models'])(details),
    buildRequest: () => ({
      method: 'GET',
      path: '/v1/models',
      expectedBody: 'list',
      model: 'N/A',
    }),
  },
  {
    id: 'native-anthropic-batches-list-unsupported',
    title: 'Anthropic Message Batches list is not exposed by Copilot',
    tier: 'optional',
    endpoint: 'anthropic-raw',
    expectation: 'must_be_unsupported',
    candidateFix: 'Do not claim asynchronous Anthropic batch processing unless Copilot exposes the endpoint or the proxy implements real batch semantics.',
    candidateMapping: 'Anthropic GET /v1/messages/batches -> Copilot /v1/messages/batches',
    rationale: 'Returning fake batch success would be misleading because clients expect asynchronous processing and retrievable results.',
    isUnsupported: details => details.status === 404 || buildUnsupportedMatcher(['batches'])(details),
    buildRequest: () => ({
      method: 'GET',
      path: '/v1/messages/batches?limit=1',
      expectedBody: 'list',
      model: 'N/A',
    }),
  },
  {
    id: 'native-anthropic-batches-create-unsupported',
    title: 'Anthropic Message Batches create is not exposed by Copilot',
    tier: 'optional',
    endpoint: 'anthropic-raw',
    expectation: 'must_be_unsupported',
    candidateFix: 'Do not claim asynchronous Anthropic batch processing unless Copilot exposes the endpoint or the proxy implements real batch semantics.',
    candidateMapping: 'Anthropic POST /v1/messages/batches -> Copilot /v1/messages/batches',
    rationale: 'A fake 200 would not produce a real batch or usable result stream.',
    isUnsupported: details => details.status === 404 || buildUnsupportedMatcher(['batches'])(details),
    buildRequest: config => ({
      method: 'POST',
      path: '/v1/messages/batches',
      body: {
        requests: [{
          custom_id: 'probe-1',
          params: {
            model: config.claudeModel,
            max_tokens: 16,
            messages: [{ role: 'user', content: 'Reply OK.' }],
          },
        }],
      },
      expectedBody: 'any',
      model: 'N/A',
    }),
  },
  {
    id: 'native-anthropic-files-api-unsupported',
    title: 'Anthropic Files API (expected 404)',
    tier: 'optional',
    endpoint: 'anthropic-files',
    expectation: 'must_be_unsupported',
    candidateFix: 'N/A',
    candidateMapping: 'N/A',
    rationale: 'Copilot upstream does not expose the Anthropic Files API.',
    isUnsupported: details => details.status === 404,
    buildPayload: () => ({
      headers: { 'anthropic-beta': 'files-api-2025-04-14' },
    }),
  },
]
