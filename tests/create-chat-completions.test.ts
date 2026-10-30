import type { ChatCompletionsPayload } from '../src/services/copilot/create-chat-completions'

import { expect, mock, test } from 'bun:test'

import { createAccountContext } from '~/lib/account/context'
import { state } from '../src/lib/state'
import { createChatCompletions } from '../src/services/copilot/create-chat-completions'
import { makeModel } from './model-fixtures'

// Mock state
state.defaultAccount.copilotToken = 'test-token'
state.defaultAccount.vsCodeVersion = '1.0.0'
state.defaultAccount.accountType = 'individual'

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, _opts: { headers: Record<string, string> }) => {
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () => JSON.stringify({ id: '123', object: 'chat.completion', model: 'gpt-test', choices: [] }),
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test('sets X-Initiator to agent if tool/assistant present', async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'tool call' },
    ],
    model: 'gpt-test',
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers['X-Initiator']).toBe('agent')
})

test('sets X-Initiator to user if only user present', async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'hello again' },
    ],
    model: 'gpt-test',
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers['X-Initiator']).toBe('user')
})

test('uses the fetched Gemini profile only for its selected account and clears it on a new snapshot', async () => {
  const originalModels = state.defaultAccount.models
  const gemini = { ...makeModel('google-live-model', ['/chat/completions']), vendor: 'Google' }
  try {
    state.defaultAccount.models = { object: 'list', data: [gemini], vscodeChatModelIds: [gemini.id] }
    await createChatCompletions({ model: gemini.id, messages: [{ role: 'user', content: 'hello' }] })
    let request = fetchMock.mock.calls.at(-1)![1]
    expect(new Headers(request.headers).get('user-agent')).toBe('GitHubCopilotChat/0.26.7')
    expect(new Headers(request.headers).get('copilot-integration-id')).toBe('vscode-chat')

    const otherAccount = createAccountContext({ id: 'other' })
    otherAccount.copilotToken = 'other-token'
    otherAccount.models = { object: 'list', data: [gemini] }
    await createChatCompletions({ model: gemini.id, messages: [{ role: 'user', content: 'hello' }] }, { ctx: otherAccount })
    request = fetchMock.mock.calls.at(-1)![1]
    expect(new Headers(request.headers).get('user-agent')).toBe('vscode_codex/0.162.1')
    expect(new Headers(request.headers).get('authorization')).toBe('Bearer other-token')

    state.defaultAccount.models = { object: 'list', data: [gemini] }
    await createChatCompletions({ model: gemini.id, messages: [{ role: 'user', content: 'hello' }] })
    request = fetchMock.mock.calls.at(-1)![1]
    expect(new Headers(request.headers).get('user-agent')).toBe('vscode_codex/0.162.1')
    expect(new Headers(request.headers).has('copilot-integration-id')).toBe(false)
  }
  finally {
    state.defaultAccount.models = originalModels
  }
})
