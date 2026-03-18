import type { ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import type { ResponsesPayload } from '~/services/copilot/create-responses'

export interface LiveCopilotProbeConfig {
  claudeModel: string
  responsesModel: string
  imageUrl: string
}

export interface ProbeErrorDetails {
  status: number
  code?: string
  message?: string
  rawBody?: string
}

export type CapabilityProbeEndpoint = 'chat-completions' | 'responses'
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

export type CapabilityProbe = ChatCompletionsCapabilityProbe | ResponsesCapabilityProbe

interface ResponsesReasoningProbePayload extends Omit<ResponsesPayload, 'reasoning'> {
  reasoning?: {
    effort?: 'low' | 'medium' | 'high' | 'xhigh'
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

function buildResponsesReasoningProbePayload(
  config: LiveCopilotProbeConfig,
  effort: 'low' | 'medium' | 'high' | 'xhigh',
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
]
