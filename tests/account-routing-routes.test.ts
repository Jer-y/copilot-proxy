import type { AccountsConfiguration } from '~/lib/account/types'
import type { ModelsResponse } from '~/services/copilot/get-models'

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'

import { AccountRegistry } from '~/lib/account/registry'
import { setDefaultAccountContext, state } from '~/lib/state'
import { server } from '~/server'

const originalAccounts = state.accounts
const originalDefaultAccount = state.defaultAccount
const originalFetch = globalThis.fetch
const calls: Array<{
  body?: Record<string, unknown>
  headers: Headers
  url: string
}> = []

async function handleFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = String(input)
  const body = typeof init?.body === 'string'
    ? JSON.parse(init.body) as Record<string, unknown>
    : undefined
  calls.push({ body, headers: new Headers(init?.headers), url })

  if (url.endsWith('/v1/messages')) {
    return Response.json({
      id: 'msg_account_route',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      model: body?.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  if (url.endsWith('/responses/input_tokens') || url.endsWith('/responses/compact'))
    return Response.json({ ok: true })

  throw new Error(`Unexpected upstream URL: ${url}`)
}

const fetchMock = mock(handleFetch)

beforeEach(() => {
  calls.length = 0
  fetchMock.mockClear()
  fetchMock.mockImplementation(handleFetch)
  globalThis.fetch = fetchMock as unknown as typeof fetch
  const registry = createRegistry()
  state.accounts = registry
  setDefaultAccountContext(registry.defaultAccount)
})

afterEach(() => {
  state.accounts?.stopRefreshes()
  state.accounts = originalAccounts
  setDefaultAccountContext(originalDefaultAccount)
  globalThis.fetch = originalFetch
})

describe('multi-account model routing through real proxy handlers', () => {
  test('routes historical Claude aliases by their canonical upstream model', async () => {
    for (const path of ['/v1/messages', '/v1/responses']) {
      calls.length = 0
      const response = await server.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(path.endsWith('/messages')
          ? {
              model: 'claude-opus-4-8-20250514',
              max_tokens: 32,
              messages: [{ role: 'user', content: 'hello' }],
            }
          : {
              model: 'claude-opus-4-8-20250514',
              store: false,
              input: 'hello',
            }),
      })

      expect(response.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe('https://api.enterprise.githubcopilot.com/v1/messages')
      expect(calls[0]?.headers.get('authorization')).toBe('Bearer work-copilot-token')
      expect(calls[0]?.body?.model).toBe('claude-opus-4.8')
      expect((await response.json() as { model?: string }).model).toBe('claude-opus-4-8-20250514')
    }
  })

  test('routes Responses helper bodies and strips account prefixes before forwarding', async () => {
    for (const [path, model] of [
      ['/v1/responses/input_tokens', 'gpt-5.4'],
      ['/v1/responses/compact', 'work/gpt-5.4'],
    ] as const) {
      calls.length = 0
      const response = await server.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, input: 'hello', future_field: { keep: true } }),
      })

      expect(response.status).toBe(200)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(`https://api.enterprise.githubcopilot.com${path.slice(3)}`)
      expect(calls[0]?.headers.get('authorization')).toBe('Bearer work-copilot-token')
      expect(calls[0]?.body).toEqual({
        model: 'gpt-5.4',
        input: 'hello',
        future_field: { keep: true },
      })
    }
  })

  test('keeps Responses helper recovery circuits isolated by effective model', async () => {
    const work = state.accounts!.get('work')!
    const refresh = spyOn(work.tokens, 'refreshAfterFailure').mockResolvedValue({
      generation: 1,
      outcome: 'refreshed',
    })
    let modelAAttempts = 0
    let modelBAttempts = 0
    fetchMock.mockImplementation(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { model?: string }
        : {}
      if (body.model === 'model-a') {
        modelAAttempts++
        return new Response('Forbidden\n', {
          status: 403,
          headers: {
            'Content-Type': 'text/plain',
            'X-GitHub-Request-Id': `model-a-${modelAAttempts}`,
          },
        })
      }
      if (body.model === 'model-b') {
        modelBAttempts++
        return Response.json({ ok: true })
      }
      return await handleFetch(input, init)
    })

    try {
      const rejected = await server.request('/v1/responses/input_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'work/model-a', input: 'hello' }),
      })
      expect(rejected.status).toBe(403)
      expect(modelAAttempts).toBe(2)

      const healthy = await server.request('/v1/responses/input_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'work/model-b', input: 'hello' }),
      })
      expect(healthy.status).toBe(200)
      expect(modelBAttempts).toBe(1)
    }
    finally {
      refresh.mockRestore()
    }
  })
})

function createRegistry(): AccountRegistry {
  const configuration: AccountsConfiguration = {
    version: 1,
    revision: 1,
    defaultAccount: 'personal',
    requiredRoutes: [],
    accounts: [
      { id: 'personal', accountType: 'individual', githubLogin: 'alice', githubUserId: 1 },
      { id: 'work', accountType: 'enterprise', githubLogin: 'alice-work', githubUserId: 2 },
    ],
    routes: [
      { match: 'claude-opus-4.8', account: 'work' },
      { match: 'gpt-5.4', account: 'work' },
      { match: '*', account: 'personal' },
    ],
  }
  const registry = new AccountRegistry(configuration)
  prepareAccount(registry.get('personal')!, 'personal-copilot-token')
  prepareAccount(registry.get('work')!, 'work-copilot-token')
  return registry
}

function prepareAccount(
  ctx: NonNullable<ReturnType<AccountRegistry['get']>>,
  copilotToken: string,
): void {
  ctx.availability = 'ready'
  ctx.copilotToken = copilotToken
  ctx.vsCodeVersion = '1.0.0'
  ctx.models = models()
}

function models(): ModelsResponse {
  return {
    object: 'list',
    data: [
      makeModel('claude-opus-4.8', ['/v1/messages']),
      makeModel('gpt-5.4', ['/responses']),
    ],
  }
}

function makeModel(id: string, supportedEndpoints: string[]) {
  return {
    id,
    name: id,
    object: 'model',
    model_picker_enabled: true,
    preview: false,
    vendor: 'test',
    version: '1',
    supported_endpoints: supportedEndpoints,
    capabilities: {
      family: 'test',
      object: 'model_capabilities',
      type: 'chat',
    },
  }
}
