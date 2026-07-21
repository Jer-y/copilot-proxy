import consola from 'consola'
import { Hono } from 'hono'

import { forwardError } from '~/lib/error'
import { state } from '~/lib/state'
import { cacheModels } from '~/lib/utils'

import { createCodexModelsResponseEtag, isCodexModelsRequest, parseCodexClientVersion, toCodexModelsResponse } from './codex-compat'

export const modelRoutes = new Hono()

modelRoutes.get('/', async (c) => {
  let codexClientVersion: string | undefined
  try {
    if (!state.models) {
      // This should be handled by startup logic, but as a fallback.
      await cacheModels()
    }

    const modelsData = state.models?.data ?? []

    const requestUrl = new URL(c.req.url)
    if (isCodexModelsRequest(requestUrl)) {
      codexClientVersion = parseCodexClientVersion(requestUrl)
      const codexModelsResponse = await toCodexModelsResponse(modelsData, requestUrl)
      c.header('Cache-Control', 'private, max-age=300')
      // Codex stores this value with its on-disk model cache; it does not use HTTP 304 here.
      c.header('ETag', createCodexModelsResponseEtag(codexModelsResponse))
      const response = c.json(codexModelsResponse)
      logCodexCatalogResponse(codexClientVersion, response.status)
      return response
    }

    const models = modelsData.map(model => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.vendor,
      display_name: model.name,
    }))

    return c.json({
      object: 'list',
      data: models,
      has_more: false,
    })
  }
  catch (error) {
    const response = await forwardError(c, error)
    if (codexClientVersion)
      logCodexCatalogResponse(codexClientVersion, response.status)
    return response
  }
})

function logCodexCatalogResponse(clientVersion: string, status: number): void {
  // clientVersion has already passed the strict Codex version parser. Keep this
  // purpose-built evidence separate from the generic request logger, which
  // deliberately omits every query name and value.
  consola.info(`Codex model catalog response: client_version=${clientVersion} status=${status}`)
}
