import type { Context } from 'hono'

import type { AnthropicMessagesPayload } from '~/lib/translation/types'

import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { assertCopilotCompatibleAnthropicRequest } from '~/lib/translation/anthropic-compat'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { validateBody } from '~/lib/validate'
import { createAnthropicCountTokens } from '~/services/copilot/create-anthropic-messages'

import { normalizeAnthropicModelName, sanitizeAnthropicBetaHeader } from './model-normalization'
import { prepareAnthropicPayloadForNativeCopilotBackend } from './request-adaptation'

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

  // Count the exact request shape used by the native /v1/messages path.
  // In particular, Copilot-unsupported text documents must be expanded in
  // both endpoints or count_tokens can disagree with the actual request.
  await prepareAnthropicPayloadForNativeCopilotBackend(anthropicPayload)
  assertCopilotCompatibleAnthropicRequest(anthropicPayload, { allowDocuments: true })

  await enforceManualApproval(state)

  const result = await createAnthropicCountTokens(anthropicPayload, {
    anthropicBeta: sanitizeAnthropicBetaHeader(anthropicBeta),
  })

  forwardUpstreamHeaders(c, result.headers)
  return c.json(result.body)
}
