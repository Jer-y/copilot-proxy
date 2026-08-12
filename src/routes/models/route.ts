import type { Model } from '~/services/copilot/get-models'

import process from 'node:process'
import consola from 'consola'
import { Hono } from 'hono'

import { getAccountRegistry } from '~/lib/account/registry'
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

    const registry = getAccountRegistry()
    const modelsData = buildBoundModelCatalog()

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

    const exposedModels = isAccountModelExposureEnabled()
      ? [
          ...modelsData,
          ...registry.list().flatMap(ctx => (ctx.models?.data ?? []).map(model => ({
            ...model,
            id: `${ctx.id}/${model.id}`,
            name: `${ctx.id}/${model.name}`,
          }))),
        ]
      : modelsData
    const models = exposedModels.map(model => ({
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

export function buildBoundModelCatalog(): Model[] {
  const registry = getAccountRegistry()
  if (!registry.explicit)
    return registry.defaultAccount.models?.data ?? []

  const modelIds = new Set(
    registry.list().flatMap(ctx => (ctx.models?.data ?? []).map(model => model.id)),
  )
  const models: Model[] = []
  for (const modelId of modelIds) {
    const accountId = registry.boundAccountIdForModel(modelId)
    const ctx = registry.get(accountId)
    if (!ctx || ctx.availability !== 'ready')
      continue
    const model = ctx.models?.data.find(candidate => candidate.id === modelId)
    if (model)
      models.push(model)
  }
  return models
}

function isAccountModelExposureEnabled(): boolean {
  return process.env.COPILOT_PROXY_EXPOSE_ACCOUNT_MODELS?.trim() === '1'
}

function logCodexCatalogResponse(clientVersion: string, status: number): void {
  // clientVersion has already passed the strict Codex version parser. Keep this
  // purpose-built evidence separate from the generic request logger, which
  // deliberately omits every query name and value.
  consola.info(`Codex model catalog response: client_version=${clientVersion} status=${status}`)
}
