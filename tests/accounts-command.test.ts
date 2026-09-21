import type { AccountsConfiguration } from '~/lib/account/types'

import process from 'node:process'
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { runCommand } from 'citty'
import consola from 'consola'

import { accounts } from '~/accounts'
import * as serviceEnvironment from '~/daemon/service-env'
import * as authentication from '~/lib/account/auth'
import * as operations from '~/lib/account/operations'
import * as store from '~/lib/account/store'
import * as proxy from '~/lib/proxy'

const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
const originalExitCode = process.exitCode
const configuration: AccountsConfiguration = {
  version: 1,
  revision: 7,
  defaultAccount: 'personal',
  accounts: [
    { id: 'personal', accountType: 'individual', githubLogin: 'personal', githubUserId: 1 },
    { id: 'work', accountType: 'business', githubLogin: 'work', githubUserId: 2 },
  ],
  routes: [{ match: 'claude-*', account: 'work' }],
  requiredRoutes: [{ surface: 'responses-http', model: 'test-model' }],
}
let answers: Array<string | boolean> = []

beforeEach(() => {
  answers = []
  process.exitCode = 0
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  spyOn(consola, 'prompt').mockImplementation((() => {
    if (answers.length === 0)
      throw new Error('Unexpected prompt')
    return Promise.resolve(answers.shift()) as ReturnType<typeof consola.prompt>
  }) as typeof consola.prompt)
  spyOn(consola, 'info').mockImplementation(Object.assign(() => {}, { raw: () => {} }))
  spyOn(consola, 'success').mockImplementation(Object.assign(() => {}, { raw: () => {} }))
  spyOn(consola, 'error').mockImplementation(Object.assign(() => {}, { raw: () => {} }))
  spyOn(store, 'readAccountsConfiguration').mockReturnValue(configuration)
  spyOn(operations, 'assertAccountMutationAllowed').mockResolvedValue('none')
  spyOn(proxy, 'initializeNodeHttpClient').mockImplementation(() => {})
  spyOn(serviceEnvironment, 'assertProxyEndpointAvailable').mockImplementation(() => {})
  spyOn(authentication, 'runDeviceFlow').mockResolvedValue('device-token')
  spyOn(authentication, 'readTokenFromStdin').mockResolvedValue('stdin-token')
})

afterEach(() => {
  mock.restore()
  process.exitCode = originalExitCode ?? 0
  for (const [stream, descriptor] of [
    [process.stdin, originalStdinTTY],
    [process.stdout, originalStdoutTTY],
  ] as const) {
    if (descriptor)
      Object.defineProperty(stream, 'isTTY', descriptor)
    else
      Reflect.deleteProperty(stream, 'isTTY')
  }
})

describe('account command shared operations', () => {
  const cases = [
    { operation: 'setDefaultAccount', cli: ['default', 'work'], menu: ['Set default account', 'work', true], args: ['work'], message: 'Default account is now work' },
    { operation: 'setAccountMaxConcurrency', cli: ['concurrency', 'set', 'work', '2'], menu: ['Configure account concurrency', 'work', 'Set limit', '2', true], args: ['work', 2], message: 'Account work max concurrency is now 2' },
    { operation: 'setAccountMaxConcurrency', cli: ['concurrency', 'clear', 'work'], menu: ['Configure account concurrency', 'work', 'Clear limit', true], args: ['work', undefined], message: 'Cleared account work max concurrency' },
    { operation: 'setAccountRoute', cli: ['route', 'set', 'claude-*', 'work'], menu: ['Configure model routes', 'Set route', 'work', 'claude-*', true], args: ['claude-*', 'work'], message: 'Route claude-* now uses work' },
    { operation: 'removeAccountRoute', cli: ['route', 'remove', 'claude-*'], menu: ['Configure model routes', 'Remove route', 'claude-*', true], args: ['claude-*'], message: 'Removed route claude-*' },
    { operation: 'setRequiredAccountRoute', cli: ['required-route', 'set', 'responses-http', 'test-model'], menu: ['Configure required routes', 'Set required route', 'responses-http', 'test-model', true], args: ['responses-http', 'test-model'], message: 'Required route responses-http:test-model added' },
    { operation: 'removeRequiredAccountRoute', cli: ['required-route', 'remove', 'responses-http', 'test-model'], menu: ['Configure required routes', 'Remove required route', 'responses-http:test-model', true], args: ['responses-http', 'test-model'], message: 'Required route responses-http:test-model removed' },
    { operation: 'removeAccount', cli: ['remove', 'work'], menu: ['Remove account', 'work', 'work'], args: ['work'], message: 'Removed account work' },
  ] as const

  for (const entry of cases) {
    test(`preserves both entrypoints for ${entry.cli.join(' ')}`, async () => {
      const operation = spyOn(operations, entry.operation).mockResolvedValue(configuration)
      await runCommand(accounts, { rawArgs: [...entry.cli, '--yes'] })
      expect(operation).toHaveBeenCalledTimes(1)
      expect(operation).toHaveBeenLastCalledWith(...entry.args)
      expect(consola.success).toHaveBeenLastCalledWith(`${entry.message}; configuration revision 7.`)

      answers = [...entry.menu]
      await runCommand(accounts, { rawArgs: [] })
      expect(operation).toHaveBeenCalledTimes(2)
      expect(operation).toHaveBeenLastCalledWith(...entry.args)
      expect(consola.success).toHaveBeenLastCalledWith(`${entry.message}.`)
      expect(answers).toEqual([])
    })
  }

  test('keeps stdin add and interactive post-add choices separate', async () => {
    const add = spyOn(operations, 'addAccount').mockResolvedValue(configuration)
    const setDefault = spyOn(operations, 'setDefaultAccount').mockResolvedValue(configuration)
    const route = spyOn(operations, 'setAccountRoute').mockResolvedValue(configuration)
    await runCommand(accounts, { rawArgs: ['add', 'work', '--account-type', 'business', '--token-stdin', '--yes', '--proxy-env'] })
    expect(add).toHaveBeenCalledTimes(1)
    expect(add).toHaveBeenCalledWith({ id: 'work', accountType: 'business', token: 'stdin-token' })
    expect(authentication.runDeviceFlow).not.toHaveBeenCalled()
    expect(serviceEnvironment.assertProxyEndpointAvailable).toHaveBeenCalledTimes(1)
    expect(proxy.initializeNodeHttpClient).toHaveBeenCalledWith({ proxyEnv: true })
    expect(consola.success).toHaveBeenLastCalledWith('Added account work; configuration revision 7.')

    answers = ['Add account', 'work', 'business', true, true, true, 'claude-*']
    await runCommand(accounts, { rawArgs: [] })
    expect(add).toHaveBeenCalledTimes(2)
    expect(add).toHaveBeenLastCalledWith({ id: 'work', accountType: 'business', token: 'device-token' })
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('work')
    expect(route).toHaveBeenCalledTimes(1)
    expect(route).toHaveBeenCalledWith('claude-*', 'work')
    expect(consola.success).toHaveBeenCalledWith('Added account work.')
    expect(answers).toEqual([])
  })

  test('reauthenticates once through each input path without a revision suffix', async () => {
    const authenticate = spyOn(operations, 'authenticateExistingAccount').mockResolvedValue()
    await runCommand(accounts, { rawArgs: ['auth', 'work', '--token-stdin', '--yes'] })
    expect(authenticate).toHaveBeenCalledTimes(1)
    expect(authenticate).toHaveBeenCalledWith({ id: 'work', token: 'stdin-token' })
    answers = ['Re-authenticate account', 'work', true]
    await runCommand(accounts, { rawArgs: [] })
    expect(authenticate).toHaveBeenCalledTimes(2)
    expect(authenticate).toHaveBeenLastCalledWith({ id: 'work', token: 'device-token' })
    expect(consola.success).toHaveBeenLastCalledWith('Re-authenticated account work.')
  })

  test('does not mutate on cancellation or missing noninteractive arguments', async () => {
    const operation = spyOn(operations, 'setDefaultAccount').mockResolvedValue(configuration)
    answers = ['Set default account', 'work', false]
    await expect(runCommand(accounts, { rawArgs: [] })).rejects.toThrow('Operation cancelled')
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false })
    await expect(runCommand(accounts, { rawArgs: ['default', '--yes'] })).rejects.toThrow('Missing required arguments')
    expect(operation).not.toHaveBeenCalled()
  })

  test.each([1, 2] as const)('preserves transaction exit code %s and stops post-add followups', async (exitCode) => {
    const operation = spyOn(operations, 'addAccount').mockRejectedValue(new operations.AccountTransactionError('mutation failed', exitCode))
    answers = ['Add account', 'work', 'business', true]
    await runCommand(accounts, { rawArgs: [] })
    expect(operation).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(exitCode)
    expect(consola.error).toHaveBeenLastCalledWith('mutation failed')
    expect(consola.success).not.toHaveBeenCalled()
    expect(answers).toEqual([])
  })
})
