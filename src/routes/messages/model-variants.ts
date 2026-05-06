import type { AnthropicMessagesPayload } from '~/lib/translation/types'

interface ModelVariants {
  fast?: string
  context1m?: string
}

const MODEL_VARIANTS: Record<string, ModelVariants> = {
  'claude-opus-4.6': {
    fast: 'claude-opus-4.6-fast',
    context1m: 'claude-opus-4.6-1m',
  },
  'claude-opus-4.7': {
    context1m: 'claude-opus-4.7-1m-internal',
  },
}

const COPILOT_STRIPPED_BETA_FEATURES = new Set([
  'advisor-tool-2026-03-01',
  'context-1m-2025-08-07',
  'fast-mode-2026-02-01',
])

export function parseBetaFeatures(anthropicBeta: string | undefined): Set<string> {
  if (!anthropicBeta) {
    return new Set()
  }
  return new Set(anthropicBeta.split(',').map(s => s.trim()).filter(Boolean))
}

export function sanitizeAnthropicBetaHeader(anthropicBeta: string | undefined): string | undefined {
  if (!anthropicBeta) {
    return undefined
  }

  const features = anthropicBeta.split(',').map(s => s.trim()).filter(Boolean)
  const remaining = features.filter(feature => !COPILOT_STRIPPED_BETA_FEATURES.has(feature))
  return remaining.length > 0 ? remaining.join(',') : undefined
}

export function applyModelVariant(
  model: string,
  payload: AnthropicMessagesPayload,
  anthropicBeta: string | undefined,
): string {
  const normalizedModel = normalizeAnthropicModelName(model)
  const variants = MODEL_VARIANTS[normalizedModel]
  if (!variants) {
    return normalizedModel
  }

  const betaFeatures = parseBetaFeatures(anthropicBeta)

  if (variants.fast) {
    if (payload.speed === 'fast' || betaFeatures.has('fast-mode-2026-02-01')) {
      return variants.fast
    }
  }

  if (variants.context1m) {
    if (betaFeatures.has('context-1m-2025-08-07')) {
      return variants.context1m
    }
  }

  return normalizedModel
}

function normalizeAnthropicModelName(model: string): string {
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
