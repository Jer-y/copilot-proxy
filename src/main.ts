#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { applyInstalledNativeServiceDataDir } from './daemon/service-install-state'
import {
  NETWORK_BOOTSTRAPPED_ENV,
  PROXY_ENV_KEYS,
  shouldRestartWithSanitizedNetworkEnvironment,
  withoutProxyEnvironment,
} from './lib/proxy-environment'
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from './lib/runtime-version'

const INTERNAL_DATA_DIR_FLAG = '--_data-dir'

function applyInternalDataDirArgument(args: string[]): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--')
      break

    const value = arg === INTERNAL_DATA_DIR_FLAG
      ? args[index + 1]
      : arg.startsWith(`${INTERNAL_DATA_DIR_FLAG}=`)
        ? arg.slice(INTERNAL_DATA_DIR_FLAG.length + 1)
        : undefined

    if (value) {
      process.env.COPILOT_PROXY_DATA_DIR = value
      return
    }
  }
}

// Native services may start without the shell's XDG/LOCALAPPDATA overrides.
// Apply the non-secret data directory before importing modules that bind PATHS.
applyInternalDataDirArgument(process.argv.slice(2))
applyInstalledNativeServiceDataDir(process.argv.slice(2))

async function restartWithSanitizedNetworkEnvironmentIfNeeded(args: string[]): Promise<number | undefined> {
  if (!shouldRestartWithSanitizedNetworkEnvironment(args, process.env, typeof Bun !== 'undefined'))
    return undefined

  const env = args.includes('--_service')
    ? loadNativeServiceProxyEnvironmentForBootstrap(process.env)
    : withoutProxyEnvironment(process.env)
  for (const key of PROXY_ENV_KEYS)
    delete process.env[key]
  env[NETWORK_BOOTSTRAPPED_ENV] = '1'
  const child = spawn(process.execPath, process.argv.slice(1), {
    env,
    stdio: 'inherit',
  })

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal)
  }
  const onSigterm = () => forwardSignal('SIGTERM')
  const onSigint = () => forwardSignal('SIGINT')
  process.on('SIGTERM', onSigterm)
  process.on('SIGINT', onSigint)

  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        resolve(code ?? (signal ? 1 : 0))
      })
    })
  }
  finally {
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('SIGINT', onSigint)
  }
}

function loadNativeServiceProxyEnvironmentForBootstrap(
  sourceEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const dataDir = sourceEnv.COPILOT_PROXY_DATA_DIR
  if (!dataDir)
    throw new Error('Native service is missing its persisted --_data-dir argument.')

  const filePath = path.join(dataDir, 'service-env.json')
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Object.values(parsed).every(value => typeof value === 'string')) {
    throw new Error(`Native service environment file is invalid: ${filePath}`)
  }

  const env = withoutProxyEnvironment(sourceEnv)
  const saved = parsed as Record<string, string>
  for (const key of [...PROXY_ENV_KEYS, 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const) {
    if (saved[key] !== undefined)
      env[key] = saved[key]
  }
  return env
}

if (typeof Bun === 'undefined' && !isSupportedNodeVersion(process.versions.node)) {
  process.stderr.write(
    `copilot-proxy requires Node.js >= ${MINIMUM_NODE_VERSION}; current runtime is ${process.versions.node}. Install a supported Node.js version or run the CLI with Bun.\n`,
  )
  process.exit(1)
}

// Keep application modules behind the runtime guard. Some dependencies use
// Node APIs introduced in 22.19, so static imports would crash older Node
// versions before the CLI could print an actionable compatibility error.
async function run(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--_log-file')) {
    const { installRotatingProcessLog } = await import('./daemon/log-file')
    installRotatingProcessLog()
  }

  const bootstrapExitCode = await restartWithSanitizedNetworkEnvironmentIfNeeded(args)
  if (bootstrapExitCode !== undefined) {
    process.exitCode = bootstrapExitCode
    return
  }

  const [
    { defineCommand, runMain },
    { auth },
    { checkUsage },
    { disable },
    { enable },
    { logs },
    { restart },
    { status },
    { stop },
    { debug },
    { start },
  ] = await Promise.all([
    import('citty'),
    import('./auth'),
    import('./check-usage'),
    import('./daemon/disable'),
    import('./daemon/enable'),
    import('./daemon/logs'),
    import('./daemon/restart'),
    import('./daemon/status'),
    import('./daemon/stop'),
    import('./debug'),
    import('./start'),
  ])

  const main = defineCommand({
    meta: {
      name: 'copilot-proxy',
      description:
        'A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.',
    },
    subCommands: { auth, start, 'check-usage': checkUsage, debug, stop, status, logs, restart, enable, disable },
  })

  await runMain(main)
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
