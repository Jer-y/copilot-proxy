const COPILOT_STRIPPED_BETA_FEATURES = new Set([
  // Copilot rejects this opt-in header. Requests that actually declare an
  // advisor_20260301 tool are rejected before forwarding; the header alone has
  // no request semantics to preserve and can be removed safely.
  'advisor-tool-2026-03-01',
])

const CLAUDE_ONE_MILLION_CONTEXT_SELECTOR = '[1m]'
const ONE_MILLION_CONTEXT_TOKENS = 1_000_000

export function normalizeAnthropicModelName(model: string): string {
  const baseModel = model.startsWith('claude-')
    ? model.replace(/(?:\[1m\])+$/i, '')
    : model

  const datedModelMatch = baseModel.match(/^(claude-(?:sonnet|opus|haiku)-\d+(?:\.\d+)?)-\d{8,}$/)
  if (datedModelMatch) {
    return datedModelMatch[1]
  }

  const hyphenVersionMatch = baseModel.match(/^(claude-(?:sonnet|opus|haiku)-\d+)-(\d)(?:-\d{8,})?$/)
  if (hyphenVersionMatch) {
    return `${hyphenVersionMatch[1]}.${hyphenVersionMatch[2]}`
  }

  return baseModel
}

export function toAnthropicClientModelName(model: string): string {
  return model.replace(
    /^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)$/,
    '$1-$2',
  )
}

export function toClaudeCodeModelName(model: string, contextWindowTokens?: number): string {
  const hasOneMillionSelector = /(?:\[1m\])+$/i.test(model)
  const baseModel = hasOneMillionSelector
    ? model.replace(/(?:\[1m\])+$/i, '')
    : model
  const clientModel = toAnthropicClientModelName(baseModel)
  const useOneMillionSelector = clientModel.startsWith('claude-')
    && (hasOneMillionSelector
      || (typeof contextWindowTokens === 'number'
        && Number.isFinite(contextWindowTokens)
        && contextWindowTokens >= ONE_MILLION_CONTEXT_TOKENS))

  return useOneMillionSelector
    ? `${clientModel}${CLAUDE_ONE_MILLION_CONTEXT_SELECTOR}`
    : clientModel
}

export function sanitizeAnthropicBetaHeader(anthropicBeta: string | undefined): string | undefined {
  if (!anthropicBeta) {
    return undefined
  }

  const features = anthropicBeta.split(',').map(s => s.trim()).filter(Boolean)
  const remaining = features.filter(feature => !COPILOT_STRIPPED_BETA_FEATURES.has(feature))
  return remaining.length > 0 ? remaining.join(', ') : undefined
}
