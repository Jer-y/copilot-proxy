#!/usr/bin/env node

import process from 'node:process'

import { isSupportedNodeVersion, MINIMUM_NODE_VERSION } from './lib/runtime-version'

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
