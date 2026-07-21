import { describe, expect, test } from 'bun:test'
import { parseArgs as parseCittyArgs } from 'citty'

import {
  findCittyRootCommand,
  resolveCittyBooleanOption,
  START_CITTY_STRING_OPTIONS,
} from '~/lib/citty-argv'

describe('dependency-free Citty argv helpers', () => {
  test('locates the first root positional and exposes only subcommand args', () => {
    expect(findCittyRootCommand([
      '-v',
      '--unknown=value',
      'start',
      '--host',
      '127.0.0.1',
    ])).toEqual({
      command: 'start',
      index: 2,
      rawArgs: ['--host', '127.0.0.1'],
    })
    expect(findCittyRootCommand(['--unknown', 'value', 'start'])).toEqual({
      command: 'value',
      index: 1,
      rawArgs: ['start'],
    })
    expect(findCittyRootCommand(['--', 'start'])).toBeUndefined()
  })

  test('matches Citty internal boolean aliases, negatives, and string consumption', () => {
    const argsDefinition = {
      'port': { alias: 'p', type: 'string' },
      'host': { alias: 'H', type: 'string' },
      'github-token': { alias: 'g', type: 'string' },
      '_service': { type: 'boolean', default: false },
      '_log-file': { type: 'boolean', default: false },
    } as const
    const cases = [
      [],
      ['--_service'],
      ['--service'],
      ['---service'],
      ['--_service=false'],
      ['--no-_service', '--service'],
      ['--no--service', '--service'],
      ['--no-service', '---service'],
      ['--service', '--no--service'],
      ['--_service', '--no-service'],
      ['--host', '--_service'],
      ['-p', '--service'],
      ['--host', '--', '--service'],
      ['--', '--service'],
      ['--_log-file'],
      ['--logFile'],
      ['---log-file'],
      ['--_log-file=false'],
      ['--no--log-file', '--logFile'],
      ['--no-logFile', '---log-file'],
      ['--github-token', '--logFile'],
      ['--host', '--', '--logFile'],
      ['--', '--logFile'],
    ]

    for (const rawArgs of cases) {
      const parsed = parseCittyArgs(rawArgs, argsDefinition)
      for (const name of ['_service', '_log-file'] as const) {
        const resolved = resolveCittyBooleanOption(rawArgs, name, {
          stringOptions: START_CITTY_STRING_OPTIONS,
        })
        expect({ name, rawArgs, value: Boolean(resolved.value) }).toEqual({
          name,
          rawArgs,
          value: Boolean(parsed[name]),
        })
      }
    }
  })
})
