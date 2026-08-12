import type { EmbeddingRequest } from '~/services/copilot/create-embeddings'

import { Hono } from 'hono'
import { getAccountRegistry } from '~/lib/account/registry'
import { selectAccount } from '~/lib/account/router'
import { forwardError, HTTPError } from '~/lib/error'
import { enforceManualApproval, enforceRateLimit } from '~/lib/request-policy'
import { EmbeddingRequestSchema } from '~/lib/schemas'
import { state } from '~/lib/state'
import { forwardUpstreamHeaders } from '~/lib/upstream-headers'
import { validateBody } from '~/lib/validate'
import {
  createEmbeddings,
} from '~/services/copilot/create-embeddings'

export const embeddingRoutes = new Hono()

embeddingRoutes.post('/', async (c) => {
  try {
    await enforceRateLimit(state)

    const payload = await validateBody<EmbeddingRequest>(c, EmbeddingRequestSchema)
    await enforceManualApproval(state)

    const selection = selectAccount({
      registry: getAccountRegistry(),
      requestedModel: payload.model,
      headers: c.req.raw.headers,
    })
    const model = selection.ctx.models?.data.find(candidate => candidate.id === selection.effectiveModel)
    const mustValidateCatalog = getAccountRegistry().explicit || selection.ctx.models !== undefined
    if (mustValidateCatalog && (!model || model.capabilities.type !== 'embeddings')) {
      throw new HTTPError(
        `Model ${selection.effectiveModel} is not an embeddings model for account ${selection.ctx.id}.`,
        Response.json({
          error: {
            code: 'model_not_supported',
            message: `Model ${selection.effectiveModel} is not available for embeddings on the selected Copilot account.`,
            type: 'invalid_request_error',
          },
        }, { status: 400 }),
      )
    }

    const selectedPayload = selection.effectiveModel === payload.model
      ? payload
      : { ...payload, model: selection.effectiveModel }
    const response = await createEmbeddings(selectedPayload, { ctx: selection.ctx })

    forwardUpstreamHeaders(c, response.headers)
    return c.json(response.body)
  }
  catch (error) {
    return await forwardError(c, error)
  }
})
