import type { AccountContext } from '~/lib/account/types'

import consola from 'consola'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { fetchCopilot } from '~/lib/upstream-fetch'
import { fetchAuthenticatedCopilot } from './authenticated-fetch'

export async function getModels(ctx: AccountContext = state.defaultAccount) {
  // Primary: Copilot-token auth (consistent with all other API calls)
  const response = await fetchAuthenticatedCopilot(ctx, {
    endpoint: '/models',
    request: () => fetchCopilot(`${copilotBaseUrl(ctx)}/models`, {
      headers: copilotHeaders(ctx),
    }),
  })

  if (response.ok) {
    return await addVscodeChatModels(ctx, await response.json() as ModelsResponse)
  }
  consola.warn(`Copilot-token models request failed (${response.status} ${response.statusText}), falling back to GitHub-token auth`)
  const primaryFailureResponse = await consumeAndRebuildResponse(response)

  // Keep the same client headers when falling back to GitHub-token auth.
  if (ctx.githubToken) {
    try {
      const fallbackHeaders = copilotHeaders(ctx)
      fallbackHeaders.Authorization = `Bearer ${ctx.githubToken}`
      const fallbackResponse = await fetchCopilot(`${copilotBaseUrl(ctx)}/models`, {
        headers: fallbackHeaders,
      })
      if (fallbackResponse.ok) {
        return await addVscodeChatModels(ctx, await fallbackResponse.json() as ModelsResponse, true)
      }
      consola.warn(`GitHub-token fallback also failed (${fallbackResponse.status} ${fallbackResponse.statusText})`)
      throw new HTTPError('Failed to get models using GitHub-token fallback', fallbackResponse)
    }
    catch (e) {
      consola.warn('GitHub-token fallback error:', e)
      if (e instanceof HTTPError) {
        throw e
      }
    }
  }

  throw new HTTPError('Failed to get models', primaryFailureResponse)
}

async function addVscodeChatModels(
  ctx: AccountContext,
  models: ModelsResponse,
  githubTokenAuth = false,
): Promise<ModelsResponse> {
  const request = () => {
    const headers = copilotHeaders(ctx, false, { vscodeChat: true })
    if (githubTokenAuth)
      headers.Authorization = `Bearer ${ctx.githubToken}`
    return fetchCopilot(`${copilotBaseUrl(ctx)}/models`, { headers })
  }
  let response: Response | undefined
  try {
    response = githubTokenAuth
      ? await request()
      : await fetchAuthenticatedCopilot(ctx, {
          endpoint: '/models#vscode-chat',
          contributesToGlobalCircuit: false,
          request,
        })
    if (!response.ok)
      throw new Error('Supplementary model catalog request failed')

    const legacyModels = await response.json() as ModelsResponse
    const primaryIds = new Set(models.data.map(model => model.id))
    // Supplement Gemini from this account's fetched metadata. Other vendors keep
    // the Codex profile, and entries already present there retain its metadata.
    const additions = legacyModels.data.filter(model => model.vendor === 'Google' && !primaryIds.has(model.id))
    if (additions.length === 0)
      return models

    return {
      ...models,
      data: [...models.data, ...additions],
      vscodeChatModelIds: additions.map(model => model.id),
    }
  }
  catch (error) {
    // Release the authenticated request's lease even when its body is unused.
    await response?.body?.cancel().catch(() => {})
    consola.warn('Failed to load supplementary vscode-chat catalog; using the primary catalog without supplementary Google models.', {
      status: response?.status,
      error: error instanceof Error ? error.name : 'UnknownError',
    })
    return models
  }
}

async function consumeAndRebuildResponse(response: Response): Promise<Response> {
  const body = await response.text().catch(() => response.statusText)
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export interface ModelsResponse {
  data: Array<Model>
  object: string
  vscodeChatModelIds?: string[]
}

interface ModelLimits {
  max_context_window_tokens?: number
  max_output_tokens?: number
  max_prompt_tokens?: number
  max_inputs?: number
}

interface ModelSupports {
  tool_calls?: boolean
  parallel_tool_calls?: boolean
  reasoning_effort?: Array<'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
  dimensions?: boolean
  vision?: boolean
  web_search?: boolean
}

interface ModelCapabilities {
  family: string
  limits?: ModelLimits
  object: string
  supports?: ModelSupports
  tokenizer?: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  supported_endpoints?: Array<string>
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
}
