import type { BackendApiType } from './backend-api'
import type { Model } from '~/services/copilot/get-models'

import { endpointToBackendApi } from './backend-api'
import { modelSupportsResponsesWebSocket } from './routing-policy'

export type ProductClientRoute
  = | 'chatCompletions'
    | 'responsesHttp'
    | 'responsesWebSocket'
    | 'anthropicMessages'

export type ProductRouteMode = 'direct' | 'unsupported'
export type ProductMaturity = 'stable' | 'experimental' | 'unsupported'

export interface ProductRouteCapability {
  maturity: ProductMaturity
  mode: ProductRouteMode
  reasonCode: 'catalog_direct' | 'no_faithful_route' | 'websocket_advertised' | 'websocket_not_advertised'
  source: 'live-catalog-metadata' | 'none'
}

export interface ModelCapabilityFeatures {
  parallelToolCalls: boolean | null
  reasoning: boolean | null
  reasoningEfforts: Array<string>
  source: 'live-catalog-metadata'
  toolCalls: boolean | null
  vision: boolean | null
}

export interface ModelCapabilityProfile {
  contextWindow: number | null
  displayName: string
  features: ModelCapabilityFeatures
  id: string
  maxOutputTokens: number | null
  maxPromptTokens: number | null
  preview: boolean
  routes: {
    anthropicMessages: ProductRouteCapability
    chatCompletions: ProductRouteCapability
    responsesHttp: ProductRouteCapability
    responsesWebSocket: ProductRouteCapability
  }
  supportedEndpoints: Array<string>
  vendor: string
}

export interface ModelCapabilitySnapshot {
  models: Array<Model>
  profiles: Array<ModelCapabilityProfile>
}

/**
 * Build the user-visible capability view from the current Copilot model
 * inventory. Runtime metadata is deliberately labelled as routing metadata;
 * it is never promoted to semantic validation evidence.
 */
export function buildModelCapabilityProfiles(models: Array<Model>): Array<ModelCapabilityProfile> {
  return buildModelCapabilitySnapshot(models).profiles
}

export function selectableModelIdsForRoute(
  models: Array<Model>,
  route: ProductClientRoute,
): string[] {
  return buildModelCapabilityProfiles(models)
    .filter(profile => profile.routes[route].mode !== 'unsupported')
    .map(profile => profile.id)
}

export function selectableDirectModelIdsForRoute(
  models: Array<Model>,
  route: ProductClientRoute,
): string[] {
  return buildModelCapabilityProfiles(models)
    .filter(profile => profile.routes[route].mode === 'direct')
    .map(profile => profile.id)
}

export function buildModelCapabilitySnapshot(models: Array<Model>): ModelCapabilitySnapshot {
  const selectableModels = models.filter(model => model.model_picker_enabled !== false)

  return {
    models: selectableModels,
    profiles: selectableModels.map(buildModelCapabilityProfile),
  }
}

function buildModelCapabilityProfile(model: Model): ModelCapabilityProfile {
  const advertisedEndpoints = Array.isArray(model.supported_endpoints)
    ? model.supported_endpoints.filter((endpoint): endpoint is string => typeof endpoint === 'string')
    : []
  const supportedApis = advertisedEndpoints
    .map(endpointToBackendApi)
    .filter((api): api is BackendApiType => api !== undefined)
  const uniqueSupportedApis = new Set(supportedApis)
  const limits = model.capabilities?.limits
  const supports = model.capabilities?.supports
  const reasoningEfforts = Array.isArray(supports?.reasoning_effort)
    ? supports.reasoning_effort.filter(effort => typeof effort === 'string')
    : undefined

  return {
    id: model.id,
    displayName: model.name || model.id,
    vendor: model.vendor || 'unknown',
    preview: model.preview === true,
    supportedEndpoints: advertisedEndpoints,
    contextWindow: toFiniteNumberOrNull(limits?.max_context_window_tokens),
    maxOutputTokens: toFiniteNumberOrNull(limits?.max_output_tokens),
    maxPromptTokens: toFiniteNumberOrNull(limits?.max_prompt_tokens),
    features: {
      reasoning: Array.isArray(reasoningEfforts) ? reasoningEfforts.length > 0 : null,
      reasoningEfforts: Array.isArray(reasoningEfforts) ? [...reasoningEfforts] : [],
      toolCalls: toBooleanOrNull(supports?.tool_calls),
      parallelToolCalls: toBooleanOrNull(supports?.parallel_tool_calls),
      vision: toBooleanOrNull(supports?.vision),
      source: 'live-catalog-metadata',
    },
    routes: {
      chatCompletions: buildHttpRoute({
        clientApi: 'chat-completions',
        model,
        supportedApis: uniqueSupportedApis,
      }),
      responsesHttp: buildHttpRoute({
        clientApi: 'responses',
        model,
        supportedApis: uniqueSupportedApis,
      }),
      responsesWebSocket: buildResponsesWebSocketRoute(advertisedEndpoints),
      anthropicMessages: buildHttpRoute({
        clientApi: 'anthropic-messages',
        model,
        supportedApis: uniqueSupportedApis,
      }),
    },
  }
}

function buildHttpRoute(options: {
  clientApi: BackendApiType
  model: Model
  supportedApis: Set<BackendApiType>
}): ProductRouteCapability {
  const { clientApi, model, supportedApis } = options

  if (supportedApis.has(clientApi)) {
    return {
      mode: 'direct',
      maturity: model.preview ? 'experimental' : 'stable',
      source: 'live-catalog-metadata',
      reasonCode: 'catalog_direct',
    }
  }

  return {
    mode: 'unsupported',
    maturity: 'unsupported',
    source: 'none',
    reasonCode: 'no_faithful_route',
  }
}

function buildResponsesWebSocketRoute(supportedEndpoints: Array<string>): ProductRouteCapability {
  if (!modelSupportsResponsesWebSocket({ supported_endpoints: supportedEndpoints })) {
    return {
      mode: 'unsupported',
      maturity: 'unsupported',
      source: 'none',
      reasonCode: 'websocket_not_advertised',
    }
  }

  return {
    mode: 'direct',
    maturity: 'experimental',
    source: 'live-catalog-metadata',
    reasonCode: 'websocket_advertised',
  }
}

function toBooleanOrNull(value: boolean | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function toFiniteNumberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
