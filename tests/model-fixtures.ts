import type { Model, ModelsResponse } from '~/services/copilot/get-models'

export function makeModel(id: string, supportedEndpoints: string[] = []): Model {
  return {
    id,
    name: id,
    object: 'model',
    vendor: 'test',
    version: '1',
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: supportedEndpoints,
    capabilities: {
      family: 'test',
      object: 'model_capabilities',
      type: 'chat',
      tokenizer: 'o200k_base',
      limits: { max_context_window_tokens: 200_000, max_output_tokens: 64_000 },
      supports: { tool_calls: true, parallel_tool_calls: true },
    },
  }
}

/** Explicit mocked startup inventory for route tests, never production policy. */
export function createTestModelCatalog(): ModelsResponse {
  return {
    object: 'list',
    data: [
      ...['gpt-4o', 'gpt-4.1'].map(id => makeModel(id, ['/chat/completions'])),
      ...['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4'].map(id => makeModel(id, ['/chat/completions', '/responses', 'ws:/responses'])),
      ...['gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5-codex', 'gpt-5.1-codex', 'gpt-5.2-codex', 'gpt-5.3-codex'].map(id => makeModel(id, ['/responses', 'ws:/responses'])),
      ...['claude-sonnet-4', 'claude-sonnet-4.5', 'claude-sonnet-4.6', 'claude-opus-4.5', 'claude-opus-4.6', 'claude-opus-4.7', 'claude-opus-4.8', 'claude-opus-5', 'claude-haiku-4.5'].map(id => makeModel(id, ['/v1/messages', '/chat/completions'])),
      {
        ...makeModel('text-embedding-3-small'),
        capabilities: {
          family: 'test',
          object: 'model_capabilities',
          type: 'embeddings',
          limits: {},
          supports: {},
        },
      },
    ],
  }
}
