import type { Context } from 'hono'

import type { AnthropicMessagesPayload } from '~/lib/translation/types'

import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { resolveRoute } from '~/lib/routing-policy'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { assertCopilotCompatibleAnthropicRequest, throwAnthropicInvalidRequestError } from '~/lib/translation/anthropic-compat'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { validateBody } from '~/lib/validate'
import { createAnthropicCountTokens } from '~/services/copilot/create-anthropic-messages'

import { normalizeAnthropicModelName, sanitizeAnthropicBetaHeader } from './model-normalization'
import {
  assertNoUnsupportedAdvisorToolsForCopilot,
  normalizeAdaptiveThinkingForCopilot,
  prepareAnthropicPayloadForNativeCopilotBackend,
} from './request-adaptation'

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  await enforceRateLimit(state)

  const anthropicBeta = c.req.header('anthropic-beta')

  let anthropicPayload = await validateBody<AnthropicMessagesPayload>(c, AnthropicMessagesPayloadSchema)

  const effectiveModel = normalizeAnthropicModelName(anthropicPayload.model)
  if (effectiveModel !== anthropicPayload.model) {
    anthropicPayload = {
      ...anthropicPayload,
      model: effectiveModel,
    }
  }

  normalizeAdaptiveThinkingForCopilot(anthropicPayload)
  assertNoUnsupportedAdvisorToolsForCopilot(anthropicPayload)

  const route = resolveRoute('anthropic-messages', effectiveModel, throwAnthropicInvalidRequestError, {
    models: state.models?.data,
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

  // Count the exact request shape used by the native /v1/messages path.
  // In particular, Copilot-unsupported text documents must be expanded in
  // both endpoints or count_tokens can disagree with the actual request.
  assertCopilotCompatibleAnthropicRequest(anthropicPayload, { allowDocuments: true })
  await prepareAnthropicPayloadForNativeCopilotBackend(anthropicPayload)

  await enforceManualApproval(state)

  const result = await createAnthropicCountTokens(anthropicPayload, {
    anthropicBeta: sanitizeAnthropicBetaHeader(anthropicBeta),
  })

  forwardUpstreamHeaders(c, result.headers)
  return c.json(result.body)
}
