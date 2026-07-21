import type { Model } from '~/services/copilot/get-models'

import { describe, expect, test } from 'bun:test'

import { promptForClaudeCodeLaunchCommand, selectClaudeCodeModelIds } from '~/start'

describe('start --claude-code model selection', () => {
  test('uses the same direct Messages choices for the main and small model prompts', async () => {
    const modelIds = selectClaudeCodeModelIds([
      makeModel('claude-direct', ['/v1/messages']),
      makeModel('gpt-translated', ['/responses']),
      makeModel('unsupported', ['/chat/completions']),
      makeModel('claude-policy-direct'),
    ])
    const prompts: Array<{ message: string, modelIds: string[] }> = []
    const selections = ['claude-direct', 'claude-policy-direct']

    const command = await promptForClaudeCodeLaunchCommand(
      'http://127.0.0.1:4399',
      modelIds,
      async (message, choices) => {
        prompts.push({ message, modelIds: [...choices] })
        return selections[prompts.length - 1] ?? choices[0]!
      },
    )

    expect(modelIds).toEqual(['claude-direct', 'claude-policy-direct'])
    expect(prompts).toEqual([
      {
        message: 'Select a model to use with Claude Code',
        modelIds,
      },
      {
        message: 'Select a small model to use with Claude Code',
        modelIds,
      },
    ])
    expect(command).toContain('"ANTHROPIC_MODEL":"claude-direct"')
    expect(command).toContain('"ANTHROPIC_SMALL_FAST_MODEL":"claude-policy-direct"')
    expect(command).not.toContain('gpt-translated')
  })

  test('fails clearly when the live catalog has no direct Messages model', () => {
    expect(() => selectClaudeCodeModelIds([
      makeModel('gpt-translated', ['/responses']),
      makeModel('unsupported', ['/chat/completions']),
    ])).toThrow('No current Copilot model can serve Claude Code through a faithful direct Messages route.')
  })
})

function makeModel(id: string, supportedEndpoints?: string[]): Model {
  return {
    id,
    capabilities: {
      family: 'test',
      limits: {},
      object: 'model_capabilities',
      supports: {},
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    supported_endpoints: supportedEndpoints,
    vendor: 'github-copilot',
    version: '1',
  }
}
