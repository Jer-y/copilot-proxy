import consola from 'consola'

import { copilotBaseUrl, copilotHeaders } from '~/lib/api-config'
import { HTTPError } from '~/lib/error'
import { state } from '~/lib/state'

export async function getModels() {
  // Try with copilot-developer-cli integration for extended model list
  if (state.githubToken) {
    try {
      const cliHeaders = copilotHeaders(state)
      cliHeaders.Authorization = `Bearer ${state.githubToken}`
      cliHeaders['copilot-integration-id'] = 'copilot-developer-cli'
      const response = await fetch(`${copilotBaseUrl(state)}/models`, {
        headers: cliHeaders,
      })
      if (response.ok) {
        return (await response.json()) as ModelsResponse
      }
      consola.warn(`copilot-developer-cli models request failed (${response.status} ${response.statusText}), falling back to standard auth`)
    }
    catch (e) {
      consola.warn('copilot-developer-cli models request error, falling back:', e)
    }
  }

  // Fallback: standard copilot token auth
  const headers = copilotHeaders(state)
  const response = await fetch(`${copilotBaseUrl(state)}/models`, {
    headers,
  })

  if (!response.ok)
    throw new HTTPError('Failed to get models', response)

  return (await response.json()) as ModelsResponse
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
  dimensions?: boolean
}

interface ModelCapabilities {
  family: string
  limits: ModelLimits
  object: string
  supports: ModelSupports
  tokenizer: string
  type: string
}

export interface Model {
  capabilities: ModelCapabilities
  id: string
  model_picker_enabled: boolean
  name: string
  object: string
  preview: boolean
  vendor: string
  version: string
  policy?: {
    state: string
    terms: string
  }
}
