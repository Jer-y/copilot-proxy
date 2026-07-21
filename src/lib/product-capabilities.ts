import type { BackendApiType } from './model-config'
import type { Model } from '~/services/copilot/get-models'

import { getBundledModelConfig } from './model-config'
import { modelSupportsResponsesWebSocket } from './routing-policy'

export type ProductClientRoute
  = | 'chatCompletions'
    | 'responsesHttp'
    | 'responsesWebSocket'
    | 'anthropicMessages'

export type ProductRouteMode = 'direct' | 'translated' | 'unsupported'
export type ProductMaturity = 'stable' | 'conditional' | 'experimental' | 'unsupported'

export interface ProductRouteCapability {
  maturity: ProductMaturity
  mode: ProductRouteMode
  reasonCode: 'bounded_translation' | 'catalog_direct' | 'no_faithful_route' | 'policy_direct' | 'websocket_advertised' | 'websocket_not_advertised'
  source: 'live-catalog-metadata' | 'bundled-routing-policy' | 'none'
  target?: BackendApiType
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
  const hasLiveEndpointMetadata = advertisedEndpoints.length > 0
  const supportedApis = hasLiveEndpointMetadata
    ? advertisedEndpoints
        .map(endpointToBackendApi)
        .filter((api): api is BackendApiType => api !== undefined)
    : getBundledModelConfig(model.id).supportedApis
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
        hasLiveEndpointMetadata,
        model,
        supportedApis: uniqueSupportedApis,
      }),
      responsesHttp: buildHttpRoute({
        clientApi: 'responses',
        hasLiveEndpointMetadata,
        model,
        supportedApis: uniqueSupportedApis,
      }),
      responsesWebSocket: buildResponsesWebSocketRoute(advertisedEndpoints),
      anthropicMessages: buildHttpRoute({
        clientApi: 'anthropic-messages',
        hasLiveEndpointMetadata,
        model,
        supportedApis: uniqueSupportedApis,
      }),
    },
  }
}

function buildHttpRoute(options: {
  clientApi: BackendApiType
  hasLiveEndpointMetadata: boolean
  model: Model
  supportedApis: Set<BackendApiType>
}): ProductRouteCapability {
  const { clientApi, hasLiveEndpointMetadata, model, supportedApis } = options
  const source = hasLiveEndpointMetadata ? 'live-catalog-metadata' : 'bundled-routing-policy'

  if (supportedApis.has(clientApi)) {
    return {
      mode: 'direct',
      maturity: hasLiveEndpointMetadata
        ? model.preview ? 'experimental' : 'stable'
        : 'conditional',
      source,
      reasonCode: hasLiveEndpointMetadata ? 'catalog_direct' : 'policy_direct',
    }
  }

  const peer = translatablePeer(clientApi)
  if (peer && supportedApis.has(peer)) {
    return {
      mode: 'translated',
      maturity: 'conditional',
      source,
      reasonCode: 'bounded_translation',
      target: peer,
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

function translatablePeer(clientApi: BackendApiType): BackendApiType | undefined {
  if (clientApi === 'responses')
    return 'anthropic-messages'
  if (clientApi === 'anthropic-messages')
    return 'responses'
  return undefined
}

function endpointToBackendApi(endpoint: string): BackendApiType | undefined {
  const normalized = endpoint.trim().toLowerCase()
  if (/^wss?:/.test(normalized))
    return undefined

  const normalizedPath = normalized
    .replace(/^\/v1\//, '/')
    .replace(/^v1\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  switch (normalizedPath) {
    case 'chat/completions':
      return 'chat-completions'
    case 'messages':
      return 'anthropic-messages'
    case 'responses':
      return 'responses'
    default:
      return undefined
  }
}

function toBooleanOrNull(value: boolean | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function toFiniteNumberOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
