import type { Model } from '~/services/copilot/get-models'

import process from 'node:process'

import { state } from '~/lib/state'
import { getCopilotTokenLifecycleStatus, refreshTokenWithRetry, stopCopilotTokenRefresh } from '~/lib/token'
import { getCopilotRecoveryStatus, resetCopilotRecoveryStateForTests } from '~/services/copilot/authenticated-fetch'
import { runDisposableSetupProbe } from '~/setup'

const scenario = process.env.SETUP_RECOVERY_SCENARIO === 'backoff'
  ? 'backoff'
  : process.env.SETUP_RECOVERY_SCENARIO === 'scheduled'
    ? 'scheduled'
    : 'in-flight'

const model: Model = {
  id: 'gpt-setup-recovery',
  name: 'gpt-setup-recovery',
  vendor: 'OpenAI',
  version: '1',
  object: 'model',
  preview: false,
  model_picker_enabled: true,
  supported_endpoints: ['/responses'],
  capabilities: {
    family: 'gpt-setup-recovery',
    limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
    object: 'model_capabilities',
    supports: { tool_calls: true },
    tokenizer: 'o200k_base',
    type: 'chat',
  },
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  state.accountType = 'individual'
  state.concurrencyLimiter = undefined
  state.copilotToken = 'expired-setup-token'
  state.githubToken = 'setup-github-token'
  state.lastRequestTimestamp = undefined
  state.manualApprove = false
  state.models = { data: [model], object: 'list' }
  state.rateLimitSeconds = undefined
  state.rateLimitWait = false
  state.vsCodeVersion = '1.0.0'
  resetCopilotRecoveryStateForTests()

  const originalFetch = globalThis.fetch
  let copilotAttempts = 0
  let tokenAttempts = 0
  let tokenCompleted = false
  let tokenSignal: AbortSignal | undefined
  let markTokenStarted!: () => void
  const tokenStarted = new Promise<void>((resolve) => {
    markTokenStarted = resolve
  })

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.pathname === '/copilot_internal/v2/token') {
      tokenAttempts++
      tokenSignal = init?.signal ?? undefined
      markTokenStarted()
      if (scenario === 'backoff')
        throw new Error('synthetic transient token endpoint failure before retry backoff')
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => {
          tokenCompleted = true
          resolve(Response.json({
            expires_at: Math.floor(Date.now() / 1_000) + 3_600,
            refresh_in: 3_600,
            token: 'refreshed-setup-token',
          }))
        }, 3_000)
        const onAbort = () => {
          clearTimeout(timer)
          const reason = tokenSignal?.reason
          reject(reason instanceof Error ? reason : new Error('setup token refresh cancelled'))
        }
        tokenSignal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (url.pathname === '/responses') {
      copilotAttempts++
      return new Response('Unauthorized', { status: 401 })
    }
    throw new Error(`Unexpected setup recovery URL: ${url.toString()}`)
  }) as typeof fetch

  if (scenario === 'scheduled') {
    void refreshTokenWithRetry()
    await tokenStarted
  }

  const startedAt = performance.now()
  try {
    let setupError: unknown
    try {
      await runDisposableSetupProbe({
        choice: {
          api: 'responses',
          model,
          supportsWebSockets: false,
        },
        client: 'codex',
        host: '127.0.0.1',
        port: 0,
        timeoutMs: 100,
      })
    }
    catch (error) {
      setupError = error
    }
    const setupElapsedMs = performance.now() - startedAt

    await tokenStarted
    const lifecycle = getCopilotTokenLifecycleStatus()
    const recovery = getCopilotRecoveryStatus()

    assert(
      setupError instanceof Error && setupError.message === 'Direct setup probe timed out after 100ms.',
      `Unexpected setup result: ${String(setupError)}`,
    )
    assert(setupElapsedMs < 750, `Setup waited ${setupElapsedMs.toFixed(0)}ms for the shared refresh`)
    assert(!tokenCompleted, 'Disposable setup token refresh completed instead of being cancelled')
    assert(tokenSignal?.aborted === true, 'Disposable setup did not cancel its token refresh')
    assert(!lifecycle.reactiveRefreshInFlight, 'Disposable setup left a reactive token refresh in flight')
    assert(lifecycle.consecutiveRefreshFailures === 0, 'Expected setup cancellation counted as a token refresh failure')
    assert(lifecycle.lastReactiveRefreshOutcome === 'cancelled', `Unexpected reactive refresh outcome: ${String(lifecycle.lastReactiveRefreshOutcome)}`)
    assert(recovery.metrics.reactiveRefreshFailures === 0, 'Expected setup cancellation counted as an authentication recovery failure')
    assert(copilotAttempts === 1, `Cancelled setup caller made ${copilotAttempts} Copilot attempts`)
    assert(tokenAttempts === 1, `Cancelled setup refresh made ${tokenAttempts} token endpoint attempts`)

    process.stdout.write(`SETUP_RECOVERY_DEADLINE_RESULT=${JSON.stringify({
      copilotAttempts,
      consecutiveRefreshFailures: lifecycle.consecutiveRefreshFailures,
      lastReactiveRefreshOutcome: lifecycle.lastReactiveRefreshOutcome,
      reactiveRefreshInFlight: lifecycle.reactiveRefreshInFlight,
      reactiveRefreshFailures: recovery.metrics.reactiveRefreshFailures,
      scenario,
      setupElapsedMs,
      tokenAttempts,
      tokenCompleted,
      tokenSignalAborted: tokenSignal?.aborted ?? null,
    })}\n`)
  }
  finally {
    globalThis.fetch = originalFetch
    stopCopilotTokenRefresh()
    resetCopilotRecoveryStateForTests()
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(message)
}
