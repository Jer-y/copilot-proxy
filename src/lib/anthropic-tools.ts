import type { AnthropicCustomTool, AnthropicTool } from './translation/types'

export type TranslatableAnthropicCustomTool = AnthropicCustomTool & {
  type?: 'custom'
}

export function isAnthropicServerTool(tool: AnthropicTool): boolean {
  if (!('type' in tool) || typeof tool.type !== 'string') {
    return false
  }

  // Only the explicitly typed `custom` shape is translatable to a Responses
  // function tool. Every other typed tool (including newly introduced
  // web_fetch/code_execution variants) is owned by the Anthropic server and
  // must stay on native /v1/messages instead of being silently omitted.
  return tool.type !== 'custom'
}

export function isTranslatableAnthropicCustomTool(tool: AnthropicTool): tool is TranslatableAnthropicCustomTool {
  return !('type' in tool) || tool.type === 'custom'
}
