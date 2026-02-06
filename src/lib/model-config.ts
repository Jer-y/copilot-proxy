export interface ModelConfig {
  /** Whether the model uses thinking mode (drives /responses vs /chat/completions routing) */
  thinkingMode?: boolean
  /** Whether to add copilot_cache_control headers for prompt caching */
  enableCacheControl?: boolean
  /** Default reasoning effort level */
  defaultReasoningEffort?: 'low' | 'medium' | 'high'
  /** Supported reasoning effort levels */
  supportedReasoningEfforts?: Array<'low' | 'medium' | 'high' | 'xhigh'>
  /** Whether the model supports tool_choice parameter */
  supportsToolChoice?: boolean
  /** Whether the model supports parallel tool calls */
  supportsParallelToolCalls?: boolean
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'claude-sonnet-4': {
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-sonnet-4.5': {
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-opus-4.5': {
    enableCacheControl: true,
    defaultReasoningEffort: undefined,
    supportsToolChoice: false,
    supportsParallelToolCalls: false,
  },
  'claude-opus-4.6': {
    enableCacheControl: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsToolChoice: false,
    supportsParallelToolCalls: true,
  },
  'gpt-4o': {
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-4.1': {
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5': {
    thinkingMode: true,
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.1-codex': {
    thinkingMode: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'gpt-5.2-codex': {
    thinkingMode: true,
    defaultReasoningEffort: 'high',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    supportsToolChoice: true,
    supportsParallelToolCalls: true,
  },
  'o3-mini': {
    thinkingMode: true,
    supportsToolChoice: true,
  },
  'o4-mini': {
    thinkingMode: true,
    supportsToolChoice: true,
  },
}

/**
 * Get model-specific configuration.
 * Returns the config for an exact match, or for the base model name (without version suffix).
 * Falls back to an empty config if no match is found.
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

  // Default: check if it's a Claude model (enable cache control by default)
  if (modelId.startsWith('claude')) {
    return { enableCacheControl: true, supportsToolChoice: false }
  }

  return {}
}

/**
 * Check if a model uses thinking mode (and should use /responses endpoint)
 */
export function isThinkingModeModel(modelId: string): boolean {
  return getModelConfig(modelId).thinkingMode === true
}
