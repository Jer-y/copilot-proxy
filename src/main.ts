#!/usr/bin/env node

import { defineCommand, runMain } from 'citty'

import { auth } from './auth'
import { checkUsage } from './check-usage'
import { debug } from './debug'
import { start } from './start'

const main = defineCommand({
  meta: {
    name: 'copilot-proxy',
    description:
      'A wrapper around GitHub Copilot API to make it OpenAI compatible, making it usable for other tools.',
  },
  subCommands: { auth, start, 'check-usage': checkUsage, debug },
})

// eslint-disable-next-line antfu/no-top-level-await
await runMain(main)
