import { state } from './state'

export type BackendApiType = 'chat-completions' | 'responses' | 'anthropic-messages'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelConfig {
  /** Backend API types this model supports */
  supportedApis: Array<BackendApiType>
  /** Preferred backend when both are supported */
  preferredApi?: BackendApiType
  /** Whether the model uses thinking/reasoning mode; only affects default reasoning logic, not routing */
  reasoningMode?: 'standard' | 'thinking'
  /** Whether to add copilot_cache_control headers for prompt caching */
  enableCacheControl?: boolean
  /** Default reasoning effort level */
  defaultReasoningEffort?: ReasoningEffort
  /** Supported reasoning effort levels */
  supportedReasoningEfforts?: Array<ReasoningEffort>
  /** Whether the model supports tool_choice parameter */
  supportsToolChoice?: boolean
  /** Whether the model supports parallel tool calls */
  supportsParallelToolCalls?: boolean
  /** Token-limit field accepted by the model on /chat/completions */
  chatCompletionTokenParameter?: 'max_tokens' | 'max_completion_tokens'
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // Claude models — use native Anthropic Messages passthrough for /v1/messages
  // clients; chat-completions remains in supportedApis so that direct
  // /chat/completions clients can still reach these models. The proxy does NOT
  // translate /v1/messages or /responses requests into chat-completions.
  'claude-sonnet-4': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'anthropic-messages',
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-sonnet-4.5': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'anthropic-messages',
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-sonnet-4.6': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'anthropic-messages',
    enableCacheControl: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'claude-opus-4.5': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'anthropic-messages',
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-opus-4.6': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'anthropic-messages',
    enableCacheControl: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'claude-opus-4.7': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'anthropic-messages',
    enableCacheControl: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsToolChoice: false,
    supportsParallelToolCalls: true,
  },
  'claude-opus-4.8': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'anthropic-messages',
    enableCacheControl: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsToolChoice: false,
    supportsParallelToolCalls: true,
  },
  'claude-haiku-4.5': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'anthropic-messages',
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },

  // GPT classic models — chat-completions only
  'gpt-4o': {
    supportedApis: ['chat-completions'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-4.1': {
    supportedApis: ['chat-completions'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },

  // GPT-5 base models — both APIs, prefer Responses (modern API)
  'gpt-5': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'responses',
    reasoningMode: 'thinking',
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.1': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'responses',
    reasoningMode: 'thinking',
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.2': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'responses',
    reasoningMode: 'thinking',
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5-mini': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'responses',
    reasoningMode: 'thinking',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5-codex': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },

  // GPT-5.4 — current Copilot inventory exposes both APIs. Its
  // /chat/completions surface rejects legacy `max_tokens` and requires
  // `max_completion_tokens` instead.
  'gpt-5.4': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'responses',
    reasoningMode: 'thinking',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
    chatCompletionTokenParameter: 'max_completion_tokens',
  },
  'gpt-5.5': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.6': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },

  // Codex models — responses only
  'gpt-5.1-codex': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.2-codex': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.3-codex': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },

  // Gemini models — chat-completions only
  'o3-mini': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    supportsToolChoice: true,
  },
  'o4-mini': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    supportsToolChoice: true,
  },
  'gemini': {
    supportedApis: ['chat-completions'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
}

/** Default config for unknown models */
const DEFAULT_CONFIG: ModelConfig = {
  supportedApis: ['chat-completions'],
}

/**
 * Get model-specific configuration.
 * Returns the config for an exact match, or for the base model name (without version suffix).
 * Falls back to a default config if no match is found.
 */
export function getModelConfig(modelId: string): ModelConfig {
  // Exact match
  if (MODEL_CONFIGS[modelId]) {
    return withLiveReasoningEfforts(modelId, MODEL_CONFIGS[modelId])
  }

  // Try prefix match for families (e.g., 'gpt-5.2-codex-max' matches 'gpt-5.2-codex')
  const entries = Object.entries(MODEL_CONFIGS).sort(
    (a, b) => b[0].length - a[0].length,
  )
  for (const [key, config] of entries) {
    if (hasModelConfigPrefix(modelId, key)) {
      return withLiveReasoningEfforts(modelId, config)
    }
  }

  // Default for unknown Claude models — same shape as the explicit Claude
  // entries above: native /v1/messages for Anthropic clients, plus
  // chat-completions so that /chat/completions clients can still reach them.
  if (modelId.startsWith('claude')) {
    return withLiveReasoningEfforts(modelId, {
      supportedApis: ['anthropic-messages', 'chat-completions'],
      preferredApi: 'anthropic-messages',
      enableCacheControl: true,
      supportsToolChoice: false,
    })
  }

  return withLiveReasoningEfforts(modelId, DEFAULT_CONFIG)
}

function withLiveReasoningEfforts(modelId: string, config: ModelConfig): ModelConfig {
  const models = state.models?.data
  if (!models) {
    return config
  }

  const liveModel = models.find(model => model.id === modelId)
    ?? models
      .filter(model => modelId.startsWith(`${model.id}-`))
      .sort((a, b) => b.id.length - a.id.length)[0]
  const liveEfforts = liveModel?.capabilities?.supports?.reasoning_effort
  if (!Array.isArray(liveEfforts)) {
    return config
  }

  return {
    ...config,
    supportedReasoningEfforts: liveEfforts.filter(isReasoningEffort),
  }
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return value === 'none'
    || value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
    || value === 'max'
}

function hasModelConfigPrefix(modelId: string, configModelId: string): boolean {
  return modelId.startsWith(`${configModelId}-`)
}
