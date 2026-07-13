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
const STARTUP_TLS_ENV_KEYS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const

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
      process.env.COPILOT_PROXY_DATA_DIR = path.resolve(value)
      return
    }
  }
}

// Native services may start without the shell's XDG/LOCALAPPDATA overrides.
// Apply the non-secret data directory before importing modules that bind PATHS.
applyInternalDataDirArgument(process.argv.slice(2))
const controlStateResult = applyInstalledNativeServiceDataDir(process.argv.slice(2))
if (controlStateResult.ignoredInvalidStatePath) {
  process.env.COPILOT_PROXY_INVALID_NATIVE_SERVICE_CONTROL_STATE = '1'
  process.stderr.write(
    `Warning: native service control state is invalid at ${controlStateResult.ignoredInvalidStatePath}; continuing with disable so the broken registration can be removed.\n`,
  )
}

async function restartWithSanitizedNetworkEnvironmentIfNeeded(args: string[]): Promise<number | undefined> {
  if (!shouldRestartWithSanitizedNetworkEnvironment(args, process.env, typeof Bun !== 'undefined'))
    return undefined

  const env = args.includes('--_service')
    ? await loadNativeServiceProxyEnvironmentForBootstrap(process.env, args.includes('--proxy-env'))
    : withoutProxyEnvironment(process.env)
  for (const key of PROXY_ENV_KEYS)
    delete process.env[key]
  if (args.includes('--_service')) {
    for (const key of STARTUP_TLS_ENV_KEYS)
      delete process.env[key]
  }
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

async function loadNativeServiceProxyEnvironmentForBootstrap(
  sourceEnv: NodeJS.ProcessEnv,
  proxyEnv: boolean,
): Promise<NodeJS.ProcessEnv> {
  const dataDir = sourceEnv.COPILOT_PROXY_DATA_DIR
  if (!dataDir)
    throw new Error('Native service is missing its persisted --_data-dir argument.')

  const filePath = path.join(dataDir, 'service-env.json')
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Object.values(parsed).every(value => typeof value === 'string')) {
    throw new Error(`Native service environment file is invalid: ${filePath}`)
  }

  const saved = parsed as Record<string, string>
  const { buildNativeServiceBootstrapEnvironment } = await import('./daemon/service-env')
  return buildNativeServiceBootstrapEnvironment(sourceEnv, saved, {
    proxyEnv,
  })
}

async function persistGithubTokenArgumentIfNeeded(args: string[]): Promise<number | undefined> {
  const { removeGithubTokenArguments } = await import('./daemon/github-token-argv')
  const sanitized = removeGithubTokenArguments(args)
  if (sanitized.token === undefined)
    return undefined

  const token = sanitized.token.trim()
  if (!token)
    throw new Error('--github-token must not be empty')

  const [{ writeOwnerOnlyFileAtomically }, { PATHS }] = await Promise.all([
    import('./daemon/atomic-file'),
    import('./lib/paths'),
  ])
  writeOwnerOnlyFileAtomically(PATHS.GITHUB_TOKEN_PATH, token)

  // A child can replace or scrub only its own argv. Package runners such as
  // `bun run`, npm, npx, and shell launchers may retain the original secret in
  // a parent command line for as long as the child runs. Persist and exit
  // promptly on every platform; a second start without the flag is the only
  // portable way to guarantee no long-lived process keeps the token argument.
  if (args[0] === 'auth') {
    process.stderr.write('GitHub token saved securely.\n')
    return 0
  }

  process.stderr.write(
    'GitHub token saved securely. Rerun `copilot-proxy start` without --github-token so no long-lived launcher process retains the secret in argv.\n',
  )
  return 1
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
  const tokenBootstrapExitCode = await persistGithubTokenArgumentIfNeeded(args)
  if (tokenBootstrapExitCode !== undefined) {
    process.exitCode = tokenBootstrapExitCode
    return
  }

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
