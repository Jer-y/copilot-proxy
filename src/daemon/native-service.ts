import type { DaemonConfig } from '~/daemon/config'

import http from 'node:http'
import { isIP } from 'node:net'
import process from 'node:process'

import { ALLOWED_HOSTS_ENV, isLoopbackHostname, parseAllowedHosts } from '~/lib/security'

export interface NativeServiceLogOptions {
  follow: boolean
  lines: number
}

export interface NativeServiceActivationState {
  installed: boolean
  enabled: boolean
  loaded?: boolean
  running: boolean
}

export interface NativeServiceCommands {
  captureAutoStartState: () => NativeServiceActivationState
  isAutoStartInstalled: () => boolean
  restoreAutoStartState: (state: NativeServiceActivationState) => boolean
  stopAutoStartService: () => boolean
  restartAutoStartService: () => boolean
  showAutoStartStatus: () => boolean
  showAutoStartLogs: (options: NativeServiceLogOptions) => boolean
}

export interface NativeServiceReadinessOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  requiredReadyChecks?: number
  probe?: () => boolean | Promise<boolean>
  delay?: (milliseconds: number) => Promise<void>
  now?: () => number
  expectedInstanceToken?: string
  requestHost?: string
}

export const NATIVE_SERVICE_INSTANCE_HEADER = 'x-copilot-proxy-instance-token'

export async function waitForNativeServiceReadiness(
  config: Pick<DaemonConfig, 'host' | 'port'>,
  options: NativeServiceReadinessOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 100
  const requiredReadyChecks = options.requiredReadyChecks ?? 2
  const now = options.now ?? Date.now
  const delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  const probe = options.probe ?? (() => probeCopilotProxyServer(
    config.host,
    config.port,
    options.expectedInstanceToken,
    options.requestHost,
  ))
  const deadline = now() + timeoutMs
  let consecutiveReadyChecks = 0

  while (now() < deadline) {
    if (await probe()) {
      consecutiveReadyChecks++
      if (consecutiveReadyChecks >= requiredReadyChecks)
        return true
    }
    else {
      consecutiveReadyChecks = 0
    }
    await delay(pollIntervalMs)
  }

  return false
}

export async function probeCopilotProxyServer(
  host: string,
  port: number,
  expectedInstanceToken?: string,
  requestHost: string = 'localhost',
): Promise<boolean> {
  const hostname = readinessProbeHostname(host)
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled)
        return
      settled = true
      resolve(ready)
    }

    const request = http.get({
      hostname,
      port,
      path: '/',
      headers: { Host: readinessProbeHostHeader(requestHost, port) },
      timeout: 1_500,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
        if (body.length > 64) {
          request.destroy()
          finish(false)
        }
      })
      response.once('end', () => {
        const instanceMatches = expectedInstanceToken === undefined
          || response.headers[NATIVE_SERVICE_INSTANCE_HEADER] === expectedInstanceToken
        finish(response.statusCode === 200 && body.trim() === 'Server running' && instanceMatches)
      })
      response.once('error', () => finish(false))
    })
    request.once('timeout', () => request.destroy(new Error('readiness probe timed out')))
    request.once('error', () => finish(false))
  })
}

export function resolveNativeServiceReadinessHost(
  bindHost: string,
  environment: NodeJS.ProcessEnv | Record<string, string>,
): string | undefined {
  if (isLoopbackHostname(bindHost))
    return 'localhost'

  const allowedHosts = parseAllowedHosts(environment[ALLOWED_HOSTS_ENV])
  return allowedHosts
    ? [...allowedHosts].find(hostname => !isLoopbackHostname(hostname))
    : undefined
}

export function readinessProbeHostHeader(host: string, port: number): string {
  const normalized = host.trim().replace(/^\[|\]$/g, '')
  return isIP(normalized) === 6
    ? `[${normalized}]:${port}`
    : `${normalized}:${port}`
}

export function readinessProbeHostname(host: string): string {
  const normalized = host.trim().replace(/^\[|\]$/g, '')
  if (normalized === '0.0.0.0')
    return '127.0.0.1'
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0')
    return '::1'
  return normalized
}

export async function loadNativeServiceCommands(): Promise<NativeServiceCommands | null> {
  if (process.platform === 'linux')
    return import('~/daemon/platform/linux')
  if (process.platform === 'darwin')
    return import('~/daemon/platform/darwin')
  if (process.platform === 'win32')
    return import('~/daemon/platform/win32')

  return null
}

export async function loadInstalledNativeServiceCommands(): Promise<NativeServiceCommands | null> {
  const commands = await loadNativeServiceCommands()
  if (!commands || !commands.isAutoStartInstalled())
    return null

  return commands
}
