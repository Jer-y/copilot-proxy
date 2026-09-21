import type { ArgsDef } from 'citty'

import { describe, expect, test } from 'bun:test'
import { parseArgs } from 'citty'

import { auth } from '~/auth'
import { AUTH_CITTY_STRING_OPTIONS, cittyLongOptionNames, resolveCittyBooleanOption, SETUP_CITTY_STRING_OPTIONS, START_CITTY_STRING_OPTIONS } from '~/lib/citty-argv'
import { AUTH_CLI_OPTIONS, SETUP_CLI_OPTIONS, START_CLI_OPTIONS } from '~/lib/cli-options'
import { wasRunOptionPassed } from '~/lib/run-presets'
import { setup } from '~/setup'
import { start } from '~/start'

describe('shared CLI option metadata', () => {
  for (const [name, command, metadata, stringOptions] of [
    ['start', start, START_CLI_OPTIONS, START_CITTY_STRING_OPTIONS],
    ['setup', setup, SETUP_CLI_OPTIONS, SETUP_CITTY_STRING_OPTIONS],
    ['auth', auth, AUTH_CLI_OPTIONS, AUTH_CITTY_STRING_OPTIONS],
  ] as const) {
    test(`${name} keeps the complete command and bootstrap schema aligned`, async () => {
      const args = (typeof command.args === 'function' ? await command.args() : await command.args) as ArgsDef
      expect(Object.keys(args)).toEqual(Object.keys(metadata))
      expect(stringOptions).toEqual(Object.entries(args)
        .filter(([, option]) => option.type === 'string' || option.type === 'enum')
        .map(([name, option]) => ({ name, ...('alias' in option && typeof option.alias === 'string' && { shortName: option.alias }) })))
      for (const [key, option] of Object.entries(metadata)) {
        const definition = args[key]
        expect(definition.type).toBe(option.type)
        expect('alias' in definition ? definition.alias : undefined).toBe('alias' in option ? option.alias : undefined)
        expect(definition.description).toBeString()
        if (option.type === 'positional')
          continue
        const value = option.type === 'boolean'
          ? 'true'
          : definition.type === 'enum'
            ? definition.options?.[0] ?? 'metadata-test'
            : 'metadata-test'
        for (const alias of cittyLongOptionNames(key)) {
          const raw = [...(name === 'setup' ? ['claude'] : []), `--${alias}=${value}`]
          expect(Reflect.get(parseArgs(raw, args), key) as unknown).toBe(option.type === 'boolean' ? true : value)
          if (name !== 'auth')
            expect(wasRunOptionPassed(raw, key, undefined, name)).toBe(true)
        }
      }
    })

    test(`${name} preserves string consumption before a proxy-looking value`, async () => {
      const args = (typeof command.args === 'function' ? await command.args() : await command.args) as ArgsDef
      // Bootstrap only detects consumption. Enum validation happens later in
      // Citty; use string parsing here so invalid enum values remain observable.
      const parsingArgs: ArgsDef = Object.fromEntries(Object.entries(args).map(([key, option]) => [
        key,
        option.type === 'enum' ? { ...option, type: 'string' } : option,
      ]))
      for (const option of stringOptions) {
        for (const spelling of [
          ...[...cittyLongOptionNames(option.name)].map(alias => `--${alias}`),
          ...(option.shortName ? [`-${option.shortName}`] : []),
        ]) {
          for (const raw of [
            [spelling, '--proxy-env'],
            [spelling, 'value', '--proxy-env'],
            ['--', spelling, '--proxy-env'],
          ]) {
            expect(resolveCittyBooleanOption(raw, 'proxy-env', { stringOptions }).value ?? false)
              .toBe(Boolean(parseArgs([...(name === 'setup' ? ['claude'] : []), ...raw], parsingArgs)['proxy-env']))
          }
        }
      }
    })
  }
})
