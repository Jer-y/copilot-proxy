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

export type CapabilityProbeEndpoint = 'chat-completions' | 'responses' | 'responses-raw' | 'anthropic-messages' | 'anthropic-files'
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

export interface AnthropicFilesCapabilityProbe extends CapabilityProbeBase {
  endpoint: 'anthropic-files'
  buildPayload: (config: LiveCopilotProbeConfig) => { headers?: Record<string, string> }
}

export type CapabilityProbe = ChatCompletionsCapabilityProbe | ResponsesCapabilityProbe | RawResponsesCapabilityProbe | AnthropicMessagesCapabilityProbe | AnthropicFilesCapabilityProbe

interface ResponsesReasoningProbePayload extends Omit<ResponsesPayload, 'reasoning'> {
  reasoning?: {
    effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
    summary?: 'auto' | 'concise' | 'detailed' | 'none'
  }
}

const NOOP_TOOL_SCHEMA = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const

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
    candidateFix: 'Keep GPT-5.5 and other Responses-only models routed to Copilot /responses.',
    candidateMapping: 'Responses-only model -> Copilot /chat/completions',
    rationale: 'GPT-5.5 is Responses-only in Copilot today; this catches accidental fallback to /chat/completions.',
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
    id: 'claude-tool-choice-required',
    title: 'Claude /chat/completions accepts tool_choice=required',
    tier: 'optional',
    endpoint: 'chat-completions',
    candidateFix: 'Forward Anthropic tool_choice to Claude-backed Copilot chat-completions only if upstream accepts it.',
    candidateMapping: 'Anthropic tool_choice:any/tool -> Copilot chat-completions tool_choice',
    rationale: 'Claude support is currently marked false in model-config; this probe tells us whether that assumption still holds upstream.',
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
    rationale: 'GPT-5.5 accepts none as the latency-first reasoning setting; older models may reject it.',
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
    rationale: 'High effort is the most likely translation target for current Claude-thinking heuristics in the proxy.',
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
    rationale: 'Anthropic max-effort is Claude-specific. For Responses-backed models we should validate the native Copilot/OpenAI-style high-end value rather than forwarding raw max.',
    expectation: 'support_or_clean_unsupported',
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
    rationale: 'Some OpenAI clients can emit minimal, but current Copilot GPT-5.5 validation rejects it.',
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
    id: 'responses-text-verbosity-low',
    title: 'Responses accepts text.verbosity=low',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Preserve text.verbosity=low for Responses-backed models if Copilot accepts it.',
    candidateMapping: 'OpenAI Responses text.verbosity=low -> Copilot /responses',
    rationale: 'GPT-5.5 exposes verbosity as a first-class output-length control.',
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
    rationale: 'Medium is the documented neutral verbosity setting for GPT-5.5 style models.',
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
    rationale: 'Stored response state is required by previous_response_id and retrieve/cancel flows; current Copilot does not expose it.',
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
    endpoint: 'responses',
    candidateFix: 'Avoid forwarding unsupported service_tier values to Copilot unless upstream changes.',
    candidateMapping: 'OpenAI Responses service_tier=auto -> Copilot /responses',
    rationale: 'OpenAI-compatible clients may send service_tier, but current Copilot validation does not accept auto.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'service_tier',
      'service tier',
    ]),
    buildPayload: config => ({
      ...buildBasicResponsesPayload(config),
      service_tier: 'auto',
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
    buildPayload: config => ({
      model: config.responsesModel,
      input: 'Reply with OK without using tools.',
      max_output_tokens: 16,
      tools: [
        {
          type: 'web_search',
        },
      ],
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
          max_tool_count: 1,
        },
      ],
    }),
  },
  {
    id: 'responses-code-interpreter-tool-unsupported',
    title: 'Responses rejects code_interpreter tool',
    tier: 'optional',
    endpoint: 'responses',
    candidateFix: 'Do not advertise code_interpreter passthrough until Copilot accepts the hosted tool.',
    candidateMapping: 'OpenAI hosted code_interpreter tool -> Copilot /responses',
    rationale: 'Code interpreter is an official hosted tool, but current Copilot GPT-5.5 rejects it.',
    expectation: 'must_be_unsupported',
    isUnsupported: buildUnsupportedMatcher([
      'code_interpreter',
      'code interpreter',
      'tool',
    ]),
    buildPayload: config => ({
      model: config.responsesModel,
      input: 'Reply with OK without using tools.',
      max_output_tokens: 16,
      tools: [
        {
          type: 'code_interpreter',
        },
      ],
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
    rationale: 'Cancel depends on background response state; current Copilot rejects the route.',
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
    id: 'native-anthropic-reasoning-effort-high',
    title: 'Native Anthropic output_config.effort=high',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'must_support',
    candidateFix: 'N/A',
    candidateMapping: 'N/A',
    rationale: 'Verifies native /v1/messages still accepts supported high-effort Claude reasoning.',
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
    id: 'native-anthropic-reasoning-effort-max',
    title: 'Native Anthropic output_config.effort=max (expected rejection)',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'must_be_unsupported',
    candidateFix: 'Keep native passthrough behavior and surface the upstream max-effort rejection unchanged.',
    candidateMapping: 'Anthropic output_config.effort=max -> Copilot /v1/messages invalid_reasoning_effort',
    rationale: 'Current Copilot native Anthropic Claude models only accept low, medium, or high effort.',
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
    title: 'Native Anthropic json_schema structured output (expected rejection)',
    tier: 'optional',
    endpoint: 'anthropic-messages',
    expectation: 'must_be_unsupported',
    candidateFix: 'Keep native passthrough behavior and surface the upstream output_config.format rejection until Copilot implements Anthropic structured outputs.',
    candidateMapping: 'Anthropic output_config.format=json_schema -> Copilot /v1/messages output_config.format rejection',
    rationale: 'Official Anthropic structured output uses json_schema, but current Copilot native /v1/messages rejects output_config.format and Claude chat-completions does not enforce equivalent schema output reliably.',
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
    expectation: 'must_support',
    candidateFix: 'N/A',
    candidateMapping: 'N/A',
    rationale: 'Official adaptive thinking supports display: omitted.',
    buildPayload: config => ({
      model: config.claudeModel,
      max_tokens: 8192,
      thinking: { type: 'adaptive', display: 'omitted' },
      messages: [{ role: 'user', content: 'What is 2+2?' }],
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
    expectation: 'must_be_unsupported',
    candidateFix: 'Proxy should bypass native /v1/messages, fetch the URL-backed document locally, expand it to text, and continue via a translated backend instead of blindly forwarding an unsupported URL document source.',
    candidateMapping: 'Anthropic document source=url -> local fetch/extract -> text block(s) -> translated backend request',
    rationale: 'Official document URL source with a real PDF, which current Copilot native /v1/messages rejects.',
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
    expectation: 'must_support',
    candidateFix: 'Keep official top-level cache_control on native passthrough now that Copilot /v1/messages accepts it.',
    candidateMapping: 'Anthropic top-level cache_control -> Copilot /v1/messages cache_control',
    rationale: 'Copilot upstream now accepts the official top-level cache_control field.',
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
