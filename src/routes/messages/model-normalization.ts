const COPILOT_STRIPPED_BETA_FEATURES = new Set([
  // Copilot rejects this opt-in header. Requests that actually declare an
  // advisor_20260301 tool are rejected before forwarding; the header alone has
  // no request semantics to preserve and can be removed safely.
  'advisor-tool-2026-03-01',
])

export function normalizeAnthropicModelName(model: string): string {
  const datedModelMatch = model.match(/^(claude-(?:sonnet|opus|haiku)-\d+(?:\.\d+)?)-\d{8,}$/)
  if (datedModelMatch) {
    return datedModelMatch[1]
  }

  const hyphenVersionMatch = model.match(/^(claude-(?:sonnet|opus|haiku)-\d+)-(\d)(?:-\d{8,})?$/)
  if (hyphenVersionMatch) {
    return `${hyphenVersionMatch[1]}.${hyphenVersionMatch[2]}`
  }

  return model
}

export function toAnthropicClientModelName(model: string): string {
  return model.replace(
    /^(claude-(?:sonnet|opus|haiku)-\d+)\.(\d+)$/,
    '$1-$2',
  )
}

export function sanitizeAnthropicBetaHeader(anthropicBeta: string | undefined): string | undefined {
  if (!anthropicBeta) {
    return undefined
  }

  const features = anthropicBeta.split(',').map(s => s.trim()).filter(Boolean)
  const remaining = features.filter(feature => !COPILOT_STRIPPED_BETA_FEATURES.has(feature))
  return remaining.length > 0 ? remaining.join(', ') : undefined
}
