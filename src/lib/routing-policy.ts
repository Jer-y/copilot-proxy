import type { BackendApiType } from './backend-api'

import type { Model } from '~/services/copilot/get-models'
import { endpointToBackendApi, formatBackendApi } from './backend-api'
import { HTTPError } from './error'
import { findModel } from './model-utils'

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
  if (!options?.models) {
    throw new HTTPError('Copilot model catalog is unavailable.', Response.json({
      error: { type: 'api_error', code: 'model_catalog_unavailable', message: 'Copilot model catalog is unavailable. Restore model access and restart the proxy.' },
    }, { status: 503 }))
  }
  const liveModel = findModel(model, options.models)
  if (!liveModel)
    onLocalError(`Model ${model} is not available in the selected account's fetched catalog.`)
  const supportedApis = new Set((liveModel.supported_endpoints ?? [])
    .map(endpointToBackendApi)
    .filter((api): api is BackendApiType => api !== undefined))

  if (supportedApis.has(clientApi)) {
    return { backend: clientApi, kind: 'direct' }
  }

  onLocalError(buildUnsupportedClientApiError(clientApi, model, supportedApis))
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
    return `Model ${model} has no advertised native HTTP endpoint in the fetched catalog.`
  }
  return `Model ${model} cannot be reached via ${formatBackendApi(clientApi)}. Supported backend(s): ${supportedList}. Use a client configured for a supported native API; cross-protocol translation is not supported.`
}
