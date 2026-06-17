import type { AnthropicCustomTool, AnthropicTool } from './translation/types'

const ANTHROPIC_SERVER_TOOL_EXACT_TYPES = new Set([
  'advisor_20260301',
])

const ANTHROPIC_SERVER_TOOL_PREFIXES = [
  'bash',
  'code_execution',
  'computer',
  'memory',
  'text_editor',
  'web_search',
]

export type TranslatableAnthropicCustomTool = AnthropicCustomTool & {
  type?: 'custom'
}

export function isAnthropicServerTool(tool: AnthropicTool): boolean {
  if (!('type' in tool) || typeof tool.type !== 'string') {
    return false
  }

  return isAnthropicServerToolType(tool.type)
}

export function isTranslatableAnthropicCustomTool(tool: AnthropicTool): tool is TranslatableAnthropicCustomTool {
  return !('type' in tool) || tool.type === 'custom'
}

function isAnthropicServerToolType(type: string): boolean {
  if (ANTHROPIC_SERVER_TOOL_EXACT_TYPES.has(type)) {
    return true
  }

  return ANTHROPIC_SERVER_TOOL_PREFIXES.some(prefix =>
    type === prefix || type.startsWith(`${prefix}_`),
  )
}
