import type { AccountRegistry } from './registry'
import type { AccountContext, ClientSurface, RequiredAccountRoute } from './types'

import { findModelWithFallback } from '~/lib/model-utils'
import { modelSupportsResponsesWebSocket, resolveRoute } from '~/lib/routing-policy'
import { normalizeAnthropicModelName } from '~/routes/messages/model-normalization'

export interface RequiredRouteAssessment {
  accountId: string
  model: string
  ready: boolean
  reason?: string
  surface: ClientSurface
}

export function assessRequiredRoute(
  registry: AccountRegistry,
  requiredRoute: RequiredAccountRoute,
): RequiredRouteAssessment {
  const effectiveModel = requiredRouteEffectiveModel(requiredRoute)
  const accountId = boundAccountIdForRequiredRoute(registry, requiredRoute)
  const ctx = registry.get(accountId)
  const base = {
    accountId,
    model: requiredRoute.model,
    surface: requiredRoute.surface,
  }
  if (!ctx || ctx.availability !== 'ready') {
    return {
      ...base,
      ready: false,
      reason: ctx?.unavailableReason ?? 'account_unavailable',
    }
  }

  const reason = unsupportedReason(ctx, requiredRoute.surface, effectiveModel)
  return reason
    ? { ...base, ready: false, reason }
    : { ...base, ready: true }
}

export function boundAccountIdForRequiredRoute(
  registry: AccountRegistry,
  requiredRoute: RequiredAccountRoute,
): string {
  return registry.boundAccountIdForModel(requiredRouteEffectiveModel(requiredRoute))
}

export function requiredRouteEffectiveModel(requiredRoute: RequiredAccountRoute): string {
  return requiredRoute.surface === 'anthropic-messages'
    || requiredRoute.surface === 'responses-http'
    || requiredRoute.surface === 'responses-websocket'
    ? normalizeAnthropicModelName(requiredRoute.model)
    : requiredRoute.model
}

function unsupportedReason(
  ctx: AccountContext,
  surface: ClientSurface,
  modelId: string,
): string | undefined {
  const model = surface === 'embeddings' || surface === 'responses-websocket'
    ? ctx.models?.data.find(candidate => candidate.id === modelId)
    : findModelWithFallback(modelId, ctx.models?.data)
  if (!model)
    return 'model_unavailable'

  if (surface === 'embeddings')
    return model.capabilities.type === 'embeddings' ? undefined : 'embeddings_unsupported'
  if (surface === 'responses-websocket') {
    return modelSupportsResponsesWebSocket(model)
      ? undefined
      : 'responses_websocket_unsupported'
  }

  const clientApi = surface === 'responses-http'
    ? 'responses'
    : surface
  try {
    const route = resolveRoute(clientApi, modelId, message => throwRouteError(message), {
      models: ctx.models?.data,
    })
    if (surface === 'chat-completions' && route.backend !== 'chat-completions')
      return 'chat_completions_unsupported'
    return undefined
  }
  catch {
    return `${surface.replaceAll('-', '_')}_unsupported`
  }
}

function throwRouteError(message: string): never {
  throw new Error(message)
}
