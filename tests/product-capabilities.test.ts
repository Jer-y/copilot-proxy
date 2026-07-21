import type { Model, ModelsResponse } from '~/services/copilot/get-models'
import { describe, expect, test } from 'bun:test'

import { buildModelCapabilityProfiles, selectableDirectModelIdsForRoute, selectableModelIdsForRoute } from '~/lib/product-capabilities'
import { state } from '~/lib/state'

describe('product capability profiles', () => {
  test('classifies explicitly advertised Responses HTTP and WebSocket independently', () => {
    const [profile] = buildModelCapabilityProfiles([
      makeModel('future-responses-model', {
        supportedEndpoints: ['/responses', ' ws:/V1/RESPONSES/ '],
        limits: {
          max_context_window_tokens: 1_000_000,
          max_output_tokens: 128_000,
          max_prompt_tokens: 900_000,
        },
        supports: {
          reasoning_effort: ['low', 'high'],
          tool_calls: true,
          parallel_tool_calls: false,
          vision: true,
        },
      }),
    ])

    expect(profile).toMatchObject({
      id: 'future-responses-model',
      displayName: 'future-responses-model',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      maxPromptTokens: 900_000,
      supportedEndpoints: ['/responses', ' ws:/V1/RESPONSES/ '],
      features: {
        reasoning: true,
        reasoningEfforts: ['low', 'high'],
        toolCalls: true,
        parallelToolCalls: false,
        vision: true,
      },
      routes: {
        chatCompletions: {
          mode: 'unsupported',
          maturity: 'unsupported',
        },
        responsesHttp: {
          mode: 'direct',
          maturity: 'stable',
          source: 'live-catalog-metadata',
        },
        responsesWebSocket: {
          mode: 'direct',
          maturity: 'experimental',
          source: 'live-catalog-metadata',
        },
        anthropicMessages: {
          mode: 'translated',
          maturity: 'conditional',
        },
      },
    })
    expect(profile?.routes.responsesHttp.reasonCode).toBe('catalog_direct')
    expect(profile?.routes.anthropicMessages).toMatchObject({
      reasonCode: 'bounded_translation',
      target: 'responses',
    })
    expect(profile).not.toHaveProperty('productSupport')
    expect(profile).not.toHaveProperty('validationEvidence')
  })

  test('does not infer Responses HTTP or translation from a WebSocket-only endpoint', () => {
    const [profile] = buildModelCapabilityProfiles([
      makeModel('ws-only-model', {
        supportedEndpoints: ['ws:/responses'],
      }),
    ])

    expect(profile?.routes.responsesWebSocket.mode).toBe('direct')
    expect(profile?.routes.responsesHttp.mode).toBe('unsupported')
    expect(profile?.routes.anthropicMessages.mode).toBe('unsupported')
  })

  test('allows translation only between Responses and Anthropic Messages', () => {
    const [profile] = buildModelCapabilityProfiles([
      makeModel('native-messages-model', {
        supportedEndpoints: ['/v1/messages'],
      }),
    ])

    expect(profile?.routes.anthropicMessages.mode).toBe('direct')
    expect(profile?.routes.responsesHttp.mode).toBe('translated')
    expect(profile?.routes.chatCompletions.mode).toBe('unsupported')
    expect(profile?.routes.responsesWebSocket.mode).toBe('unsupported')
  })

  test('keeps bounded translation conditional for preview models while direct routes are experimental', () => {
    const [profile] = buildModelCapabilityProfiles([
      makeModel('preview-responses-model', {
        preview: true,
        supportedEndpoints: ['/responses', 'ws:/responses'],
      }),
    ])

    expect(profile?.routes.responsesHttp).toMatchObject({
      mode: 'direct',
      maturity: 'experimental',
    })
    expect(profile?.routes.responsesWebSocket).toMatchObject({
      mode: 'direct',
      maturity: 'experimental',
    })
    expect(profile?.routes.anthropicMessages).toMatchObject({
      mode: 'translated',
      maturity: 'conditional',
      reasonCode: 'bounded_translation',
    })
  })

  test('labels bundled routing fallback as conditional when live endpoints are absent', () => {
    const [profile] = buildModelCapabilityProfiles([
      makeModel('claude-opus-4.8'),
    ])

    expect(profile?.routes.anthropicMessages).toMatchObject({
      mode: 'direct',
      maturity: 'conditional',
      source: 'bundled-routing-policy',
    })
    expect(profile?.routes.responsesHttp).toMatchObject({
      mode: 'translated',
      maturity: 'conditional',
      source: 'bundled-routing-policy',
    })
    expect(profile?.routes.responsesWebSocket.mode).toBe('unsupported')
  })

  test('keeps bundled fallback independent from the process-wide live catalog', () => {
    const previousModels = state.models
    const input = [makeModel('gpt-4o')]

    try {
      state.models = undefined
      const withoutGlobalCatalog = buildModelCapabilityProfiles(input)

      state.models = {
        object: 'list',
        data: [makeModel('gpt-4o', { supportedEndpoints: ['/responses'] })],
      } satisfies ModelsResponse
      const withGlobalCatalog = buildModelCapabilityProfiles(input)

      expect(withGlobalCatalog).toEqual(withoutGlobalCatalog)
      expect(withGlobalCatalog[0]?.routes).toMatchObject({
        chatCompletions: { mode: 'direct' },
        responsesHttp: { mode: 'unsupported' },
        anthropicMessages: { mode: 'unsupported' },
      })
    }
    finally {
      state.models = previousModels
    }
  })

  test('tolerates live catalog entries that omit optional capability sections', () => {
    const sparseModel = {
      ...makeModel('sparse-live-model', {
        supportedEndpoints: ['/chat/completions'],
      }),
      capabilities: {
        family: 'test',
        object: 'model_capabilities',
        tokenizer: 'o200k_base',
        type: 'chat',
      },
    } as unknown as Model

    const [profile] = buildModelCapabilityProfiles([sparseModel])

    expect(profile).toMatchObject({
      contextWindow: null,
      maxOutputTokens: null,
      maxPromptTokens: null,
      features: {
        reasoning: null,
        reasoningEfforts: [],
        toolCalls: null,
        parallelToolCalls: null,
        vision: null,
      },
      routes: {
        chatCompletions: { mode: 'direct' },
      },
    })
  })

  test('excludes catalog entries that Copilot disables for user model selection', () => {
    const profiles = buildModelCapabilityProfiles([
      makeModel('gpt-visible', {
        supportedEndpoints: ['/responses'],
      }),
      {
        ...makeModel('trajectory-compaction', {
          supportedEndpoints: ['/responses'],
        }),
        model_picker_enabled: false,
      },
    ])

    expect(profiles.map(profile => profile.id)).toEqual(['gpt-visible'])
  })

  test('keeps translated Messages routes visible generally but excludes them from direct client selection', () => {
    const models = [
      makeModel('claude-direct', { supportedEndpoints: ['/v1/messages'] }),
      makeModel('gpt-translated', { supportedEndpoints: ['/responses'] }),
      makeModel('embedding-only', { supportedEndpoints: ['/embeddings'] }),
      {
        ...makeModel('hidden-messages', { supportedEndpoints: ['/v1/messages'] }),
        model_picker_enabled: false,
      },
    ]

    expect(selectableModelIdsForRoute(models, 'anthropicMessages')).toEqual([
      'claude-direct',
      'gpt-translated',
    ])
    expect(selectableDirectModelIdsForRoute(models, 'anthropicMessages')).toEqual([
      'claude-direct',
    ])
  })
})

function makeModel(id: string, options: {
  limits?: Model['capabilities']['limits']
  preview?: boolean
  supportedEndpoints?: Array<string>
  supports?: Model['capabilities']['supports']
} = {}): Model {
  return {
    id,
    capabilities: {
      family: 'test',
      limits: options.limits ?? {},
      object: 'model_capabilities',
      supports: options.supports ?? {},
      tokenizer: 'o200k_base',
      type: 'chat',
    },
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: options.preview ?? false,
    supported_endpoints: options.supportedEndpoints,
    vendor: 'github-copilot',
    version: '1',
  }
}
