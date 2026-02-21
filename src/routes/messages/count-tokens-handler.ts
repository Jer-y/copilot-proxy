import type { Context } from 'hono'

import type { AnthropicMessagesPayload } from './anthropic-types'

import type { Model } from '~/services/copilot/get-models'
import consola from 'consola'
import { state } from '~/lib/state'

import { getTokenCount } from '~/lib/tokenizer'
import { parseBetaFeatures, translateToOpenAI } from './non-stream-translation'

/**
 * Find a model in the models list, falling back to the base model
 * when a variant suffix (-fast, -1m) doesn't have its own entry.
 */
export function findModelWithFallback(
  modelId: string,
  models: Array<Model> | undefined,
): Model | undefined {
  if (!models) {
    return undefined
  }
  const exact = models.find(m => m.id === modelId)
  if (exact) {
    return exact
  }
  // Strip variant suffix and retry
  const baseModel = modelId.replace(/-(fast|1m)$/, '')
  if (baseModel !== modelId) {
    return models.find(m => m.id === baseModel)
  }
  return undefined
}

/**
 * Determine if the request is from Claude Code based on anthropic-beta tokens.
 * Order-independent: works regardless of token position in the header.
 */
export function isClaudeCodeRequest(anthropicBeta: string | undefined): boolean {
  const betaFeatures = parseBetaFeatures(anthropicBeta)
  return [...betaFeatures].some(f => f.startsWith('claude-code'))
}

/**
 * Handles token counting for Anthropic messages
 */
export async function handleCountTokens(c: Context) {
  try {
    const anthropicBeta = c.req.header('anthropic-beta')

    const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()

    const openAIPayload = translateToOpenAI(anthropicPayload, { anthropicBeta })

    const selectedModel = findModelWithFallback(openAIPayload.model, state.models?.data)

    if (!selectedModel) {
      consola.warn('Model not found, returning default token count')
      return c.json({
        input_tokens: 1,
      })
    }

    const tokenCount = await getTokenCount(openAIPayload, selectedModel)

    if (anthropicPayload.tools && anthropicPayload.tools.length > 0) {
      let mcpToolExist = false
      if (isClaudeCodeRequest(anthropicBeta)) {
        mcpToolExist = anthropicPayload.tools.some(tool =>
          tool.name.startsWith('mcp__'),
        )
      }
      if (!mcpToolExist) {
        if (anthropicPayload.model.startsWith('claude')) {
          // https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview#pricing
          tokenCount.input = tokenCount.input + 346
        }
        else if (anthropicPayload.model.startsWith('grok')) {
          tokenCount.input = tokenCount.input + 480
        }
      }
    }

    let finalTokenCount = tokenCount.input + tokenCount.output
    if (anthropicPayload.model.startsWith('claude')) {
      finalTokenCount = Math.round(finalTokenCount * 1.15)
    }
    else if (anthropicPayload.model.startsWith('grok')) {
      finalTokenCount = Math.round(finalTokenCount * 1.03)
    }

    consola.info('Token count:', finalTokenCount)

    return c.json({
      input_tokens: finalTokenCount,
    })
  }
  catch (error) {
    consola.error('Error counting tokens:', error)
    return c.json({
      input_tokens: 1,
    })
  }
}
