import type { SetupModelChoice } from '~/lib/client-setup'
import type { ChatCompletionsPayload } from '~/services/copilot/create-chat-completions'
import type { Model } from '~/services/copilot/get-models'

import { createServer } from 'node:http'
import process from 'node:process'

import { state } from '~/lib/state'
import { getTokenCount } from '~/lib/tokenizer'
import { runDisposableSetupProbe } from '~/setup'

interface SetupDeadlineEvidence {
  api: SetupModelChoice['api']
  elapsedMs: number
  upstreamPath: string
  upstreamSignalAborted: boolean
}

function model(id: string, endpoints: string[]): Model {
  return {
    id,
    name: id,
    vendor: id.startsWith('claude') ? 'Anthropic' : 'OpenAI',
    version: '1',
    object: 'model',
    preview: false,
    model_picker_enabled: true,
    supported_endpoints: endpoints,
    capabilities: {
      family: id,
      limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
      object: 'model_capabilities',
      supports: { tool_calls: true },
      tokenizer: 'o200k_base',
      type: 'chat',
    },
  }
}

const models = [
  model('gpt-setup', ['/responses', 'ws:/responses']),
  model('gpt-chat-setup', ['/chat/completions']),
  model('claude-setup', ['/v1/messages']),
]

const cases: Array<{
  choice: SetupModelChoice
  expectedUpstreamPath: string
}> = [
  {
    choice: {
      api: 'responses',
      model: models[0]!,
      supportsWebSockets: true,
    },
    expectedUpstreamPath: '/responses',
  },
  {
    choice: {
      api: 'chat-completions',
      model: models[1]!,
      supportsWebSockets: false,
    },
    expectedUpstreamPath: '/chat/completions',
  },
  {
    choice: {
      api: 'anthropic-messages',
      model: models[2]!,
      supportsWebSockets: false,
    },
    expectedUpstreamPath: '/v1/messages',
  },
]

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  state.accountType = 'individual'
  state.concurrencyLimiter = undefined
  state.copilotToken = 'setup-test-token'
  state.lastRequestTimestamp = undefined
  state.manualApprove = false
  state.models = { data: models, object: 'list' }
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.vsCodeVersion = '1.0.0'

  // The chat route performs token accounting before it opens the upstream
  // request. Load the real encoder before the per-probe deadline starts so
  // this fixture measures request timeout and abort behavior, not cold module
  // loading in a newly spawned Bun process.
  const chatModel = models[1]!
  const chatPayload = {
    model: chatModel.id,
    messages: [{
      role: 'user',
      content: 'Reply with exactly COPILOT_PROXY_SETUP_OK.',
    }],
  } satisfies ChatCompletionsPayload
  await getTokenCount(chatPayload, chatModel)

  const evidence: SetupDeadlineEvidence[] = []
  for (const testCase of cases)
    evidence.push(await runHangingUpstreamCase(testCase))

  process.stdout.write(`SETUP_HANGING_PROBE_RESULT=${JSON.stringify(evidence)}\n`)
}

async function runHangingUpstreamCase(testCase: typeof cases[number]): Promise<SetupDeadlineEvidence> {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  let upstreamPath: string | undefined
  let upstreamSignal: AbortSignal | undefined
  const upstreamServer = createServer((request) => {
    upstreamPath = request.url
    request.resume()
  })
  await new Promise<void>((resolve, reject) => {
    upstreamServer.once('error', reject)
    upstreamServer.listen(0, '127.0.0.1', resolve)
  })
  const upstreamAddress = upstreamServer.address()
  if (!upstreamAddress || typeof upstreamAddress === 'string')
    throw new Error('Expected a TCP address for the hanging upstream')

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    fetchCalls++
    const originalUrl = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    upstreamSignal = init?.signal ?? undefined
    return await originalFetch(`http://127.0.0.1:${upstreamAddress.port}${originalUrl.pathname}`, init)
  }) as typeof fetch

  const startedAt = performance.now()
  try {
    let setupError: unknown
    try {
      await runDisposableSetupProbe({
        choice: testCase.choice,
        client: testCase.choice.api === 'anthropic-messages' ? 'claude' : 'openai-sdk',
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 1_000,
      })
    }
    catch (error) {
      setupError = error
    }

    const elapsedMs = performance.now() - startedAt
    assert(
      setupError instanceof Error && setupError.message === 'Direct setup probe timed out after 1000ms.',
      `Unexpected ${testCase.choice.api} setup result: ${String(setupError)}`,
    )
    assert(upstreamPath === testCase.expectedUpstreamPath, `Expected ${testCase.expectedUpstreamPath}, received ${String(upstreamPath)}`)
    assert(upstreamSignal?.aborted === true, `${testCase.choice.api} upstream signal was not aborted`)
    assert(fetchCalls === 1, `${testCase.choice.api} made ${fetchCalls} upstream requests`)
    assert(elapsedMs < 3_000, `${testCase.choice.api} setup cleanup took ${elapsedMs.toFixed(0)}ms`)

    return {
      api: testCase.choice.api,
      elapsedMs,
      upstreamPath,
      upstreamSignalAborted: true,
    }
  }
  finally {
    globalThis.fetch = originalFetch
    upstreamServer.closeAllConnections()
    await new Promise<void>((resolve) => {
      upstreamServer.close(() => resolve())
    })
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(message)
}
