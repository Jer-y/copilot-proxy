import type { AccountRegistry } from './registry'
import type { AccountContext } from './types'

import { HTTPError } from '~/lib/error'

export interface AccountSelection {
  ctx: AccountContext
  effectiveModel: string
  source: 'websocket-pin' | 'header' | 'model-prefix' | 'route-rule' | 'default'
}

export function selectAccount(input: {
  registry: AccountRegistry
  requestedModel: string
  headers: Headers
  pinnedAccountId?: string
  normalizeModel?: (model: string) => string
}): AccountSelection {
  const headerAccountId = normalizeHeaderAccount(input.headers.get('x-copilot-account'))
  const prefix = parseAccountModelPrefix(input.registry, input.requestedModel)
  const selectedModel = prefix?.model ?? input.requestedModel
  const effectiveModel = input.normalizeModel?.(selectedModel) ?? selectedModel

  if (headerAccountId && prefix?.accountId && headerAccountId !== prefix.accountId) {
    throwAccountSelectionError(
      409,
      'account_selector_conflict',
      `x-copilot-account selects ${headerAccountId}, but the model prefix selects ${prefix.accountId}.`,
    )
  }

  if (input.pinnedAccountId) {
    const explicitAccountId = headerAccountId ?? prefix?.accountId
    if (explicitAccountId && explicitAccountId !== input.pinnedAccountId) {
      throwAccountSelectionError(
        409,
        'websocket_account_pin_conflict',
        `This Responses WebSocket is pinned to account ${input.pinnedAccountId}; open a new connection to use ${explicitAccountId}.`,
      )
    }
    return buildSelection(
      input.registry,
      input.pinnedAccountId,
      effectiveModel,
      'websocket-pin',
    )
  }

  if (headerAccountId) {
    return buildSelection(
      input.registry,
      headerAccountId,
      effectiveModel,
      'header',
    )
  }
  if (prefix) {
    return buildSelection(
      input.registry,
      prefix.accountId,
      effectiveModel,
      'model-prefix',
    )
  }

  const route = input.registry.routes.find(rule => globMatches(rule.match, effectiveModel))
  return buildSelection(
    input.registry,
    route?.account ?? input.registry.defaultAccountId,
    effectiveModel,
    route ? 'route-rule' : 'default',
  )
}

export function selectUnmodeledAccount(input: {
  registry: AccountRegistry
  headers: Headers
}): AccountSelection {
  const headerAccountId = normalizeHeaderAccount(input.headers.get('x-copilot-account'))
  const accountId = headerAccountId ?? input.registry.defaultAccountId
  return buildSelection(
    input.registry,
    accountId,
    '',
    headerAccountId ? 'header' : 'default',
    true,
  )
}

function buildSelection(
  registry: AccountRegistry,
  accountId: string,
  effectiveModel: string,
  source: AccountSelection['source'],
  allowEmptyModel = false,
): AccountSelection {
  const ctx = registry.get(accountId)
  if (!ctx) {
    throwAccountSelectionError(
      400,
      'unknown_copilot_account',
      `Unknown Copilot account: ${accountId}`,
    )
  }
  if (!effectiveModel && !allowEmptyModel) {
    throwAccountSelectionError(
      400,
      'invalid_account_model_prefix',
      `Model prefix ${accountId}/ must include a model id.`,
    )
  }
  if (ctx.availability === 'unavailable' || (registry.explicit && ctx.availability !== 'ready')) {
    throwAccountSelectionError(
      503,
      'copilot_account_unavailable',
      `Copilot account ${accountId} is unavailable${ctx.unavailableReason ? `: ${ctx.unavailableReason}` : '.'}`,
    )
  }
  return { ctx, effectiveModel, source }
}

function parseAccountModelPrefix(
  registry: AccountRegistry,
  requestedModel: string,
): { accountId: string, model: string } | undefined {
  const separator = requestedModel.indexOf('/')
  if (separator < 1)
    return undefined
  const accountId = requestedModel.slice(0, separator)
  const model = requestedModel.slice(separator + 1)
  if (!registry.get(accountId)) {
    throwAccountSelectionError(
      400,
      'unknown_copilot_account',
      `Model prefix references unknown Copilot account: ${accountId}`,
    )
  }
  return { accountId, model }
}

function normalizeHeaderAccount(value: string | null): string | undefined {
  if (value === null)
    return undefined
  const normalized = value.trim()
  if (!normalized) {
    throwAccountSelectionError(
      400,
      'invalid_copilot_account',
      'x-copilot-account must contain an account id.',
    )
  }
  return normalized
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`).test(value)
}

function throwAccountSelectionError(
  status: 400 | 409 | 503,
  code: string,
  message: string,
): never {
  throw new HTTPError(message, Response.json({
    error: {
      code,
      message,
      type: status === 503 ? 'api_error' : 'invalid_request_error',
    },
  }, { status }))
}
