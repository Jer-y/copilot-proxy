import type { Context } from 'hono'

import type { AnthropicMessagesPayload } from '~/lib/translation/types'

import { AnthropicMessagesPayloadSchema } from '~/lib/schemas'
import { assertCopilotCompatibleAnthropicRequest } from '~/lib/translation/anthropic-compat'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { validateBody } from '~/lib/validate'
import { createAnthropicCountTokens } from '~/services/copilot/create-anthropic-messages'

import { applyModelVariant, sanitizeAnthropicBetaHeader } from './model-variants'
import { sanitizeForCopilotBackend } from './request-adaptation'

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header('anthropic-beta')

    let anthropicPayload = await validateBody<AnthropicMessagesPayload>(c, AnthropicMessagesPayloadSchema)

    const effectiveModel = applyModelVariant(anthropicPayload.model, anthropicPayload, anthropicBeta)
    if (effectiveModel !== anthropicPayload.model) {
      anthropicPayload = {
        ...anthropicPayload,
        model: effectiveModel,
      }
    }

    sanitizeForCopilotBackend(anthropicPayload)
    assertCopilotCompatibleAnthropicRequest(anthropicPayload, { allowDocuments: true })

    const result = await createAnthropicCountTokens(anthropicPayload, {
      anthropicBeta: sanitizeAnthropicBetaHeader(anthropicBeta),
    })

    forwardUpstreamHeaders(c, result.headers)
    return c.json(result.body)
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return c.body(null)
    }
    throw error
  }
}
