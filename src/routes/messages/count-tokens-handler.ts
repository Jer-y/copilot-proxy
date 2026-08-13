import type { Context } from 'hono'

import type { AnthropicMessagesPayload } from '~/lib/translation/types'

import { getAccountRegistry } from '~/lib/account/registry'
import { selectAccount } from '~/lib/account/router'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { resolveRoute } from '~/lib/routing-policy'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { throwAnthropicInvalidRequestError } from '~/lib/translation/anthropic-compat'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { validateBody } from '~/lib/validate'
import { createAnthropicCountTokens } from '~/services/copilot/create-anthropic-messages'

import { normalizeAnthropicModelName, sanitizeAnthropicBetaHeader } from './model-normalization'

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  await enforceRateLimit(state)

  const anthropicBeta = c.req.header('anthropic-beta')

  let anthropicPayload = await validateBody<AnthropicMessagesPayload>(c, AnthropicMessagesPayloadSchema)

  const selection = selectAccount({
    registry: getAccountRegistry(),
    requestedModel: anthropicPayload.model,
    headers: c.req.raw.headers,
    normalizeModel: normalizeAnthropicModelName,
  })
  const effectiveModel = selection.effectiveModel
  if (effectiveModel !== anthropicPayload.model) {
    anthropicPayload = {
      ...anthropicPayload,
      model: effectiveModel,
    }
  }

  const route = resolveRoute('anthropic-messages', effectiveModel, throwAnthropicInvalidRequestError, {
    models: selection.ctx.models?.data,
  })

  if (route.backend === 'responses') {
    throwAnthropicInvalidRequestError(
      `Anthropic token counting is unavailable for model ${effectiveModel} because its generation route uses the Responses API and the selected GitHub Copilot backend does not expose /responses/input_tokens.`,
    )
  }
  if (route.backend !== 'anthropic-messages' || route.kind !== 'direct') {
    throwAnthropicInvalidRequestError(
      `Model ${effectiveModel} cannot be served by the Anthropic token-counting endpoint.`,
    )
  }

  // Copilot's token-counting endpoint accepts request shapes that native
  // generation rejects. Keep this path endpoint-specific and forward the
  // validated payload without generation-only sanitization or document gates.
  // The advisor beta header has no token-count semantics and is stripped
  // separately because Copilot rejects the header while accepting the tool.

  await enforceManualApproval(state)

  const result = await createAnthropicCountTokens(anthropicPayload, {
    anthropicBeta: sanitizeAnthropicBetaHeader(anthropicBeta),
    ctx: selection.ctx,
  })

  forwardUpstreamHeaders(c, result.headers)
  return c.json(result.body)
}
