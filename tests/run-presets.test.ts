import { describe, expect, test } from 'bun:test'
import { parseArgs } from 'citty'

import { gatewayPresetEnvironmentError, isRunPresetName, resolveRunPreset, RUN_PRESETS, selectStartPreset, wasRunOptionPassed } from '~/lib/run-presets'
import { start } from '~/start'

describe('run presets', () => {
  test('provides bounded safe defaults for personal and service use', () => {
    expect(resolveRunPreset('personal')).toMatchObject({
      host: '127.0.0.1',
      maxConcurrency: 2,
      maxQueue: 8,
      queueTimeoutMs: 30_000,
    })
    expect(resolveRunPreset('service')).toMatchObject({
      host: '127.0.0.1',
      maxConcurrency: 4,
      maxQueue: 32,
      queueTimeoutMs: 30_000,
    })
  })

  test('makes gateway exposure explicit and keeps custom unbounded', () => {
    expect(resolveRunPreset('gateway-upstream')).toMatchObject({
      host: '0.0.0.0',
      maxConcurrency: 4,
      maxQueue: 50,
    })
    expect(resolveRunPreset('custom')).toEqual({
      name: 'custom',
      ...RUN_PRESETS.custom,
    })
  })

  test('applies explicit overrides without changing the named preset', () => {
    expect(resolveRunPreset('personal', {
      host: '::1',
      maxConcurrency: 7,
      maxQueue: 3,
      queueTimeoutMs: 0,
    })).toMatchObject({
      name: 'personal',
      host: '::1',
      maxConcurrency: 7,
      maxQueue: 3,
      queueTimeoutMs: 0,
    })
  })

  test('validates public preset names', () => {
    expect(isRunPresetName('personal')).toBe(true)
    expect(isRunPresetName('gateway-upstream')).toBe(true)
    expect(isRunPresetName('unbounded')).toBe(false)
  })

  test('recognizes long and short explicit options', () => {
    expect(wasRunOptionPassed(['start', '--host', '::1'], 'host', 'H')).toBe(true)
    expect(wasRunOptionPassed(['start', '--max-concurrency=7'], 'max-concurrency')).toBe(true)
    expect(wasRunOptionPassed(['start', '--maxConcurrency=7'], 'max-concurrency')).toBe(true)
    expect(wasRunOptionPassed(['start', '--maxQueue', '4'], 'max-queue')).toBe(true)
    expect(wasRunOptionPassed(['start', '--queueTimeoutMs=0'], 'queue-timeout-ms')).toBe(true)
    expect(wasRunOptionPassed(['start', '-H=::1'], 'host', 'H')).toBe(true)
    expect(wasRunOptionPassed(['start', '-H0.0.0.0'], 'host', 'H')).toBe(true)
    expect(wasRunOptionPassed(['start'], 'host', 'H')).toBe(false)
  })

  test('recognizes every Citty-generated camelCase start alias', async () => {
    const argsDefinition = typeof start.args === 'function'
      ? await start.args()
      : await start.args
    if (!argsDefinition)
      throw new Error('Expected start command arguments')

    const cases: Array<{
      alias: string
      expected: boolean | string
      longName: string
    }> = [
      { alias: 'accountType', expected: 'business', longName: 'account-type' },
      { alias: 'rateLimit', expected: '1', longName: 'rate-limit' },
      { alias: 'maxConcurrency', expected: '7', longName: 'max-concurrency' },
      { alias: 'maxQueue', expected: '3', longName: 'max-queue' },
      { alias: 'queueTimeoutMs', expected: '0', longName: 'queue-timeout-ms' },
      { alias: 'headersTimeoutMs', expected: '0', longName: 'headers-timeout-ms' },
      { alias: 'bodyTimeoutMs', expected: '0', longName: 'body-timeout-ms' },
      { alias: 'connectTimeoutMs', expected: '0', longName: 'connect-timeout-ms' },
      { alias: 'githubToken', expected: 'ghu_alias_value', longName: 'github-token' },
      { alias: 'claudeCode', expected: true, longName: 'claude-code' },
      { alias: 'showToken', expected: true, longName: 'show-token' },
      { alias: 'proxyEnv', expected: true, longName: 'proxy-env' },
      { alias: 'supervisor', expected: true, longName: '_supervisor' },
      { alias: 'service', expected: true, longName: '_service' },
      { alias: 'logFile', expected: true, longName: '_log-file' },
      { alias: 'dataDir', expected: 'C:\\runtime', longName: '_data-dir' },
      { alias: 'instanceToken', expected: 'instance-token', longName: '_instance-token' },
    ]

    for (const { alias, expected, longName } of cases) {
      const rawArgs = typeof expected === 'boolean'
        ? [`--${alias}`]
        : [`--${alias}`, expected]
      const parsed = parseArgs(rawArgs, argsDefinition)
      const parsedValue: unknown = Reflect.get(parsed as object, longName)
      expect({
        alias,
        detected: wasRunOptionPassed(rawArgs, longName),
        value: parsedValue,
      }).toEqual({
        alias,
        detected: true,
        value: expected,
      })
    }
  })

  test('matches Citty option presence across string consumption, clusters, and the terminator', async () => {
    const argsDefinition = typeof start.args === 'function'
      ? await start.args()
      : await start.args
    if (!argsDefinition)
      throw new Error('Expected start command arguments')

    const cases: Array<{
      longName: 'host' | 'max-concurrency'
      rawArgs: string[]
      shortName?: string
    }> = [
      { longName: 'max-concurrency', rawArgs: ['--maxConcurrency', '7'] },
      { longName: 'max-concurrency', rawArgs: ['--max-concurrency=7'] },
      { longName: 'max-concurrency', rawArgs: ['--github-token', '--maxConcurrency', '7'] },
      { longName: 'max-concurrency', rawArgs: ['-g--maxConcurrency', '7'] },
      { longName: 'max-concurrency', rawArgs: ['--', '--maxConcurrency', '7'] },
      { longName: 'max-concurrency', rawArgs: ['--port', '--', '--maxConcurrency', '7'] },
      { longName: 'max-concurrency', rawArgs: ['--port', '--no-verbose', '--maxConcurrency', '7'] },
      { longName: 'host', rawArgs: ['-vH127.0.0.1'], shortName: 'H' },
      { longName: 'host', rawArgs: ['-gH127.0.0.1'], shortName: 'H' },
      { longName: 'host', rawArgs: ['--githubToken', '--host', '127.0.0.1'], shortName: 'H' },
    ]

    for (const { longName, rawArgs, shortName } of cases) {
      const targetDefinition = argsDefinition[longName]
      if (!targetDefinition)
        throw new Error(`Missing start option definition for ${longName}`)
      const argsWithoutTargetDefault = {
        ...argsDefinition,
        [longName]: {
          ...targetDefinition,
          default: undefined,
        },
      }
      const parsed = parseArgs(rawArgs, argsWithoutTargetDefault)

      expect({
        detected: wasRunOptionPassed(rawArgs, longName, shortName),
        longName,
        rawArgs,
      }).toEqual({
        detected: parsed[longName] !== undefined,
        longName,
        rawArgs,
      })
    }
  })

  test('uses the exact start or setup string schema for option presence', () => {
    expect(wasRunOptionPassed(
      ['---data-dir', '--host', '--preset', 'gateway-upstream'],
      'host',
      'H',
    )).toBe(false)
    expect(wasRunOptionPassed(
      ['---instance-token', '--max-concurrency', '7'],
      'max-concurrency',
    )).toBe(false)
    expect(wasRunOptionPassed(
      ['--model', '--host', '0.0.0.0'],
      'host',
      'H',
    )).toBe(true)
    expect(wasRunOptionPassed(
      ['codex', '--_data-dir', '--host', '0.0.0.0'],
      'host',
      'H',
      'setup',
    )).toBe(true)
    expect(wasRunOptionPassed(
      ['codex', '--model', '--host', '0.0.0.0'],
      'host',
      'H',
      'setup',
    )).toBe(false)
  })

  test('lets every explicit camelCase concurrency alias override a named preset', async () => {
    const rawArgs = [
      '--preset',
      'personal',
      '--maxConcurrency',
      '7',
      '--maxQueue=3',
      '--queueTimeoutMs',
      '0',
    ]
    const argsDefinition = typeof start.args === 'function'
      ? await start.args()
      : await start.args
    if (!argsDefinition)
      throw new Error('Expected start command arguments')
    const args = parseArgs(rawArgs, argsDefinition)
    const presetName = selectStartPreset(args.preset, rawArgs, false)
    const resolved = resolveRunPreset(presetName, {
      ...(wasRunOptionPassed(rawArgs, 'max-concurrency') && { maxConcurrency: Number(args['max-concurrency']) }),
      ...(wasRunOptionPassed(rawArgs, 'max-queue') && { maxQueue: Number(args['max-queue']) }),
      ...(wasRunOptionPassed(rawArgs, 'queue-timeout-ms') && { queueTimeoutMs: Number(args['queue-timeout-ms']) }),
    })

    expect(resolved).toMatchObject({
      name: 'personal',
      maxConcurrency: 7,
      maxQueue: 3,
      queueTimeoutMs: 0,
    })
  })

  test('recognizes a Citty boolean cluster before a compact host override', async () => {
    const rawArgs = ['--preset', 'gateway-upstream', '-vH127.0.0.1']
    const argsDefinition = typeof start.args === 'function'
      ? await start.args()
      : await start.args
    if (!argsDefinition)
      throw new Error('Expected start command arguments')
    const args = parseArgs(rawArgs, argsDefinition)

    expect(Boolean(args.verbose)).toBe(true)
    expect(String(args.host)).toBe('127.0.0.1')
    expect(wasRunOptionPassed(rawArgs, 'host', 'H')).toBe(true)
    expect(resolveRunPreset('gateway-upstream', {
      ...(wasRunOptionPassed(rawArgs, 'host', 'H') && { host: String(args.host) }),
    }).host).toBe('127.0.0.1')
  })

  test('does not mistake a short string value for a clustered host option', () => {
    expect(wasRunOptionPassed(
      ['--preset', 'gateway-upstream', '-gghu_token_with_H_character'],
      'host',
      'H',
    )).toBe(false)
  })

  test('preserves a compact Citty host override over the selected preset', async () => {
    const rawArgs = ['--preset', 'personal', '-H0.0.0.0']
    const argsDefinition = typeof start.args === 'function'
      ? await start.args()
      : await start.args
    if (!argsDefinition)
      throw new Error('Expected start command arguments')
    const args = parseArgs(rawArgs, argsDefinition)
    const host = String(args.host)

    expect(host).toBe('0.0.0.0')
    expect(resolveRunPreset('personal', {
      ...(wasRunOptionPassed(rawArgs, 'host', 'H') && { host }),
    }).host).toBe('0.0.0.0')
  })

  test('requires an explicit non-loopback Host allowlist for gateway mode', () => {
    expect(gatewayPresetEnvironmentError('personal', {})).toBeUndefined()
    expect(gatewayPresetEnvironmentError('gateway-upstream', {
      COPILOT_PROXY_ALLOWED_HOSTS: 'copilot-proxy,proxy.internal',
    })).toBeUndefined()
    expect(gatewayPresetEnvironmentError('gateway-upstream', {
      COPILOT_PROXY_ALLOWED_HOSTS: 'localhost,192.0.2.10,[2001:db8::1]',
    })).toBeUndefined()
    expect(gatewayPresetEnvironmentError('gateway-upstream', {})).toContain('COPILOT_PROXY_ALLOWED_HOSTS')

    for (const loopbackOnlyOrMalformed of [
      '',
      ' , ',
      'localhost',
      'foo.localhost',
      '127.0.0.1',
      '[::1]',
      'https://proxy.internal',
      'proxy.internal:443',
      '[fe80::1%eth0]',
      '*.internal',
      'proxy.internal,',
    ]) {
      expect(gatewayPresetEnvironmentError('gateway-upstream', {
        COPILOT_PROXY_ALLOWED_HOSTS: loopbackOnlyOrMalformed,
      })).toContain('at least one non-loopback hostname or IP address')
    }
  })

  test('preserves every pre-preset start path unless a preset is explicit', () => {
    expect(selectStartPreset('custom', [], false)).toBe('custom')
    expect(selectStartPreset('custom', [], true)).toBe('custom')
    expect(selectStartPreset('custom', ['--max-concurrency', '8'], false)).toBe('custom')
    expect(selectStartPreset('custom', ['--max-queue=4'], false)).toBe('custom')
    expect(selectStartPreset('service', ['--preset', 'service'], true)).toBe('service')
  })
})
