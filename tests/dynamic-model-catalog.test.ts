import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { createAccountContext } from '~/lib/account/context'
import { setDefaultAccountContext, state } from '~/lib/state'
import { cacheModels, refreshModelsSafely } from '~/lib/utils'
import { server } from '~/server'
import { makeModel } from './model-fixtures'

const originalFetch = globalThis.fetch
const originalAccounts = state.accounts
const originalDefault = state.defaultAccount
const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
  if (!String(input).endsWith('/responses'))
    throw new Error(`Unexpected upstream request: ${String(input)}`)
  return Response.json({ id: 'resp_dynamic', object: 'response', model: 'future-native', output: [], status: 'completed' })
})

beforeEach(() => {
  state.accounts = undefined
  const ctx = createAccountContext({ id: 'default', accountType: 'individual' })
  ctx.copilotToken = 'test-token'
  ctx.vsCodeVersion = '1.0.0'
  setDefaultAccountContext(ctx)
  state.lastRequestTimestamp = undefined
  fetchMock.mockClear()
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  state.accounts = originalAccounts
  setDefaultAccountContext(originalDefault)
  globalThis.fetch = originalFetch
})

async function post(path: string, payload: unknown): Promise<Response> {
  return server.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

describe('dynamic model catalog request boundary', () => {
  test('missing startup catalogs fail without triggering lazy fetches or inference', async () => {
    const cases = [
      ['/v1/responses', { model: 'gpt-5.4', input: 'hello' }],
      ['/v1/messages', { model: 'claude-opus-4.8', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32 }],
      ['/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] }],
      ['/v1/messages/count_tokens', { model: 'claude-opus-4.8', messages: [{ role: 'user', content: 'hello' }] }],
      ['/v1/responses/input_tokens', { model: 'gpt-5.4', input: 'hello' }],
      ['/v1/responses/compact', { model: 'gpt-5.4', input: 'hello' }],
      ['/v1/embeddings', { model: 'text-embedding-3-small', input: 'hello' }],
    ] as const
    for (const [path, payload] of cases) {
      const response = await post(path, payload)
      expect(response.status).toBe(503)
      const body = await response.json() as { error: { type: string } }
      expect(body.error.type).toBe('api_error')
    }
    const models = await server.request('/v1/models')
    expect(models.status).toBe(503)
    expect(await models.json()).toMatchObject({ error: { code: 'model_catalog_unavailable' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('requests reuse the fetched snapshot and observe model removals on refresh', async () => {
    const snapshot = { object: 'list', data: [makeModel('future-native', ['/responses'])] }
    const load = mock(async () => snapshot)
    await cacheModels(load)
    for (let turn = 0; turn < 2; turn++)
      expect((await post('/v1/responses', { model: 'future-native', input: 'hello' })).status).toBe(200)
    expect(load).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(await (await server.request('/v1/models')).json()).toMatchObject({ data: [{ id: 'future-native' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await refreshModelsSafely(async () => ({ object: 'list', data: [] }))
    expect((await post('/v1/responses', { model: 'future-native', input: 'hello' })).status).toBe(400)
    expect(await (await server.request('/v1/models')).json()).toMatchObject({ data: [] })
    expect(snapshot.data).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('neither a familiar name nor a listed family grants an undeclared route', async () => {
    await cacheModels(async () => ({ object: 'list', data: [makeModel('gpt-4o'), makeModel('gpt-5.4', ['/responses'])] }))
    expect((await post('/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }] })).status).toBe(400)
    expect((await post('/v1/responses', { model: 'gpt-5.4-fast', input: 'hello' })).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
