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

  test('offers 1m Claude Code selectors for direct models with a live 1m context window', async () => {
    const modelIds = selectClaudeCodeModelIds([
      makeModel('claude-opus-5', ['/v1/messages'], 1_000_000),
      makeModel('claude-opus-4.8', ['/v1/messages'], 1_000_000),
      makeModel('claude-haiku-4.5', ['/v1/messages'], 200_000),
    ])

    expect(modelIds).toEqual([
      'claude-opus-5[1m]',
      'claude-opus-4-8[1m]',
      'claude-haiku-4-5',
    ])

    const command = await promptForClaudeCodeLaunchCommand(
      'http://127.0.0.1:4399',
      modelIds,
      async message => message.includes('small')
        ? 'claude-haiku-4-5'
        : 'claude-opus-5[1m]',
    )
    expect(command).toContain('"ANTHROPIC_MODEL":"claude-opus-5[1m]"')
    expect(command).toContain('"ANTHROPIC_SMALL_FAST_MODEL":"claude-haiku-4-5"')
    expect(command).not.toContain('[1m][1m]')
  })
})

function makeModel(id: string, supportedEndpoints?: string[], maxContextWindowTokens?: number): Model {
  return {
    id,
    capabilities: {
      family: 'test',
      limits: {
        ...(maxContextWindowTokens !== undefined && {
          max_context_window_tokens: maxContextWindowTokens,
        }),
      },
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
