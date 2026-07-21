import type { Context } from 'hono'

export interface CopilotProxyBindings {
  setupProbeSignal?: AbortSignal
}

export interface CopilotProxyEnv {
  Bindings: CopilotProxyBindings
}

/**
 * Returns the internal lifecycle signal attached by the disposable setup
 * server. Normal HTTP requests have no binding, so their inbound request
 * signal remains isolated from Copilot upstream work.
 */
export function getSetupProbeSignal(c: Context): AbortSignal | undefined {
  const signal = (c.env as CopilotProxyBindings | undefined)?.setupProbeSignal
  return signal instanceof AbortSignal ? signal : undefined
}
