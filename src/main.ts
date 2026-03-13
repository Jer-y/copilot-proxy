#!/usr/bin/env node

import { defineCommand, runMain } from 'citty'

import { auth } from './auth'
import { checkUsage } from './check-usage'
import { config } from './daemon/config-cmd'
import { disable } from './daemon/disable'
import { enable } from './daemon/enable'
import { logs } from './daemon/logs'
import { restart } from './daemon/restart'
import { status } from './daemon/status'
import { stop } from './daemon/stop'
import { debug } from './debug'
import { start } from './start'

const main = defineCommand({
  meta: {
    name: 'copilot-proxy',
    description:
      'A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.',
  },
  subCommands: { auth, start, 'check-usage': checkUsage, debug, stop, status, logs, restart, enable, disable, config },
})

// eslint-disable-next-line antfu/no-top-level-await
await runMain(main)
