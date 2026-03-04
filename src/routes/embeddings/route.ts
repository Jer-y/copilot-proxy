import type { EmbeddingRequest } from '~/services/copilot/create-embeddings'

import { Hono } from 'hono'
import { forwardError } from '~/lib/error'
import { EmbeddingRequestSchema } from '~/lib/schemas'
import { validateBody } from '~/lib/validate'
import {
  createEmbeddings,

} from '~/services/copilot/create-embeddings'

export const embeddingRoutes = new Hono()

embeddingRoutes.post('/', async (c) => {
  try {
    const payload = await validateBody<EmbeddingRequest>(c, EmbeddingRequestSchema)
    const response = await createEmbeddings(payload)

    return c.json(response)
  }
  catch (error) {
    return await forwardError(c, error)
  }
})
