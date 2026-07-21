import consola from 'consola'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'
import { fetchCopilot } from '~/lib/upstream-fetch'
import { fetchAuthenticatedCopilot } from './authenticated-fetch'

export async function getModels() {
  // Primary: standard vscode-chat auth (consistent with all other API calls)
  const response = await fetchAuthenticatedCopilot({
    endpoint: '/models',
    request: () => fetchCopilot(`${copilotBaseUrl(state)}/models`, {
      headers: copilotHeaders(state),
    }),
  })

  if (response.ok) {
    return (await response.json()) as ModelsResponse
  }
  consola.warn(`vscode-chat models request failed (${response.status} ${response.statusText}), falling back to copilot-developer-cli`)
  const primaryFailureResponse = await consumeAndRebuildResponse(response)

  // Fallback: copilot-developer-cli for extended model list
  if (state.githubToken) {
    try {
      const cliHeaders = copilotHeaders(state)
      cliHeaders.Authorization = `Bearer ${state.githubToken}`
      cliHeaders['copilot-integration-id'] = 'copilot-developer-cli'
      const cliResponse = await fetchCopilot(`${copilotBaseUrl(state)}/models`, {
        headers: cliHeaders,
      })
      if (cliResponse.ok) {
        return (await cliResponse.json()) as ModelsResponse
      }
      consola.warn(`copilot-developer-cli fallback also failed (${cliResponse.status} ${cliResponse.statusText})`)
      throw new HTTPError('Failed to get models using copilot-developer-cli fallback', cliResponse)
    }
    catch (e) {
      consola.warn('copilot-developer-cli fallback error:', e)
      if (e instanceof HTTPError) {
        throw e
      }
    }
  }

  throw new HTTPError('Failed to get models', primaryFailureResponse)
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
