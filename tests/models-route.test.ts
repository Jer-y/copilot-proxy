import type { Model, ModelsResponse } from '~/services/copilot/get-models'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { server } from '~/server'

let originalModels: ModelsResponse | undefined
const originalFetch = globalThis.fetch

async function defaultFetchImplementation(): Promise<Response> {
  return Response.json({
    models: [
      makeBundledCodexModel('gpt-5.5'),
    ],
  })
}

const fetchMock = mock(defaultFetchImplementation)

type ModelOverrides = Partial<Omit<Model, 'capabilities'>> & {
  capabilities?: Partial<Omit<Model['capabilities'], 'limits' | 'supports'>> & {
    limits?: Partial<Model['capabilities']['limits']>
    supports?: Partial<Model['capabilities']['supports']>
  }
}

beforeEach(() => {
  originalModels = state.models
  state.models = {
    object: 'list',
    data: [
      makeModel('gpt-5.5', {
        name: 'GPT-5.5',
        supported_endpoints: ['/responses', 'ws:/responses'],
        capabilities: {
          limits: {
            max_context_window_tokens: 1_050_000,
            max_prompt_tokens: 922_000,
            max_output_tokens: 128_000,
          },
          supports: {
            parallel_tool_calls: true,
            vision: true,
          },
        },
      }),
      makeModel('gpt-4o', {
        supported_endpoints: ['/chat/completions'],
      }),
    ],
  }
  fetchMock.mockImplementation(defaultFetchImplementation)
  fetchMock.mockClear()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.models = originalModels
  globalThis.fetch = originalFetch
})

describe('/v1/models', () => {
  test('keeps OpenAI-compatible list shape by default', async () => {
    const response = await server.request('/v1/models')
    const body = await response.json() as {
      object: string
      data: Array<{ id: string, object: string }>
      has_more: boolean
      models?: unknown
    }

    expect(response.status).toBe(200)
    expect(body.object).toBe('list')
    expect(body.data.map(model => model.id)).toEqual(['gpt-5.5', 'gpt-4o'])
    expect(body.models).toBeUndefined()
    expect(body.has_more).toBe(false)
  })

  test('returns Codex model catalog schema for client_version refreshes', async () => {
    const response = await server.request('/v1/models?client_version=0.133.0')
    const body = await response.json() as {
      data?: unknown
      models: Array<{
        slug: string
        display_name: string
        supported_reasoning_levels: Array<{ effort: string }>
        context_window: number
        max_context_window: number
        auto_compact_token_limit: number
        effective_context_window_percent: number
        base_instructions: string
        input_modalities: Array<string>
        model_messages?: unknown
        supports_image_detail_original: boolean
        supports_search_tool: boolean
      }>
    }

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, max-age=300')
    expect(response.headers.get('etag')).toMatch(/^"codex-models-[\da-f]{8}"$/)
    expect(body.data).toBeUndefined()
    expect(body.models).toHaveLength(1)
    expect(body.models[0]).toMatchObject({
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 1_050_000,
      max_context_window: 1_050_000,
      auto_compact_token_limit: 829_800,
      effective_context_window_percent: 87,
      input_modalities: ['text', 'image'],
      supports_image_detail_original: false,
      supports_search_tool: true,
    })
    expect(body.models[0]?.supported_reasoning_levels.map(level => level.effort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(body.models[0]?.base_instructions).toBe('official bundled base instructions')
    expect(body.models[0]?.model_messages).toEqual({
      instructions_template: 'official bundled template',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('rejects invalid Codex client_version before fetching catalog', async () => {
    const response = await server.request('/v1/models?client_version=abc')
    const body = await response.json() as { error: { message: string } }

    expect(response.status).toBe(500)
    expect(body.error.message).toBe('Invalid Codex client_version')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('forwards catalog fetch failures as OpenAI-compatible errors', async () => {
    fetchMock.mockImplementationOnce(async () => {
      return new Response('missing tag', {
        status: 404,
        statusText: 'Not Found',
      })
    })

    const response = await server.request('/v1/models?client_version=0.133.1')
    const body = await response.json() as { error: { message: string } }

    expect(response.status).toBe(500)
    expect(body.error.message).toContain('Failed to fetch Codex bundled model catalog for 0.133.1: 404 Not Found')
  })

  test('negative-caches catalog failures to avoid repeated outbound fetches', async () => {
    fetchMock.mockImplementation(async () => new Response('missing tag', {
      status: 404,
      statusText: 'Not Found',
    }))

    const first = await server.request('/v1/models?client_version=0.133.99')
    const second = await server.request('/v1/models?client_version=0.133.99')

    expect(first.status).toBe(500)
    expect(second.status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('filters response-capable Copilot models that are missing from the bundled Codex catalog', async () => {
    state.models = {
      object: 'list',
      data: [
        makeModel('gpt-5.5', {
          supported_endpoints: ['/responses'],
        }),
        makeModel('not-in-codex-catalog', {
          supported_endpoints: ['/responses'],
        }),
      ],
    }

    const response = await server.request('/v1/models?client_version=0.133.2')
    const body = await response.json() as { models: Array<{ slug: string }> }

    expect(response.status).toBe(200)
    expect(body.models.map(model => model.slug)).toEqual(['gpt-5.5'])
  })

  test('does not infer search or image support when Copilot omits optional capability fields', async () => {
    state.models = {
      object: 'list',
      data: [
        makeModel('gpt-5.5', {
          supported_endpoints: ['/responses'],
          capabilities: {
            supports: {},
          },
        }),
      ],
    }
    fetchMock.mockImplementationOnce(async () => {
      return Response.json({
        models: [
          makeBundledCodexModel('gpt-5.5', {
            input_modalities: ['text'],
            supports_search_tool: false,
            supports_image_detail_original: true,
          }),
        ],
      })
    })

    const response = await server.request('/v1/models?client_version=0.133.3')
    const body = await response.json() as {
      models: Array<{
        input_modalities: Array<string>
        supports_image_detail_original: boolean
        supports_search_tool: boolean
      }>
    }

    expect(response.status).toBe(200)
    expect(body.models[0]).toMatchObject({
      input_modalities: ['text'],
      supports_image_detail_original: false,
      supports_search_tool: false,
    })
  })

  test('honors explicit Copilot capability false values', async () => {
    state.models = {
      object: 'list',
      data: [
        makeModel('gpt-5.5', {
          supported_endpoints: ['/responses'],
          capabilities: {
            supports: {
              vision: false,
              web_search: false,
            },
          },
        }),
      ],
    }

    const response = await server.request('/v1/models?client_version=0.133.4')
    const body = await response.json() as {
      models: Array<{
        input_modalities: Array<string>
        supports_image_detail_original: boolean
        supports_search_tool: boolean
      }>
    }

    expect(response.status).toBe(200)
    expect(body.models[0]).toMatchObject({
      input_modalities: ['text'],
      supports_image_detail_original: false,
      supports_search_tool: false,
    })
  })
})

function makeModel(id: string, overrides: ModelOverrides = {}): Model {
  const { capabilities: capabilityOverrides, ...modelOverrides } = overrides

  return {
    id,
    capabilities: {
      family: 'test',
      object: 'model_capabilities',
      tokenizer: 'o200k_base',
      type: 'chat',
      ...capabilityOverrides,
      limits: {
        ...capabilityOverrides?.limits,
      },
      supports: {
        ...capabilityOverrides?.supports,
      },
    },
    model_picker_enabled: true,
    name: id,
    object: 'model',
    preview: false,
    vendor: 'github-copilot',
    version: '1',
    ...modelOverrides,
  }
}

function makeBundledCodexModel(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    slug,
    display_name: slug === 'gpt-5.5' ? 'GPT-5.5' : slug,
    base_instructions: 'official bundled base instructions',
    model_messages: {
      instructions_template: 'official bundled template',
    },
    supported_reasoning_levels: [
      { effort: 'low', description: 'Fast responses with lighter reasoning' },
      { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
      { effort: 'high', description: 'Greater reasoning depth for complex problems' },
      { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    ],
    context_window: 272_000,
    max_context_window: 272_000,
    effective_context_window_percent: 95,
    input_modalities: ['text', 'image'],
    supports_image_detail_original: true,
    supports_search_tool: true,
    ...overrides,
  }
}
