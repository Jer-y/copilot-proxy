import { isApiProbedUnsupported } from './api-probe'

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
  // Claude models — prefer native Anthropic Messages passthrough, with
  // chat-completions available as a proven fallback.
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
    supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
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
      preferredApi: 'anthropic-messages',
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
 * 1. Filter out APIs known-unsupported from probe cache
 * 2. If all configured APIs are probed, try any handler-routable API not yet probed
 * 3. Pick the best candidate: requested API > preferred API > first available
 */
export function resolveBackend(modelId: string, requestedApi: BackendApiType): BackendApiType {
  const config = getModelConfig(modelId)

  // Filter out APIs that are known-unsupported from probe cache
  const candidates = config.supportedApis.filter(
    api => !isApiProbedUnsupported(modelId, api),
  )

  let pool: BackendApiType[]
  if (candidates.length > 0) {
    pool = candidates
  }
  else {
    // All configured APIs probed as unsupported (e.g., unknown model only has CC, CC probed bad).
    // Try any handler-routable API that hasn't been probed yet.
    // Use requestedApi to infer which handler is calling (resolveBackend has no handler context).
    const ROUTABLE_FROM: Record<BackendApiType, BackendApiType[]> = {
      'anthropic-messages': ['anthropic-messages', 'responses', 'chat-completions'],
      'responses': ['responses', 'chat-completions', 'anthropic-messages'],
      'chat-completions': ['chat-completions', 'responses'], // CC handler has no AM branch
    }
    const routable = ROUTABLE_FROM[requestedApi]
    const anyUnprobed = routable.filter(api => !isApiProbedUnsupported(modelId, api))
    // Absolute last resort: TTL will expire and allow retry
    pool = anyUnprobed.length > 0 ? anyUnprobed : config.supportedApis
  }

  // If pool contains the requested API, use it directly
  if (pool.includes(requestedApi))
    return requestedApi

  // Only one candidate — use it
  if (pool.length === 1)
    return pool[0]

  // Multiple candidates — use preferred if available in pool
  if (config.preferredApi && pool.includes(config.preferredApi))
    return config.preferredApi

  return pool[0]
}
