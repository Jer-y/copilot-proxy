#!/usr/bin/env node

import type { BootstrapArgumentAnalysis } from './daemon/github-token-argv'

import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

import { analyzeBootstrapArguments } from './daemon/github-token-argv'
import { applyInstalledNativeServiceDataDir } from './daemon/service-install-state'
import {
  NETWORK_BOOTSTRAPPED_ENV,
  PROXY_ENV_KEYS,
  shouldRestartWithSanitizedNetworkEnvironment,
  withoutProxyEnvironment,
} from './lib/proxy-environment'
import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from './lib/runtime-version'

// Native services may start without the shell's XDG/LOCALAPPDATA overrides.
// Analyze with the dependency-free Citty-compatible bootstrap parser and apply
// the non-secret data directory before importing modules that bind PATHS.
const cliArgs = process.argv.slice(2)
const bootstrapArguments = analyzeBootstrapArguments(cliArgs)
if (bootstrapArguments.dataDir)
  process.env.COPILOT_PROXY_DATA_DIR = path.resolve(bootstrapArguments.dataDir)
const controlStateResult = applyInstalledNativeServiceDataDir(cliArgs)
if (controlStateResult.ignoredInvalidStatePath) {
  process.env.COPILOT_PROXY_INVALID_NATIVE_SERVICE_CONTROL_STATE = '1'
  process.stderr.write(
    `Warning: native service control state is invalid at ${controlStateResult.ignoredInvalidStatePath}; continuing with disable so the broken registration can be removed.\n`,
  )
}

async function restartWithSanitizedNetworkEnvironmentIfNeeded(
  args: string[],
  analysis: BootstrapArgumentAnalysis,
): Promise<number | undefined> {
  if (!shouldRestartWithSanitizedNetworkEnvironment(args, process.env, typeof Bun !== 'undefined'))
    return undefined

  const nativeServiceBootstrap = analysis.nativeService
  const env = nativeServiceBootstrap
    ? await loadNativeServiceEnvironmentForBootstrap(process.env, analysis.proxyEnvironment)
    : withoutProxyEnvironment(process.env)
  env[NETWORK_BOOTSTRAPPED_ENV] = '1'
  if (nativeServiceBootstrap) {
    synchronizeProcessEnvironment(env)
  }
  else {
    for (const key of PROXY_ENV_KEYS)
      delete process.env[key]
  }
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

function synchronizeProcessEnvironment(sourceEnv: NodeJS.ProcessEnv): void {
  // The bootstrap parent remains alive to forward signals and return the
  // long-lived service child's exit code. Give it the exact same allowlisted
  // environment before spawning so it cannot retain ambient credentials or
  // stale service security settings while it waits.
  for (const key of Object.keys(process.env))
    delete process.env[key]
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined)
      process.env[key] = value
  }
}

async function loadNativeServiceEnvironmentForBootstrap(
  sourceEnv: NodeJS.ProcessEnv,
  proxyEnv: boolean,
): Promise<NodeJS.ProcessEnv> {
  const dataDir = sourceEnv.COPILOT_PROXY_DATA_DIR
  if (!dataDir)
    throw new Error('Native service is missing its persisted --_data-dir argument.')

  const filePath = path.join(dataDir, 'service-env.json')
  const {
    buildNativeServiceBootstrapEnvironment,
    readNativeServiceEnvironment,
  } = await import('./daemon/service-env')
  const saved = readNativeServiceEnvironment(filePath)
  return buildNativeServiceBootstrapEnvironment(sourceEnv, saved, {
    proxyEnv,
  })
}

async function persistGithubTokenArgumentIfNeeded(
  analysis: BootstrapArgumentAnalysis,
): Promise<number | undefined> {
  // Citty treats an exact --help/-h anywhere in argv as its builtin root-help
  // request, even when a declared string option would otherwise consume it as
  // a value. Help must stay side-effect free and continue into runMain(), which
  // prints the resolved command usage and exits immediately.
  if (analysis.rootHelp || analysis.token === undefined)
    return undefined

  const token = analysis.token.trim()
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
  if (analysis.command === 'auth') {
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
  const args = cliArgs
  if (bootstrapArguments.misplacedGithubToken && !bootstrapArguments.rootHelp) {
    process.stderr.write(
      'Invalid arguments: --github-token was consumed as another option value. Supply that option\'s value before passing --github-token.\n',
    )
    process.exitCode = 1
    return
  }

  const tokenBootstrapExitCode = await persistGithubTokenArgumentIfNeeded(bootstrapArguments)
  if (tokenBootstrapExitCode !== undefined) {
    process.exitCode = tokenBootstrapExitCode
    return
  }

  if (bootstrapArguments.processLog) {
    const { installRotatingProcessLog } = await import('./daemon/log-file')
    installRotatingProcessLog()
  }

  const bootstrapExitCode = await restartWithSanitizedNetworkEnvironmentIfNeeded(args, bootstrapArguments)
  if (bootstrapExitCode !== undefined) {
    process.exitCode = bootstrapExitCode
    return
  }

  const [
    { defineCommand, renderUsage, runMain },
    { stripAnsi },
    { auth },
    { checkUsage },
    { disable },
    { enable },
    { logs },
    { restart },
    { status },
    { stop },
    { debug },
    { doctor },
    { models },
    { setup },
    { start },
  ] = await Promise.all([
    import('citty'),
    import('consola/utils'),
    import('./auth'),
    import('./check-usage'),
    import('./daemon/disable'),
    import('./daemon/enable'),
    import('./daemon/logs'),
    import('./daemon/restart'),
    import('./daemon/status'),
    import('./daemon/stop'),
    import('./debug'),
    import('./doctor'),
    import('./models'),
    import('./setup'),
    import('./start'),
  ])

  const main = defineCommand({
    meta: {
      name: 'copilot-proxy',
      description:
        'A local, single-user GitHub Copilot adapter for OpenAI and Anthropic clients.',
    },
    subCommands: {
      setup,
      start,
      models,
      doctor,
      auth,
      'check-usage': checkUsage,
      debug,
      stop,
      status,
      logs,
      restart,
      enable,
      disable,
    },
  })

  await runMain(main, {
    showUsage: async (command, parent) => {
      const usage = await renderUsage(command, parent)
      const publicUsage = usage
        .split('\n')
        .filter(line => !stripAnsi(line).includes('--_'))
        .join('\n')
      process.stdout.write(`${publicUsage}\n`)
    },
  })
}

void run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
