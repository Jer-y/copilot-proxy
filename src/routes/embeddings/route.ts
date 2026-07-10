import type { EmbeddingRequest } from '~/services/copilot/create-embeddings'

import { Hono } from 'hono'
import { forwardError } from '~/lib/error'
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

    const response = await createEmbeddings(payload)

    forwardUpstreamHeaders(c, response.headers)
    return c.json(response.body)
  }
  catch (error) {
    if (error instanceof Error && error.name === 'AbortError')
      return c.body(null)
    return await forwardError(c, error)
  }
})
