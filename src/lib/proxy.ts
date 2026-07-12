import type { Dispatcher } from 'undici'
import process from 'node:process'
import consola from 'consola'
import { getProxyForUrl } from 'proxy-from-env'
import { Agent, ProxyAgent, setGlobalDispatcher } from 'undici'
import {
  DEFAULT_COPILOT_BODY_TIMEOUT_MS,
  DEFAULT_COPILOT_CONNECT_TIMEOUT_MS,
  DEFAULT_COPILOT_HEADERS_TIMEOUT_MS,
} from './http-timeouts'
import { hasProxyEndpointEnvironment, NETWORK_BOOTSTRAPPED_ENV, PROXY_ENV_KEYS } from './proxy-environment'
import { configureCopilotFetchTimeouts } from './upstream-fetch'

export {
  DEFAULT_COPILOT_BODY_TIMEOUT_MS,
  DEFAULT_COPILOT_CONNECT_TIMEOUT_MS,
  DEFAULT_COPILOT_HEADERS_TIMEOUT_MS,
} from './http-timeouts'

export interface HttpClientConfig {
  proxyEnv: boolean
  headersTimeoutMs?: number
  bodyTimeoutMs?: number
  connectTimeoutMs?: number
}

export { PROXY_ENV_KEYS } from './proxy-environment'

export function clearProxyEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of PROXY_ENV_KEYS)
    delete env[key]
}

type UndiciAgentOptions = NonNullable<ConstructorParameters<typeof Agent>[0]>

function isCopilotOrigin(origin: URL): boolean {
  const hostname = origin.hostname.toLowerCase()
  return hostname === 'githubcopilot.com' || hostname.endsWith('.githubcopilot.com')
}

function didConfigureAnyTimeout(config: HttpClientConfig): boolean {
  return config.headersTimeoutMs !== undefined
    || config.bodyTimeoutMs !== undefined
    || config.connectTimeoutMs !== undefined
}

export function resolveUndiciAgentOptions(
  config: HttpClientConfig,
  resolveOptions?: {
    applyCopilotDefaults?: boolean
  },
): UndiciAgentOptions | undefined {
  const agentOptions: UndiciAgentOptions = {}
  const applyCopilotDefaults = resolveOptions?.applyCopilotDefaults ?? true
  const headersTimeoutMs = config.headersTimeoutMs
    ?? (applyCopilotDefaults ? DEFAULT_COPILOT_HEADERS_TIMEOUT_MS : undefined)
  const bodyTimeoutMs = config.bodyTimeoutMs
    ?? (applyCopilotDefaults ? DEFAULT_COPILOT_BODY_TIMEOUT_MS : undefined)
  const connectTimeoutMs = config.connectTimeoutMs
    ?? (applyCopilotDefaults ? DEFAULT_COPILOT_CONNECT_TIMEOUT_MS : undefined)

  if (headersTimeoutMs !== undefined) {
    agentOptions.headersTimeout = headersTimeoutMs
  }

  if (bodyTimeoutMs !== undefined) {
    agentOptions.bodyTimeout = bodyTimeoutMs
  }

  if (connectTimeoutMs !== undefined) {
    agentOptions.connectTimeout = connectTimeoutMs
  }

  return Object.keys(agentOptions).length > 0 ? agentOptions : undefined
}

function areAgentOptionsEqual(
  left: UndiciAgentOptions | undefined,
  right: UndiciAgentOptions | undefined,
): boolean {
  return left?.headersTimeout === right?.headersTimeout
    && left?.bodyTimeout === right?.bodyTimeout
    && left?.connectTimeout === right?.connectTimeout
}

function toOriginUrl(origin: Dispatcher.DispatchOptions['origin']): URL | undefined {
  try {
    return typeof origin === 'string' ? new URL(origin) : (origin as URL)
  }
  catch {
    return undefined
  }
}

function formatTimeout(timeoutMs: number | undefined, configuredTimeoutMs: number | undefined): string {
  if (timeoutMs === undefined) {
    return 'node-default'
  }

  if (timeoutMs === 0) {
    return 'disabled'
  }

  if (configuredTimeoutMs !== undefined) {
    return `${timeoutMs}ms`
  }

  return `${timeoutMs}ms (default)`
}

export function throwProxyDispatchError(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error))
}

export function initializeNodeHttpClient(config: HttpClientConfig): void {
  configureCopilotFetchTimeouts({
    headersTimeoutMs: config.headersTimeoutMs,
    bodyTimeoutMs: config.bodyTimeoutMs,
    connectTimeoutMs: config.connectTimeoutMs,
    proxyEnv: config.proxyEnv,
  })

  if (typeof Bun !== 'undefined') {
    // Bun's native fetch implicitly reads HTTP(S)_PROXY. Explicitly remove all
    // proxy variables when --proxy-env is off so the default cannot leak
    // upstream prompts or bearer tokens through an ambient proxy.
    if (!config.proxyEnv && hasProxyEndpointEnvironment(process.env)
      && process.env[NETWORK_BOOTSTRAPPED_ENV] !== '1') {
      throw new Error('Bun started with an ambient proxy while --proxy-env is disabled. Start through the copilot-proxy CLI so it can sanitize the network environment before serving requests.')
    }

    if (!config.proxyEnv) {
      clearProxyEnvironment(process.env)
      consola.debug('HTTP proxy environment disabled for Bun fetch')
    }
    else {
      consola.debug('HTTP proxy configured from environment for Bun fetch')
    }
    // Bun already snapshotted its startup proxy configuration. Remove proxy
    // credentials from the long-running JS environment after configuration;
    // fetch continues using the approved snapshot.
    clearProxyEnvironment(process.env)
    consola.debug('Configured Bun upstream timeout enforcement')
    return
  }

  try {
    // Under Node we always install a dispatcher so githubcopilot.com can use
    // longer built-in timeouts even when the user did not pass explicit flags.
    const defaultAgentOptions = resolveUndiciAgentOptions(config, { applyCopilotDefaults: false })
    const copilotAgentOptions = resolveUndiciAgentOptions(config)
    const useDistinctCopilotAgent = !areAgentOptionsEqual(defaultAgentOptions, copilotAgentOptions)
    const defaultDirectAgent = new Agent(defaultAgentOptions)
    const copilotDirectAgent = useDistinctCopilotAgent
      ? new Agent(copilotAgentOptions)
      : defaultDirectAgent
    const defaultProxyAgents = new Map<string, ProxyAgent>()
    const copilotProxyAgents = useDistinctCopilotAgent
      ? new Map<string, ProxyAgent>()
      : defaultProxyAgents

    function getOrCreateProxyAgent(
      cache: Map<string, ProxyAgent>,
      proxyUrl: string,
      agentOptions: UndiciAgentOptions | undefined,
    ): ProxyAgent {
      let agent = cache.get(proxyUrl)
      if (!agent) {
        agent = new ProxyAgent({
          uri: proxyUrl,
          ...(agentOptions ?? {}),
        })
        cache.set(proxyUrl, agent)
      }
      return agent
    }

    function getManagedAgents(): Array<Agent | ProxyAgent> {
      const agents = new Set<Agent | ProxyAgent>([
        defaultDirectAgent,
        copilotDirectAgent,
      ])

      for (const proxyAgent of defaultProxyAgents.values()) {
        agents.add(proxyAgent)
      }

      for (const proxyAgent of copilotProxyAgents.values()) {
        agents.add(proxyAgent)
      }

      return Array.from(agents)
    }

    // We only need a minimal dispatcher that implements `dispatch` at runtime.
    // Typing the object as `Dispatcher` forces TypeScript to require many
    // additional methods. Instead, keep a plain object and cast when passing
    // to `setGlobalDispatcher`.
    const dispatcher = {
      dispatch(
        options: Dispatcher.DispatchOptions,
        handler: Dispatcher.DispatchHandler,
      ) {
        const origin = toOriginUrl(options.origin)
        const useCopilotAgent = origin ? isCopilotOrigin(origin) : false
        const directAgent = useCopilotAgent ? copilotDirectAgent : defaultDirectAgent
        const proxyAgentCache = useCopilotAgent ? copilotProxyAgents : defaultProxyAgents
        const agentOptions = useCopilotAgent ? copilotAgentOptions : defaultAgentOptions

        if (!config.proxyEnv) {
          return (directAgent as unknown as Dispatcher).dispatch(options, handler)
        }

        try {
          const get = getProxyForUrl as unknown as (
            u: string,
          ) => string | undefined
          const raw = origin ? get(origin.toString()) : undefined
          const proxyUrl = raw && raw.length > 0 ? raw : undefined
          if (!proxyUrl) {
            const target = origin?.toString() ?? 'the requested upstream origin'
            throw new Error(`--proxy-env requires a proxy route for ${target}; refusing a direct connection.`)
          }
          const agent = getOrCreateProxyAgent(proxyAgentCache, proxyUrl, agentOptions)
          let label = proxyUrl
          try {
            const u = new URL(proxyUrl)
            label = `${u.protocol}//${u.host}`
          }
          catch {
            /* noop */
          }
          if (origin) {
            consola.debug(`HTTP proxy route: ${origin.hostname} via ${label}`)
          }
          return (agent as unknown as Dispatcher).dispatch(options, handler)
        }
        catch (error) {
          // --proxy-env is an explicit egress policy. If proxy resolution or
          // ProxyAgent construction fails, silently going direct can disclose
          // prompts and bearer tokens outside the required network path.
          throwProxyDispatchError(error)
        }
      },
      async close() {
        await Promise.allSettled(
          getManagedAgents().map(agent => agent.close()),
        )
      },
      async destroy(error?: Error) {
        const destroyError = error ?? null
        await Promise.allSettled(
          getManagedAgents().map(agent => agent.destroy(destroyError)),
        )
      },
    }

    setGlobalDispatcher(dispatcher as unknown as Dispatcher)
    if (copilotAgentOptions) {
      consola.info(
        `Configured Copilot upstream HTTP timeouts: headers=${formatTimeout(copilotAgentOptions.headersTimeout, config.headersTimeoutMs)}, body=${formatTimeout(copilotAgentOptions.bodyTimeout, config.bodyTimeoutMs)}, connect=${formatTimeout(copilotAgentOptions.connectTimeout, config.connectTimeoutMs)}`,
      )
    }
    if (!didConfigureAnyTimeout(config)) {
      consola.info('Using built-in longer HTTP timeouts for githubcopilot.com upstreams')
    }
    if (config.proxyEnv) {
      consola.debug('HTTP proxy configured from environment (per-URL)')
    }
  }
  catch (err) {
    consola.debug('HTTP client setup skipped:', err)
  }
}
