import type { Model, ModelsResponse } from '~/services/copilot/get-models'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { state } from '~/lib/state'
import { CODEX_CATALOG_MAX_FAILURE_KEYS, CODEX_CATALOG_MAX_IN_FLIGHT, CODEX_CATALOG_MAX_PENDING_KEYS, resetCodexCatalogStateForTesting } from '~/routes/models/codex-compat'
import { server } from '~/server'

let originalModels: ModelsResponse | undefined
const originalFetch = globalThis.fetch

async function defaultFetchImplementation(_input?: Parameters<typeof fetch>[0]): Promise<Response> {
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
  resetCodexCatalogStateForTesting()
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
            web_search: true,
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

  test('keeps the ordinary OpenAI model list compact and compatibility-focused', async () => {
    const response = await server.request('/v1/models')
    const body = await response.json() as {
      data: Array<Record<string, unknown>>
    }

    expect(response.status).toBe(200)
    expect(body.data[0]).toEqual({
      id: 'gpt-5.5',
      object: 'model',
      created: 0,
      owned_by: 'github-copilot',
      display_name: 'GPT-5.5',
    })
  })

  test('keeps model-picker filtering scoped to client-specific catalog behavior', async () => {
    state.models?.data.push(makeModel('trajectory-compaction', {
      model_picker_enabled: false,
      supported_endpoints: ['/responses'],
    }))
    fetchMock.mockImplementationOnce(async () => Response.json({
      models: [
        makeBundledCodexModel('gpt-5.5'),
        makeBundledCodexModel('trajectory-compaction'),
      ],
    }))

    const openAIResponse = await server.request('/v1/models')
    const openAIBody = await openAIResponse.json() as {
      data: Array<{ id: string }>
    }
    const codexResponse = await server.request('/v1/models?client_version=0.133.0')
    const codexBody = await codexResponse.json() as {
      models: Array<{
        slug: string
        visibility: 'hide' | 'list' | 'none'
        supported_in_api: boolean
      }>
    }

    expect(openAIResponse.status).toBe(200)
    expect(openAIBody.data.map(model => model.id)).toContain('trajectory-compaction')
    expect(codexResponse.status).toBe(200)
    expect(codexBody.models.find(model => model.slug === 'trajectory-compaction')).toMatchObject({
      visibility: 'hide',
      supported_in_api: false,
    })
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
        supports_parallel_tool_calls: boolean
        supports_search_tool: boolean
        prefer_websockets: boolean
        supports_websockets: boolean
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
      supports_parallel_tool_calls: true,
      supports_search_tool: true,
      prefer_websockets: true,
      supports_websockets: true,
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
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/rust-v0.133.0/codex-rs/models-manager/models.json',
    )
  })

  test('uses the legacy bundled catalog path for the first command-auth Codex release', async () => {
    const response = await server.request('/v1/models?client_version=0.118.0')

    expect(response.status).toBe(200)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/rust-v0.118.0/codex-rs/core/models.json',
    )
  })

  test('keeps the legacy path through Codex 0.119 alpha 6 and switches at alpha 7', async () => {
    const legacyResponse = await server.request('/v1/models?client_version=0.119.0-alpha.6')
    const migratedResponse = await server.request('/v1/models?client_version=0.119.0-alpha.7')

    expect(legacyResponse.status).toBe(200)
    expect(migratedResponse.status).toBe(200)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      '/rust-v0.119.0-alpha.6/codex-rs/core/models.json',
    )
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      '/rust-v0.119.0-alpha.7/codex-rs/models-manager/models.json',
    )
  })

  test('rejects invalid Codex client_version before fetching catalog', async () => {
    const response = await server.request('/v1/models?client_version=abc')
    const body = await response.json() as { error: { message: string } }

    expect(response.status).toBe(400)
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

  test('bounds active and pending catalog fetches while preserving in-flight key de-duplication', async () => {
    let activeFetches = 0
    let maxActiveFetches = 0
    let releaseFetches: () => void = () => {}
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetches = resolve
    })
    fetchMock.mockImplementation(async () => {
      activeFetches++
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches)
      try {
        await fetchGate
        return Response.json({
          models: [makeBundledCodexModel('gpt-5.5')],
        })
      }
      finally {
        activeFetches--
      }
    })

    const uniqueVersions = Array.from({ length: CODEX_CATALOG_MAX_PENDING_KEYS }, (_, index) => `9.0.${index}`)
    const requests = uniqueVersions.map(version => server.request(`/v1/models?client_version=${version}`))
    await waitFor(() => fetchMock.mock.calls.length === CODEX_CATALOG_MAX_IN_FLIGHT)

    const duplicateRequest = server.request(`/v1/models?client_version=${uniqueVersions[0]}`)
    const overflowResponse = await server.request('/v1/models?client_version=9.0.999')

    expect(overflowResponse.status).toBe(429)
    expect(overflowResponse.headers.get('retry-after')).toBe('5')
    expect(await overflowResponse.json()).toMatchObject({
      error: {
        type: 'rate_limit_error',
        code: 'catalog_fetch_queue_full',
      },
    })

    releaseFetches()
    const responses = await Promise.all([...requests, duplicateRequest])

    expect(responses.every(response => response.status === 200)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(uniqueVersions.length)
    expect(maxActiveFetches).toBe(CODEX_CATALOG_MAX_IN_FLIGHT)
  })

  test('keeps failure negative-cache entries independent from successful catalog FIFO churn', async () => {
    const failedVersion = '8.8.8'
    let failedVersionFetches = 0
    fetchMock.mockImplementation(async (input?: Parameters<typeof fetch>[0]) => {
      if (String(input).includes(`rust-v${failedVersion}/`)) {
        failedVersionFetches++
        return new Response('missing tag', {
          status: 404,
          statusText: 'Not Found',
        })
      }
      return Response.json({
        models: [makeBundledCodexModel('gpt-5.5')],
      })
    })

    const firstFailure = await server.request(`/v1/models?client_version=${failedVersion}`)
    expect(firstFailure.status).toBe(500)

    for (let index = 0; index < 24; index++) {
      const response = await server.request(`/v1/models?client_version=8.9.${index}`)
      expect(response.status).toBe(200)
    }

    const cachedFailure = await server.request(`/v1/models?client_version=${failedVersion}`)
    expect(cachedFailure.status).toBe(500)
    expect(failedVersionFetches).toBe(1)
  })

  test('bounds failure-cache keys without evicting existing negative entries early', async () => {
    fetchMock.mockImplementation(async () => new Response('missing tag', {
      status: 404,
      statusText: 'Not Found',
    }))

    for (let index = 0; index < CODEX_CATALOG_MAX_FAILURE_KEYS; index++) {
      const response = await server.request(`/v1/models?client_version=7.0.${index}`)
      expect(response.status).toBe(500)
    }

    const overflow = await server.request('/v1/models?client_version=7.0.999')
    expect(overflow.status).toBe(429)
    expect(Number(overflow.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await overflow.json()).toMatchObject({
      error: {
        type: 'rate_limit_error',
        code: 'catalog_failure_cache_full',
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(CODEX_CATALOG_MAX_FAILURE_KEYS)

    const existingFailure = await server.request('/v1/models?client_version=7.0.0')
    expect(existingFailure.status).toBe(500)
    expect(fetchMock).toHaveBeenCalledTimes(CODEX_CATALOG_MAX_FAILURE_KEYS)
  })

  test('filters dual-transport Copilot models that are missing from the bundled Codex catalog', async () => {
    state.models = {
      object: 'list',
      data: [
        makeModel('gpt-5.5', {
          supported_endpoints: ['/responses', 'ws:/responses'],
        }),
        makeModel('not-in-codex-catalog', {
          supported_endpoints: ['/responses', 'ws:/responses'],
        }),
      ],
    }

    const response = await server.request('/v1/models?client_version=0.133.2')
    const body = await response.json() as { models: Array<{ slug: string }> }

    expect(response.status).toBe(200)
    expect(body.models.map(model => model.slug)).toEqual(['gpt-5.5'])
  })

  test('hides transport-exclusive and unavailable bundled models after the Codex client merge', async () => {
    state.models = {
      object: 'list',
      data: [
        makeModel('gpt-5.5', {
          supported_endpoints: [' ws:/V1/RESPONSES/ '],
        }),
        makeModel('gpt-5.4', {
          supported_endpoints: [' /V1/RESPONSES/ '],
        }),
        makeModel('gpt-5.3-codex'),
        makeModel('gpt-5.6-sol', {
          supported_endpoints: [' /V1/RESPONSES/ ', ' ws:/V1/RESPONSES/ '],
        }),
      ],
    }
    fetchMock.mockImplementationOnce(async () => {
      return Response.json({
        models: [
          makeBundledCodexModel('gpt-5.5', { prefer_websockets: true, supports_websockets: false }),
          makeBundledCodexModel('gpt-5.4', { prefer_websockets: true, supports_websockets: true }),
          makeBundledCodexModel('gpt-5.3-codex', { prefer_websockets: true, supports_websockets: true }),
          makeBundledCodexModel('gpt-5.6-sol', { prefer_websockets: false, supports_websockets: false }),
          makeBundledCodexModel('gpt-5.2', { prefer_websockets: true, supports_websockets: true }),
        ],
      })
    })

    const response = await server.request('/v1/models?client_version=0.133.5')
    const body = await response.json() as {
      models: Array<{
        slug: string
        visibility: 'hide' | 'list' | 'none'
        supported_in_api: boolean
        prefer_websockets: boolean
        supports_websockets: boolean
      }>
    }

    expect(response.status).toBe(200)
    expect(body.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: 'gpt-5.5',
        visibility: 'hide',
        supported_in_api: true,
        prefer_websockets: true,
        supports_websockets: true,
      }),
      expect.objectContaining({
        slug: 'gpt-5.4',
        visibility: 'hide',
        supported_in_api: true,
        prefer_websockets: false,
        supports_websockets: false,
      }),
      expect.objectContaining({
        slug: 'gpt-5.3-codex',
        visibility: 'hide',
        supported_in_api: false,
        prefer_websockets: false,
        supports_websockets: false,
      }),
      expect.objectContaining({
        slug: 'gpt-5.6-sol',
        visibility: 'list',
        supported_in_api: true,
        prefer_websockets: true,
        supports_websockets: true,
      }),
      expect.objectContaining({
        slug: 'gpt-5.2',
        visibility: 'hide',
        supported_in_api: false,
        prefer_websockets: false,
        supports_websockets: false,
      }),
    ]))
    const bundledModels = [
      makeBundledCodexModel('gpt-5.5'),
      makeBundledCodexModel('gpt-5.4'),
      makeBundledCodexModel('gpt-5.3-codex'),
      makeBundledCodexModel('gpt-5.6-sol'),
      makeBundledCodexModel('gpt-5.2'),
    ]
    const mergedModels = mergeCodexCatalogLikeApiKeyClient(bundledModels, body.models)
    expect(mergedModels
      .filter(model => model.supported_in_api && model.visibility === 'list')
      .map(model => model.slug)).toEqual(['gpt-5.6-sol'])
  })

  test('falls back to bundled search support without inferring image or parallel support when Copilot omits capabilities', async () => {
    const modelWithoutSupports = makeModel('gpt-5.4', {
      supported_endpoints: ['/responses', 'ws:/responses'],
    })
    delete modelWithoutSupports.capabilities.supports
    state.models = {
      object: 'list',
      data: [
        makeModel('gpt-5.5', {
          supported_endpoints: ['/responses', 'ws:/responses'],
          capabilities: {
            supports: {},
          },
        }),
        modelWithoutSupports,
      ],
    }
    fetchMock.mockImplementationOnce(async () => {
      return Response.json({
        models: [
          makeBundledCodexModel('gpt-5.5'),
          makeBundledCodexModel('gpt-5.4', {
            supports_search_tool: undefined,
          }),
        ],
      })
    })

    const response = await server.request('/v1/models?client_version=0.133.3')
    const body = await response.json() as {
      models: Array<{
        input_modalities: Array<string>
        supports_image_detail_original: boolean
        supports_parallel_tool_calls: boolean
        supports_search_tool: boolean
      }>
    }

    expect(response.status).toBe(200)
    expect(body.models).toHaveLength(2)
    for (const model of body.models) {
      expect(model).toMatchObject({
        input_modalities: ['text'],
        supports_image_detail_original: false,
        supports_parallel_tool_calls: false,
      })
    }
    expect(body.models.map(model => model.supports_search_tool)).toEqual([true, false])
  })

  test('honors explicit Copilot search support when the bundled catalog disables it', async () => {
    fetchMock.mockImplementationOnce(async () => {
      return Response.json({
        models: [
          makeBundledCodexModel('gpt-5.5', {
            supports_search_tool: false,
          }),
        ],
      })
    })

    const response = await server.request('/v1/models?client_version=0.133.6')
    const body = await response.json() as {
      models: Array<{ supports_search_tool: boolean }>
    }

    expect(response.status).toBe(200)
    expect(body.models[0]?.supports_search_tool).toBe(true)
  })

  test('honors explicit Copilot capability false values', async () => {
    state.models = {
      object: 'list',
      data: [
        makeModel('gpt-5.5', {
          supported_endpoints: ['/responses', 'ws:/responses'],
          capabilities: {
            supports: {
              vision: false,
              web_search: false,
              parallel_tool_calls: false,
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
        supports_parallel_tool_calls: boolean
        supports_search_tool: boolean
      }>
    }

    expect(response.status).toBe(200)
    expect(body.models[0]).toMatchObject({
      input_modalities: ['text'],
      supports_image_detail_original: false,
      supports_parallel_tool_calls: false,
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
    supports_parallel_tool_calls: true,
    supports_search_tool: true,
    visibility: 'list',
    supported_in_api: true,
    prefer_websockets: true,
    ...overrides,
  }
}

function mergeCodexCatalogLikeApiKeyClient(
  bundledModels: Array<Record<string, unknown> & { slug: string }>,
  remoteModels: Array<Record<string, unknown> & { slug: string }>,
) {
  const mergedModels = bundledModels.map(model => ({ ...model }))
  for (const remoteModel of remoteModels) {
    const existingIndex = mergedModels.findIndex(model => model.slug === remoteModel.slug)
    if (existingIndex === -1)
      mergedModels.push(remoteModel)
    else
      mergedModels[existingIndex] = remoteModel
  }
  return mergedModels
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for catalog fetches')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
