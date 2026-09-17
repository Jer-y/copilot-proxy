import type { BackendApiType } from './model-config'

import type { Model } from '~/services/copilot/get-models'
import { formatBackendApi } from './backend-api'
import { getModelConfig } from './model-config'
import { findModelWithFallback } from './model-utils'

interface BackendRoute {
  backend: BackendApiType
  kind: 'direct'
}

type ClientApi = BackendApiType

const RESPONSES_WEBSOCKET_ENDPOINT_PATTERN = /^wss?:\/(?:v1\/)?responses\/?$/i

export function resolveRoute(
  clientApi: ClientApi,
  model: string,
  onLocalError: (message: string) => never,
  options?: {
    models?: Array<Model>
  },
): BackendRoute {
  const supportedApis = getSupportedApisForRouting(model, options?.models)

  if (supportedApis.has(clientApi)) {
    return { backend: clientApi, kind: 'direct' }
  }

  onLocalError(buildUnsupportedClientApiError(clientApi, model, supportedApis))
}

function getSupportedApisForRouting(
  model: string,
  models?: Array<Model>,
): Set<BackendApiType> {
  const liveModel = findModelWithFallback(model, models)
  if (liveModel?.supported_endpoints?.length) {
    return new Set(
      liveModel.supported_endpoints
        .map(endpointToBackendApi)
        .filter((api): api is BackendApiType => api !== undefined),
    )
  }

  return new Set(getModelConfig(model, models).supportedApis)
}

function endpointToBackendApi(endpoint: string): BackendApiType | undefined {
  const normalized = endpoint.trim().toLowerCase()

  // WebSocket endpoints are transport capabilities, not evidence that the
  // corresponding HTTP API is available. In particular, a model advertising
  // only `ws:/responses` must not be routed through POST /responses.
  if (/^wss?:/.test(normalized)) {
    return undefined
  }

  const normalizedPath = normalized
    .replace(/^\/v1\//, '/')
    .replace(/^v1\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  switch (normalizedPath) {
    case 'chat/completions':
      return 'chat-completions'
    case 'responses':
      return 'responses'
    case 'messages':
      return 'anthropic-messages'
    default:
      return undefined
  }
}

/**
 * Return whether the live Copilot model catalog explicitly advertises the
 * ordinary HTTP Responses endpoint. WebSocket metadata is intentionally not
 * treated as evidence that POST /responses is available.
 */
export function modelSupportsResponsesHttp(
  model: Pick<Model, 'supported_endpoints'> | undefined,
): boolean {
  return model?.supported_endpoints?.some(endpoint =>
    endpointToBackendApi(endpoint) === 'responses',
  ) ?? false
}

/**
 * Return whether the live Copilot model catalog explicitly advertises the
 * Responses WebSocket transport. Ordinary `/responses` support and static
 * model defaults are intentionally insufficient evidence for this capability.
 */
export function modelSupportsResponsesWebSocket(
  model: Pick<Model, 'supported_endpoints'> | undefined,
): boolean {
  return model?.supported_endpoints?.some(endpoint =>
    RESPONSES_WEBSOCKET_ENDPOINT_PATTERN.test(endpoint.trim()),
  ) ?? false
}

function buildUnsupportedClientApiError(
  clientApi: ClientApi,
  model: string,
  supportedApis: ReadonlySet<BackendApiType>,
): string {
  const supportedList = [...supportedApis].map(formatBackendApi).join(', ')
  if (supportedApis.size === 0) {
    return `Model ${model} has no supported backend API.`
  }
  return `Model ${model} cannot be reached via ${formatBackendApi(clientApi)}. Supported backend(s): ${supportedList}. Use a client configured for a supported native API; cross-protocol translation is not supported.`
}
