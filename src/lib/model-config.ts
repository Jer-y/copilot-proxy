import { getProbeOverride } from './api-probe'

export type BackendApiType = 'chat-completions' | 'responses' | 'anthropic-messages'

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
  defaultReasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Supported reasoning effort levels */
  supportedReasoningEfforts?: Array<'low' | 'medium' | 'high' | 'xhigh' | 'max'>
  /** Whether the model supports tool_choice parameter */
  supportsToolChoice?: boolean
  /** Whether the model supports parallel tool calls */
  supportsParallelToolCalls?: boolean
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // Claude models — prefer native Anthropic Messages passthrough, but keep
  // chat-completions available as a proven fallback when /v1/messages is not.
  'claude-sonnet-4': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'chat-completions',
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-sonnet-4.5': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'chat-completions',
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-sonnet-4.6': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'chat-completions',
    enableCacheControl: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'claude-opus-4.5': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'chat-completions',
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-opus-4.6': {
    supportedApis: ['anthropic-messages', 'chat-completions'],
    preferredApi: 'chat-completions',
    enableCacheControl: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
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

  // GPT-5 base models — both APIs
  'gpt-5': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'chat-completions',
    reasoningMode: 'thinking',
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.1': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'chat-completions',
    reasoningMode: 'thinking',
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.2': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'chat-completions',
    reasoningMode: 'thinking',
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5-mini': {
    supportedApis: ['chat-completions', 'responses'],
    preferredApi: 'chat-completions',
    reasoningMode: 'thinking',
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },

  // GPT-5.4 — responses only
  'gpt-5.4': {
    supportedApis: ['responses'],
    reasoningMode: 'thinking',
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
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

  // o-series — responses only
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

  // Gemini models — chat-completions only
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
    return MODEL_CONFIGS[modelId]
  }

  // Try prefix match for families (e.g., 'gpt-5.2-codex-max' matches 'gpt-5.2-codex')
  const entries = Object.entries(MODEL_CONFIGS).sort(
    (a, b) => b[0].length - a[0].length,
  )
  for (const [key, config] of entries) {
    if (modelId.startsWith(key)) {
      return config
    }
  }

  // Default: check if it's a Claude model (native passthrough with chat fallback)
  if (modelId.startsWith('claude')) {
    return {
      supportedApis: ['anthropic-messages', 'chat-completions'],
      preferredApi: 'chat-completions',
      enableCacheControl: true,
      supportsToolChoice: false,
    }
  }

  return DEFAULT_CONFIG
}

/**
 * Check if a model uses thinking/reasoning mode.
 * Compat wrapper — only affects reasoning logic, not routing.
 */
export function isThinkingModeModel(modelId: string): boolean {
  return getModelConfig(modelId).reasoningMode === 'thinking'
}

/**
 * Resolve which backend API to use for a given model.
 *
 * Strategy:
 * 1. Check runtime probe cache (overrides static config if model was probed)
 * 2. Static mapping from MODEL_CONFIGS
 * 3. Family-based guessing for unknown models
 */
export function resolveBackend(modelId: string, requestedApi: BackendApiType): BackendApiType {
  // Check probe cache first — if we've previously discovered the requested API
  // is unsupported for this model, use the alternative immediately
  const probeOverride = getProbeOverride(modelId, requestedApi)
  if (probeOverride) {
    return probeOverride
  }

  const config = getModelConfig(modelId)
  const supported = config.supportedApis

  // If model supports the requested API, use it directly
  if (supported.includes(requestedApi)) {
    return requestedApi
  }

  // Otherwise, use whatever the model supports
  if (supported.length === 1) {
    return supported[0]
  }

  // Both supported — use preferred or fall back to requested
  return config.preferredApi ?? requestedApi
}
