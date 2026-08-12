import type { AccountsConfiguration, ClientSurface, RequiredAccountRoute } from '~/lib/account/types'
import type { AccountType } from '~/lib/cli-validators'

import process from 'node:process'
import { defineCommand } from 'citty'
import consola from 'consola'

import { assertProxyEndpointAvailable } from '~/daemon/service-env'
import { readTokenFromStdin, runDeviceFlow } from '~/lib/account/auth'
import { assertValidAccountId } from '~/lib/account/identity'
import {
  AccountTransactionError,
  addAccount,
  assertAccountMutationAllowed,
  authenticateExistingAccount,
  removeAccount,
  removeAccountRoute,
  removeRequiredAccountRoute,
  setAccountMaxConcurrency,
  setAccountRoute,
  setDefaultAccount,
  setRequiredAccountRoute,
} from '~/lib/account/operations'
import { buildAccountNetworkTargets } from '~/lib/account/proxy-targets'
import { readAccountsConfiguration } from '~/lib/account/store'
import { validateAccountType } from '~/lib/cli-validators'
import { initializeNodeHttpClient } from '~/lib/proxy'
import { cliEnablesProxyEnvironment } from '~/lib/proxy-environment'

const commonWriteArgs = {
  'proxy-env': {
    type: 'boolean' as const,
    default: false,
    description: 'Use HTTP(S)_PROXY/NO_PROXY for account authentication and validation',
  },
  'yes': {
    alias: 'y',
    type: 'boolean' as const,
    default: false,
    description: 'Apply the displayed change without an interactive confirmation',
  },
}

const CLIENT_SURFACES: ClientSurface[] = [
  'responses-http',
  'responses-websocket',
  'anthropic-messages',
  'chat-completions',
  'embeddings',
]

const ACCOUNT_SUBCOMMANDS = new Set([
  'add',
  'auth',
  'concurrency',
  'default',
  'list',
  'remove',
  'required-route',
  'route',
])

const add = defineCommand({
  meta: { name: 'add', description: 'Add and authenticate a Copilot account' },
  args: {
    'id': { type: 'positional', required: false, description: 'Local account id' },
    'account-type': {
      alias: 'a',
      type: 'string',
      default: 'individual',
      description: 'individual, business, or enterprise',
    },
    'token-stdin': {
      type: 'boolean',
      default: false,
      description: 'Read an existing GitHub token from stdin instead of device flow',
    },
    ...commonWriteArgs,
  },
  async run({ args }) {
    const id = args.id ?? await requireInteractiveText('Account id')
    assertValidAccountId(id)
    if (!validateAccountType(args['account-type']))
      throw new Error(`Invalid account-type: ${args['account-type']}`)
    await prepareAccountWrite(args['proxy-env'], {
      accountTypes: [args['account-type']],
      deviceFlow: !args['token-stdin'],
    })
    await confirmChange(
      `Add account ${id} (${args['account-type']})`,
      args.yes,
    )
    const token = args['token-stdin']
      ? await readTokenFromStdin()
      : await runDeviceFlow()
    await runWriteOperation(async () => {
      const configuration = await addAccount({
        id,
        accountType: args['account-type'] as AccountType,
        token,
      })
      consola.success(`Added account ${id}; configuration revision ${configuration.revision}.`)
    })
  },
})

const authenticate = defineCommand({
  meta: { name: 'auth', description: 'Re-authenticate an existing Copilot account' },
  args: {
    'id': { type: 'positional', required: false, description: 'Local account id' },
    'token-stdin': {
      type: 'boolean',
      default: false,
      description: 'Read an existing GitHub token from stdin instead of device flow',
    },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'], {
      deviceFlow: !args['token-stdin'],
    })
    const id = args.id ?? await chooseAccount('Account to re-authenticate')
    await confirmChange(`Re-authenticate account ${id}`, args.yes)
    const token = args['token-stdin']
      ? await readTokenFromStdin()
      : await runDeviceFlow()
    await runWriteOperation(async () => {
      await authenticateExistingAccount({ id, token })
      consola.success(`Re-authenticated account ${id}.`)
    })
  },
})

const setDefault = defineCommand({
  meta: { name: 'default', description: 'Set the default Copilot account' },
  args: {
    id: { type: 'positional', required: false, description: 'Local account id' },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'])
    const id = args.id ?? await chooseAccount('New default account')
    await confirmChange(`Set default account to ${id}`, args.yes)
    await runWriteOperation(async () => {
      const configuration = await setDefaultAccount(id)
      consola.success(`Default account is now ${id}; configuration revision ${configuration.revision}.`)
    })
  },
})

const remove = defineCommand({
  meta: { name: 'remove', description: 'Remove a Copilot account' },
  args: {
    id: { type: 'positional', required: false, description: 'Local account id' },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'])
    const id = args.id ?? await chooseAccount('Account to remove')
    if (!args.yes) {
      ensureInteractive()
      const confirmation = await requireInteractiveText(`Type ${id} to confirm removal`)
      if (confirmation !== id)
        throw new Error('Removal confirmation did not match the account id')
    }
    await runWriteOperation(async () => {
      const configuration = await removeAccount(id)
      consola.success(`Removed account ${id}; configuration revision ${configuration.revision}.`)
    })
  },
})

const list = defineCommand({
  meta: { name: 'list', description: 'List configured Copilot accounts' },
  args: {
    json: { type: 'boolean', default: false, description: 'Print machine-readable JSON' },
  },
  run({ args }) {
    printAccounts(args.json)
  },
})

const concurrencySet = defineCommand({
  meta: { name: 'set', description: 'Set one account-specific upstream concurrency limit' },
  args: {
    id: { type: 'positional', required: false, description: 'Account id' },
    max: { type: 'positional', required: false, description: 'Positive maximum concurrency' },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'])
    const id = args.id ?? await chooseAccount('Account to limit')
    const max = parseMaxConcurrency(args.max ?? await requireInteractiveText('Maximum concurrency'))
    await confirmChange(`Set account ${id} max concurrency to ${max}`, args.yes)
    await runWriteOperation(async () => {
      const configuration = await setAccountMaxConcurrency(id, max)
      consola.success(`Account ${id} max concurrency is now ${max}; configuration revision ${configuration.revision}.`)
    })
  },
})

const concurrencyClear = defineCommand({
  meta: { name: 'clear', description: 'Remove one account-specific concurrency override' },
  args: {
    id: { type: 'positional', required: false, description: 'Account id' },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'])
    const id = args.id ?? await chooseAccount('Account whose limit should be cleared')
    await confirmChange(`Clear account ${id} max concurrency`, args.yes)
    await runWriteOperation(async () => {
      const configuration = await setAccountMaxConcurrency(id, undefined)
      consola.success(`Cleared account ${id} max concurrency; configuration revision ${configuration.revision}.`)
    })
  },
})

const concurrency = defineCommand({
  meta: { name: 'concurrency', description: 'Manage account-specific concurrency limits' },
  subCommands: { clear: concurrencyClear, set: concurrencySet },
})

const requiredRouteSet = defineCommand({
  meta: { name: 'set', description: 'Require one client surface and model to remain ready' },
  args: {
    surface: { type: 'positional', required: false, description: 'Client surface' },
    model: { type: 'positional', required: false, description: 'Model id' },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'])
    const surface = args.surface
      ? parseClientSurface(args.surface)
      : await chooseClientSurface()
    const model = args.model ?? await requireInteractiveText('Required model id')
    await confirmChange(`Require ${surface}:${model}`, args.yes)
    await runWriteOperation(async () => {
      const configuration = await setRequiredAccountRoute(surface, model)
      consola.success(`Required route ${surface}:${model} added; configuration revision ${configuration.revision}.`)
    })
  },
})

const requiredRouteRemove = defineCommand({
  meta: { name: 'remove', description: 'Remove one exact required client surface and model' },
  args: {
    surface: { type: 'positional', required: false, description: 'Client surface' },
    model: { type: 'positional', required: false, description: 'Model id' },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'])
    const selected = args.surface || args.model
      ? {
          surface: args.surface
            ? parseClientSurface(args.surface)
            : await chooseClientSurface(),
          model: args.model ?? await requireInteractiveText('Required model id'),
        }
      : await chooseRequiredRoute()
    await confirmChange(`Remove required route ${selected.surface}:${selected.model}`, args.yes)
    await runWriteOperation(async () => {
      const configuration = await removeRequiredAccountRoute(selected.surface, selected.model)
      consola.success(`Required route ${selected.surface}:${selected.model} removed; configuration revision ${configuration.revision}.`)
    })
  },
})

const requiredRouteList = defineCommand({
  meta: { name: 'list', description: 'List required client surfaces and models' },
  args: {
    json: { type: 'boolean', default: false, description: 'Print machine-readable JSON' },
  },
  run({ args }) {
    printRequiredRoutes(args.json)
  },
})

const requiredRoute = defineCommand({
  meta: { name: 'required-route', description: 'Manage startup-critical client surface and model checks' },
  subCommands: { list: requiredRouteList, remove: requiredRouteRemove, set: requiredRouteSet },
})

const routeSet = defineCommand({
  meta: { name: 'set', description: 'Bind a model glob to one account' },
  args: {
    match: { type: 'positional', required: false, description: 'Model glob' },
    account: { type: 'positional', required: false, description: 'Account id' },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'])
    const match = args.match ?? await requireInteractiveText('Model glob')
    const account = args.account ?? await chooseAccount('Route account')
    await confirmChange(`Route ${match} to ${account}`, args.yes)
    await runWriteOperation(async () => {
      const configuration = await setAccountRoute(match, account)
      consola.success(`Route ${match} now uses ${account}; configuration revision ${configuration.revision}.`)
    })
  },
})

const routeRemove = defineCommand({
  meta: { name: 'remove', description: 'Remove an exact model route rule' },
  args: {
    match: { type: 'positional', required: false, description: 'Exact model glob' },
    ...commonWriteArgs,
  },
  async run({ args }) {
    await prepareAccountWrite(args['proxy-env'])
    const match = args.match ?? await chooseRoute()
    await confirmChange(`Remove route ${match}`, args.yes)
    await runWriteOperation(async () => {
      const configuration = await removeAccountRoute(match)
      consola.success(`Removed route ${match}; configuration revision ${configuration.revision}.`)
    })
  },
})

const routeList = defineCommand({
  meta: { name: 'list', description: 'List model route rules in match order' },
  args: {
    json: { type: 'boolean', default: false, description: 'Print machine-readable JSON' },
  },
  run({ args }) {
    printRoutes(args.json)
  },
})

const route = defineCommand({
  meta: { name: 'route', description: 'Manage deterministic model route rules' },
  subCommands: { set: routeSet, remove: routeRemove, list: routeList },
})

export const accounts = defineCommand({
  meta: { name: 'accounts', description: 'Manage multiple GitHub Copilot accounts' },
  args: {
    'proxy-env': commonWriteArgs['proxy-env'],
  },
  subCommands: {
    'add': add,
    'auth': authenticate,
    'concurrency': concurrency,
    'default': setDefault,
    'list': list,
    'remove': remove,
    'required-route': requiredRoute,
    'route': route,
  },
  async run({ rawArgs }) {
    if (rawArgs.some(argument => ACCOUNT_SUBCOMMANDS.has(argument)))
      return
    ensureInteractive()
    const action = await consola.prompt('Copilot accounts', {
      type: 'select',
      options: [
        'List accounts',
        'Add account',
        'Re-authenticate account',
        'Set default account',
        'Configure account concurrency',
        'Configure model routes',
        'Configure required routes',
        'Remove account',
      ],
    }) as string
    await runInteractiveAction(action)
  },
})

async function confirmChange(summary: string, yes: boolean): Promise<void> {
  consola.info(`Change preview: ${summary}`)
  if (yes)
    return
  ensureInteractive()
  const confirmed = await consola.prompt('Apply this change?', { type: 'confirm' }) as boolean
  if (!confirmed)
    throw new Error('Operation cancelled')
}

async function chooseAccount(message: string): Promise<string> {
  ensureInteractive()
  const configuration = requireConfiguration()
  return await consola.prompt(message, {
    type: 'select',
    options: configuration.accounts.map(account => account.id),
  }) as string
}

async function chooseRoute(): Promise<string> {
  ensureInteractive()
  const configuration = requireConfiguration()
  if (configuration.routes.length === 0)
    throw new Error('No model routes are configured')
  return await consola.prompt('Route to remove', {
    type: 'select',
    options: configuration.routes.map(route => route.match),
  }) as string
}

async function chooseClientSurface(): Promise<ClientSurface> {
  ensureInteractive()
  return await consola.prompt('Client surface', {
    type: 'select',
    options: CLIENT_SURFACES,
  }) as ClientSurface
}

async function chooseRequiredRoute(): Promise<RequiredAccountRoute> {
  ensureInteractive()
  const routes = requireConfiguration().requiredRoutes
  if (routes.length === 0)
    throw new Error('No required routes are configured')
  const selected = await consola.prompt('Required route to remove', {
    type: 'select',
    options: routes.map(route => `${route.surface}:${route.model}`),
  }) as string
  const route = routes.find(candidate => `${candidate.surface}:${candidate.model}` === selected)
  if (!route)
    throw new Error('Selected required route no longer exists')
  return route
}

function parseClientSurface(value: string): ClientSurface {
  if (!CLIENT_SURFACES.includes(value as ClientSurface))
    throw new Error(`Invalid client surface: ${value} (must be one of: ${CLIENT_SURFACES.join(', ')})`)
  return value as ClientSurface
}

function parseMaxConcurrency(value: string): number {
  if (!/^\d+$/.test(value))
    throw new Error('Account max concurrency must be a positive safe integer')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error('Account max concurrency must be a positive safe integer')
  return parsed
}

async function requireInteractiveText(message: string): Promise<string> {
  ensureInteractive()
  const value = await consola.prompt(message, { type: 'text' }) as string
  if (!value)
    throw new Error(`${message} is required`)
  return value
}

function ensureInteractive(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Missing required arguments in non-interactive mode')
}

function requireConfiguration(): AccountsConfiguration {
  const configuration = readAccountsConfiguration()
  if (!configuration)
    throw new Error('No accounts.json configuration exists')
  return configuration
}

async function runWriteOperation(operation: () => Promise<void>): Promise<boolean> {
  try {
    await operation()
    return true
  }
  catch (error) {
    process.exitCode = error instanceof AccountTransactionError ? error.exitCode : 1
    consola.error(error instanceof Error ? error.message : error)
    return false
  }
}

async function runInteractiveAction(action: string): Promise<void> {
  if (action !== 'List accounts') {
    if (action !== 'Add account' && action !== 'Re-authenticate account')
      initializeAccountsNetwork(false)
    await assertAccountMutationAllowed()
  }
  switch (action) {
    case 'List accounts':
      printAccounts(false)
      return
    case 'Add account': {
      const id = await requireInteractiveText('Account id')
      assertValidAccountId(id)
      const accountType = await consola.prompt('Account type', {
        type: 'select',
        options: ['individual', 'business', 'enterprise'],
      }) as AccountType
      initializeAccountsNetwork(false, {
        accountTypes: [accountType],
        deviceFlow: true,
      })
      await confirmChange(`Add account ${id} (${accountType})`, false)
      const token = await runDeviceFlow()
      const added = await runWriteOperation(async () => {
        await addAccount({ id, accountType, token })
        consola.success(`Added account ${id}.`)
      })
      if (!added)
        return
      const configuration = readAccountsConfiguration()
      if (configuration && configuration.defaultAccount !== id) {
        const makeDefault = await consola.prompt('Set this account as default?', { type: 'confirm' }) as boolean
        if (makeDefault) {
          await runWriteOperation(async () => {
            await setDefaultAccount(id)
            consola.success(`Default account is now ${id}.`)
          })
        }
      }
      const addRoute = await consola.prompt('Add a model route for this account now?', { type: 'confirm' }) as boolean
      if (addRoute) {
        const match = await requireInteractiveText('Model glob (for example claude-*)')
        await runWriteOperation(async () => {
          await setAccountRoute(match, id)
          consola.success(`Route ${match} now uses ${id}.`)
        })
      }
      return
    }
    case 'Re-authenticate account': {
      const id = await chooseAccount('Account to re-authenticate')
      initializeAccountsNetwork(false, { deviceFlow: true })
      await confirmChange(`Re-authenticate account ${id}`, false)
      const token = await runDeviceFlow()
      await runWriteOperation(async () => {
        await authenticateExistingAccount({ id, token })
        consola.success(`Re-authenticated account ${id}.`)
      })
      return
    }
    case 'Set default account': {
      const id = await chooseAccount('New default account')
      await confirmChange(`Set default account to ${id}`, false)
      await runWriteOperation(async () => {
        await setDefaultAccount(id)
        consola.success(`Default account is now ${id}.`)
      })
      return
    }
    case 'Configure account concurrency': {
      const id = await chooseAccount('Account concurrency override')
      const action = await consola.prompt('Concurrency override', {
        type: 'select',
        options: ['Set limit', 'Clear limit'],
      }) as string
      if (action === 'Set limit') {
        const max = parseMaxConcurrency(await requireInteractiveText('Maximum concurrency'))
        await confirmChange(`Set account ${id} max concurrency to ${max}`, false)
        await runWriteOperation(async () => {
          await setAccountMaxConcurrency(id, max)
          consola.success(`Account ${id} max concurrency is now ${max}.`)
        })
      }
      else {
        await confirmChange(`Clear account ${id} max concurrency`, false)
        await runWriteOperation(async () => {
          await setAccountMaxConcurrency(id, undefined)
          consola.success(`Cleared account ${id} max concurrency.`)
        })
      }
      return
    }
    case 'Configure model routes': {
      const routeAction = await consola.prompt('Model routes', {
        type: 'select',
        options: ['List routes', 'Set route', 'Remove route'],
      }) as string
      if (routeAction === 'List routes') {
        printRoutes(false)
        return
      }
      if (routeAction === 'Set route') {
        const account = await chooseAccount('Route account')
        const match = await requireInteractiveText('Model glob')
        await confirmChange(`Route ${match} to ${account}`, false)
        await runWriteOperation(async () => {
          await setAccountRoute(match, account)
          consola.success(`Route ${match} now uses ${account}.`)
        })
        return
      }
      const match = await chooseRoute()
      await confirmChange(`Remove route ${match}`, false)
      await runWriteOperation(async () => {
        await removeAccountRoute(match)
        consola.success(`Removed route ${match}.`)
      })
      return
    }
    case 'Configure required routes': {
      const action = await consola.prompt('Required routes', {
        type: 'select',
        options: ['List required routes', 'Set required route', 'Remove required route'],
      }) as string
      if (action === 'List required routes') {
        printRequiredRoutes(false)
        return
      }
      if (action === 'Set required route') {
        const surface = await chooseClientSurface()
        const model = await requireInteractiveText('Required model id')
        await confirmChange(`Require ${surface}:${model}`, false)
        await runWriteOperation(async () => {
          await setRequiredAccountRoute(surface, model)
          consola.success(`Required route ${surface}:${model} added.`)
        })
        return
      }
      const selected = await chooseRequiredRoute()
      await confirmChange(`Remove required route ${selected.surface}:${selected.model}`, false)
      await runWriteOperation(async () => {
        await removeRequiredAccountRoute(selected.surface, selected.model)
        consola.success(`Required route ${selected.surface}:${selected.model} removed.`)
      })
      return
    }
    case 'Remove account': {
      const id = await chooseAccount('Account to remove')
      const confirmation = await requireInteractiveText(`Type ${id} to confirm removal`)
      if (confirmation !== id)
        throw new Error('Removal confirmation did not match the account id')
      await runWriteOperation(async () => {
        await removeAccount(id)
        consola.success(`Removed account ${id}.`)
      })
    }
  }
}

async function prepareAccountWrite(
  proxyEnv: boolean,
  options: { accountTypes?: Iterable<AccountType>, deviceFlow?: boolean } = {},
): Promise<void> {
  initializeAccountsNetwork(proxyEnv, options)
  await assertAccountMutationAllowed()
}

function initializeAccountsNetwork(
  proxyEnv: boolean,
  options: { accountTypes?: Iterable<AccountType>, deviceFlow?: boolean } = {},
): void {
  const enabled = proxyEnv || cliEnablesProxyEnvironment(process.argv.slice(2))
  if (enabled) {
    assertProxyEndpointAvailable(
      process.env,
      accountsProxyRequiredTargets(options.accountTypes, options.deviceFlow),
    )
  }
  initializeNodeHttpClient({
    proxyEnv: enabled,
  })
}

export function accountsProxyRequiredTargets(
  additionalAccountTypes: Iterable<AccountType> = [],
  deviceFlow = false,
): string[] {
  const configuration = readAccountsConfiguration()
  return buildAccountNetworkTargets({
    accountTypes: [
      ...(configuration?.accounts.map(account => account.accountType) ?? []),
      ...additionalAccountTypes,
    ],
    deviceFlow,
    vsCode: true,
  })
}

function printAccounts(json: boolean): void {
  const configuration = readAccountsConfiguration()
  if (json) {
    process.stdout.write(`${JSON.stringify(configuration ?? { accounts: [], defaultAccount: null }, null, 2)}\n`)
    return
  }
  if (!configuration) {
    consola.info('No explicit accounts.json configuration exists; the legacy default account remains active.')
    return
  }
  for (const account of configuration.accounts) {
    const marker = account.id === configuration.defaultAccount ? ' (default)' : ''
    consola.log(`${account.id}${marker}\t${account.accountType}\t${account.githubLogin}`)
  }
}

function printRoutes(json: boolean): void {
  const routes = readAccountsConfiguration()?.routes ?? []
  if (json) {
    process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`)
    return
  }
  routes.forEach((route, index) => consola.log(`${index + 1}. ${route.match} -> ${route.account}`))
}

function printRequiredRoutes(json: boolean): void {
  const routes = readAccountsConfiguration()?.requiredRoutes ?? []
  if (json) {
    process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`)
    return
  }
  routes.forEach((route, index) => consola.log(`${index + 1}. ${route.surface}:${route.model}`))
}
