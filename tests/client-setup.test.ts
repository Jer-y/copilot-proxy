import type { CodexClientCatalog, CodexCommandExecutor } from '~/lib/client-setup'
import type { Model } from '~/services/copilot/get-models'

import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'

import { assertCodexClientModelMetadata, assertSetupProbeSucceeded, buildClientSetupArtifact, buildSetupProbeRequest, compatibleModelsForClient, inspectCodexClientCatalog, modelSupportsEndpoint, modelSupportsResponsesWebSocket, resolveCodexProfilePaths, selectSetupModel } from '~/lib/client-setup'

function model(id: string, endpoints?: string[], options: Partial<Model> = {}): Model {
  return {
    id,
    name: id,
    vendor: id.startsWith('claude') ? 'Anthropic' : 'OpenAI',
    version: '1',
    object: 'model',
    preview: false,
    model_picker_enabled: true,
    ...(endpoints !== undefined && { supported_endpoints: endpoints }),
    capabilities: {
      family: id,
      limits: { max_context_window_tokens: 128_000, max_output_tokens: 16_000 },
      object: 'model_capabilities',
      supports: { tool_calls: true },
      tokenizer: 'test',
      type: 'chat',
    },
    ...options,
  }
}

const MODELS = [
  model('gpt-responses', ['/responses', 'ws:/responses']),
  model('gpt-chat', ['/chat/completions']),
  model('claude-direct', ['/v1/messages', '/chat/completions']),
]

const CODEX_CATALOG: CodexClientCatalog = {
  command: 'codex',
  modelSlugs: ['gpt-responses'],
  version: '0.144.6',
}
const testWindows = process.platform === 'win32' ? test : test.skip
const testPosix = process.platform === 'win32' ? test.skip : test
const testLiveCodexProfileIsolation = process.platform !== 'win32'
  && process.env.COPILOT_PROXY_LIVE_CODEX_PROFILE_ISOLATION === '1'
  ? test
  : test.skip

function decodePowerShellCommand(command: string): string {
  const encoded = command.split(' ').at(-1)
  if (!encoded)
    throw new Error('Encoded PowerShell command is missing')
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

function runWindowsLaunchCommand(
  shell: 'bash' | 'cmd' | 'powershell' | 'pwsh',
  command: string,
  env: NodeJS.ProcessEnv,
) {
  const executable = shell === 'bash'
    ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
    : shell === 'cmd'
      ? process.env.ComSpec || 'cmd.exe'
      : shell === 'pwsh' ? 'pwsh' : 'powershell.exe'
  const args = shell === 'bash'
    ? ['--noprofile', '--norc', '-c', command]
    : shell === 'cmd'
      ? ['/d', '/s', '/c', command]
      : [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Restricted',
          '-Command',
          command,
        ]
  return spawnSync(executable, args, {
    cwd: process.env.SystemRoot,
    encoding: 'utf8',
    env,
    windowsHide: true,
  })
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ status: number | null, stderr: string, stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let settled = false
    let stderr = ''
    let stdout = ''
    const timeout = setTimeout(() => {
      if (settled)
        return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`${command} did not finish within 20 seconds`))
    }, 20_000)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.once('error', (error) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (status) => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      resolve({ status, stderr, stdout })
    })
  })
}

describe('client setup planning', () => {
  test('selects only faithful direct models for Claude and Codex', () => {
    expect(compatibleModelsForClient('claude', MODELS).map(item => item.model.id)).toEqual(['claude-direct'])
    expect(compatibleModelsForClient('codex', MODELS).map(item => item.model.id)).toEqual(['gpt-responses'])
    expect(modelSupportsResponsesWebSocket(MODELS[0])).toBe(true)
  })

  test('keeps Codex selection on the intersection of live routes and installed client metadata', () => {
    const missingMetadata = model('gpt-5.3-codex', ['/responses', 'ws:/responses'])
    const candidates = [MODELS[0], missingMetadata]

    expect(compatibleModelsForClient('codex', candidates, CODEX_CATALOG)
      .map(item => item.model.id)).toEqual(['gpt-responses'])
    expect(() => selectSetupModel(
      'codex',
      candidates,
      missingMetadata.id,
      CODEX_CATALOG,
    )).toThrow('not a direct codex model')
    expect(() => assertCodexClientModelMetadata(missingMetadata.id, CODEX_CATALOG))
      .toThrow('bundled catalog has no usable metadata')
  })

  test('inspects the installed Codex version and bundled catalog without a network refresh', async () => {
    const calls: Array<{ args: string[], command: string }> = []
    const execute: CodexCommandExecutor = async (command, args) => {
      calls.push({ args, command })
      if (args[0] === '--version') {
        return { stderr: '', stdout: 'codex-cli 0.144.6\n' }
      }
      return {
        stderr: '',
        stdout: JSON.stringify({
          models: [
            {
              base_instructions: 'real bundled instructions',
              context_window: 272_000,
              slug: 'gpt-responses',
            },
            {
              base_instructions: '',
              context_window: 272_000,
              slug: 'missing-instructions',
            },
            {
              base_instructions: 'real bundled instructions',
              context_window: 0,
              slug: 'missing-context',
            },
          ],
        }),
      }
    }

    await expect(inspectCodexClientCatalog({ command: '/opt/codex', execute })).resolves.toEqual({
      command: '/opt/codex',
      modelSlugs: ['gpt-responses'],
      version: '0.144.6',
    })
    expect(calls).toEqual([
      { args: ['--version'], command: '/opt/codex' },
      { args: ['debug', 'models', '--bundled'], command: '/opt/codex' },
    ])
  })

  testPosix('does not expose launcher or provider credentials to Codex preflight', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-codex-preflight-env-'))
    const commandPath = path.join(fixtureRoot, 'codex')
    const secretKeys = [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'COPILOT_TOKEN',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'AZURE_OPENAI_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'DATABASE_URL',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
    ]
    const secretAssertions = secretKeys
      .map(key => `[ -z "\${${key}+x}" ] || exit 91`)
      .join('\n')
    fs.writeFileSync(commandPath, `#!/bin/sh
set -eu
${secretAssertions}
if [ "\${1:-}" = "--version" ]; then
  printf 'codex-cli 0.144.6\n'
elif [ "\${1:-}" = "debug" ] && [ "\${2:-}" = "models" ] && [ "\${3:-}" = "--bundled" ]; then
  printf '%s\n' '{"models":[{"slug":"gpt-safe","base_instructions":"safe","context_window":272000}]}'
else
  exit 64
fi
`, { mode: 0o700 })

    try {
      const secrets = Object.fromEntries(secretKeys.map(key => [key, `${key.toLowerCase()}-secret`]))
      await expect(inspectCodexClientCatalog({
        env: {
          ...process.env,
          ...secrets,
          CODEX_HOME: path.join(fixtureRoot, 'codex-home'),
          PATH: `${fixtureRoot}${path.delimiter}${process.env.PATH ?? ''}`,
        },
      })).resolves.toEqual({
        command: 'codex',
        modelSlugs: ['gpt-safe'],
        version: '0.144.6',
      })
    }
    finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true })
    }
  })

  test('reports missing, invalid, old, and catalog-failing Codex clients clearly', async () => {
    const missingCommand = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
    await expect(inspectCodexClientCatalog({
      execute: async () => await Promise.reject(missingCommand),
    })).rejects.toThrow('was not found on PATH')

    await expect(inspectCodexClientCatalog({
      execute: async () => ({ stderr: '', stdout: 'codex-cli unknown\n' }),
    })).rejects.toThrow('unrecognized version string')

    await expect(inspectCodexClientCatalog({
      execute: async () => ({ stderr: '', stdout: 'codex-cli 0.133.9\n' }),
    })).rejects.toThrow('too old')

    await expect(inspectCodexClientCatalog({
      execute: async (_command, args) => {
        if (args[0] === '--version')
          return { stderr: '', stdout: 'codex-cli 0.144.6\n' }
        throw new Error('catalog command failed')
      },
    })).rejects.toThrow('Failed to read the bundled model catalog')

    await expect(inspectCodexClientCatalog({
      execute: codexExecutorWithCatalog('not-json'),
    })).rejects.toThrow('invalid bundled model catalog JSON')

    await expect(inspectCodexClientCatalog({
      execute: codexExecutorWithCatalog(JSON.stringify({
        models: [{ slug: 'gpt-empty', base_instructions: '', context_window: 0 }],
      })),
    })).rejects.toThrow('contains no entries with usable base instructions and context metadata')
  })

  testWindows('resolves and safely executes an npm-style codex.cmd from PATH', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-codex-cmd-'))
    const fixtureDir = path.join(fixtureRoot, 'npm bin (safe)&meta')
    const commandName = 'codex-setup-path-probe'
    const scriptPath = path.join(fixtureDir, 'codex-stub.mjs')
    const commandPath = path.join(fixtureDir, `${commandName}.cmd`)
    fs.mkdirSync(fixtureDir)
    fs.writeFileSync(scriptPath, [
      `const args = process.argv.slice(2)`,
      `if (args[0] === '--version')`,
      `  console.log('codex-cli 0.144.6')`,
      `else if (JSON.stringify(args) === JSON.stringify(['debug', 'models', '--bundled']))`,
      `  console.log(JSON.stringify({ models: [{ slug: 'gpt-cmd', base_instructions: 'cmd instructions', context_window: 272000 }] }))`,
      `else`,
      `  process.exitCode = 64`,
    ].join('\n'))
    fs.writeFileSync(commandPath, [
      '@ECHO off',
      `"${process.execPath}" "%~dp0\\codex-stub.mjs" %*`,
    ].join('\r\n'))

    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
    const pathExtKey = Object.keys(process.env).find(key => key.toLowerCase() === 'pathext') ?? 'PATHEXT'
    const originalPath = process.env[pathKey]
    const originalPathExt = process.env[pathExtKey]
    try {
      process.env[pathKey] = fixtureDir
      process.env[pathExtKey] = '.COM;.EXE;.BAT;.CMD'
      await expect(inspectCodexClientCatalog({ command: commandName })).resolves.toEqual({
        command: commandName,
        modelSlugs: ['gpt-cmd'],
        version: '0.144.6',
      })
    }
    finally {
      if (originalPath === undefined)
        delete process.env[pathKey]
      else
        process.env[pathKey] = originalPath
      if (originalPathExt === undefined)
        delete process.env[pathExtKey]
      else
        process.env[pathExtKey] = originalPathExt
      fs.rmSync(fixtureRoot, { force: true, recursive: true })
    }
  })

  testWindows('launches isolated Codex with exact argv across native Windows and Git Bash shells', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-codex-launch-'))
    const fixtureDir = path.join(fixtureRoot, 'npm bin (safe)&meta')
    const scriptPath = path.join(fixtureDir, 'codex-stub.mjs')
    const configuredCodexHome = path.join(fixtureRoot, 'base Codex home (safe)&meta')
    const callerCodexHome = path.join(fixtureRoot, 'caller Codex home (safe)&meta')
    const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'Path'
    const originalPath = process.env[pathKey] ?? ''
    const escapedExecutable = process.execPath.replace(/'/g, `''`)

    fs.mkdirSync(fixtureDir)
    fs.writeFileSync(scriptPath, `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), codexHome: process.env.CODEX_HOME, shim: process.env.CODEX_TEST_SHIM }) + '\\n')\n`)
    fs.writeFileSync(path.join(fixtureDir, 'codex.cmd'), [
      '@ECHO off',
      'SETLOCAL',
      'SET "CODEX_TEST_SHIM=cmd"',
      `"${process.execPath}" "%~dp0\\codex-stub.mjs" %*`,
    ].join('\r\n'))
    fs.writeFileSync(path.join(fixtureDir, 'codex.ps1'), [
      '$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent',
      `$env:CODEX_TEST_SHIM = 'ps1'`,
      `& '${escapedExecutable}' "$basedir/codex-stub.mjs" $args`,
      'exit $LASTEXITCODE',
    ].join('\r\n'))
    const bashShimPath = path.join(fixtureDir, 'codex')
    fs.writeFileSync(bashShimPath, [
      '#!/usr/bin/env sh',
      `CODEX_TEST_SHIM=bash exec bun "$(dirname "$0")/codex-stub.mjs" "$@"`,
    ].join('\n'))
    fs.chmodSync(bashShimPath, 0o755)

    try {
      for (const shell of ['cmd', 'powershell', 'pwsh', 'bash'] as const) {
        const artifact = buildClientSetupArtifact({
          baseUrl: 'http://127.0.0.1:4399',
          choice: selectSetupModel('codex', MODELS),
          client: 'codex',
          codexCatalog: CODEX_CATALOG,
          pathOptions: {
            cwd: fixtureRoot,
            env: { CODEX_HOME: configuredCodexHome },
            homeDir: fixtureRoot,
            platform: 'win32',
          },
          runtimeCommand: 'node',
          shell,
        })
        if (!artifact.launchCommand)
          throw new Error(`Codex ${shell} setup artifact is missing its launch command`)
        expect(artifact.launchCommand.length).toBeLessThan(7_500)

        const callerProbeCommand = shell === 'cmd'
          ? `${artifact.launchCommand} & set CODEX_HOME`
          : shell === 'bash'
            ? `${artifact.launchCommand}; printf 'CODEX_HOME=%s\\n' "$CODEX_HOME"`
            : `${artifact.launchCommand}; [Console]::Out.WriteLine('CODEX_HOME=' + $env:CODEX_HOME)`

        const result = runWindowsLaunchCommand(shell, callerProbeCommand, {
          ...process.env,
          CODEX_HOME: callerCodexHome,
          [pathKey]: `${fixtureDir};${originalPath}`,
          PSExecutionPolicyPreference: 'Restricted',
        })

        expect({
          error: result.error?.message,
          shell,
          status: result.status,
          stderr: result.stderr,
        }).toEqual({
          error: undefined,
          shell,
          status: 0,
          stderr: '',
        })
        const [codexOutput, callerOutput] = result.stdout.trim().split(/\r?\n/)
        expect(codexOutput).toBe(JSON.stringify({
          args: ['--profile', 'copilot-proxy'],
          codexHome: path.join(configuredCodexHome, 'copilot-proxy-home'),
          shim: shell === 'bash' ? 'bash' : 'cmd',
        }))
        expect(callerOutput).toBe(`CODEX_HOME=${callerCodexHome}`)
      }
    }
    finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true })
    }
  }, 20_000)

  test('normalizes trailing slashes in HTTP and WebSocket endpoint metadata', () => {
    const trailingSlashModel = model('gpt-trailing-slash', [
      ' /V1/RESPONSES/ ',
      ' ws:/V1/RESPONSES/ ',
    ])

    const [choice] = compatibleModelsForClient('codex', [trailingSlashModel])
    expect(choice).toMatchObject({
      api: 'responses',
      model: { id: 'gpt-trailing-slash' },
      supportsWebSockets: true,
    })
  })

  test('falls back to bundled HTTP policy when live endpoints are missing or empty', () => {
    for (const fallbackModel of [
      model('gemini-3-flash-preview'),
      model('gemini-3-flash-preview', []),
    ]) {
      expect(modelSupportsEndpoint(fallbackModel, 'chat-completions')).toBe(true)
      expect(selectSetupModel('openai-sdk', [fallbackModel], fallbackModel.id)).toMatchObject({
        api: 'chat-completions',
        model: { id: 'gemini-3-flash-preview' },
        supportsWebSockets: false,
      })
    }
  })

  test('keeps non-empty live endpoints authoritative over bundled HTTP policy', () => {
    const explicitlyUnsupported = model('gemini-3-flash-preview', ['/embeddings'])

    expect(modelSupportsEndpoint(explicitlyUnsupported, 'chat-completions')).toBe(false)
    expect(() => selectSetupModel('openai-sdk', [explicitlyUnsupported], explicitlyUnsupported.id)).toThrow('No current Copilot model')
  })

  test('never infers Responses WebSocket support from bundled HTTP policy', () => {
    for (const fallbackModel of [
      model('gpt-5.5'),
      model('gpt-5.5', []),
    ]) {
      expect(modelSupportsEndpoint(fallbackModel, 'responses')).toBe(true)
      expect(selectSetupModel('codex', [fallbackModel], fallbackModel.id)).toMatchObject({
        api: 'responses',
        supportsWebSockets: false,
      })
      expect(modelSupportsResponsesWebSocket(fallbackModel)).toBe(false)
    }
  })

  test('prefers Responses for an OpenAI SDK and falls back to Chat Completions', () => {
    expect(selectSetupModel('openai-sdk', MODELS).api).toBe('responses')
    expect(selectSetupModel('openai-sdk', MODELS, 'gpt-chat').api).toBe('chat-completions')
    expect(selectSetupModel('openai-sdk', [MODELS[1]]).api).toBe('chat-completions')
  })

  test('deduplicates dual-endpoint OpenAI SDK models and preserves Responses priority', () => {
    const dualEndpoint = model('gpt-dual', ['/responses', '/chat/completions', 'ws:/responses'])

    expect(compatibleModelsForClient('openai-sdk', [dualEndpoint])).toEqual([
      {
        api: 'responses',
        model: dualEndpoint,
        supportsWebSockets: true,
      },
    ])
    expect(selectSetupModel('openai-sdk', [dualEndpoint], dualEndpoint.id).api).toBe('responses')
  })

  test('rejects requested models that require translation', () => {
    expect(() => selectSetupModel('claude', MODELS, 'gpt-responses')).toThrow('not a direct claude model')
    expect(() => selectSetupModel('codex', [MODELS[2]])).toThrow('No current Copilot model')
  })

  test('builds semantic probe requests for every client API', () => {
    expect(buildSetupProbeRequest(selectSetupModel('claude', MODELS))).toMatchObject({
      path: '/v1/messages',
      body: { max_tokens: 512 },
    })
    expect(buildSetupProbeRequest(selectSetupModel('codex', MODELS))).toMatchObject({
      path: '/v1/responses',
      body: { max_output_tokens: 512, store: false },
    })
    expect(buildSetupProbeRequest(selectSetupModel('openai-sdk', [MODELS[1]]))).toMatchObject({
      path: '/v1/chat/completions',
      body: { max_tokens: 512 },
    })
  })

  test('requires the exact semantic sentinel from each response shape', () => {
    expect(() => assertSetupProbeSucceeded('anthropic-messages', {
      content: [{ type: 'text', text: ' \nCOPILOT_PROXY_SETUP_OK\t' }],
    })).not.toThrow()
    expect(() => assertSetupProbeSucceeded('responses', {
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: 'COPILOT_PROXY_SETUP_OK' }] }],
    })).not.toThrow()
    expect(() => assertSetupProbeSucceeded('chat-completions', {
      choices: [{ message: { content: 'COPILOT_PROXY_SETUP_OK' } }],
    })).not.toThrow()
    for (const status of ['failed', 'incomplete', 'queued']) {
      expect(() => assertSetupProbeSucceeded('responses', {
        status,
        output_text: 'COPILOT_PROXY_SETUP_OK',
      })).toThrow('did not reach completed status')
    }
    expect(() => assertSetupProbeSucceeded('responses', { status: 'completed', output_text: 'wrong' })).toThrow('required COPILOT_PROXY_SETUP_OK')
    expect(() => assertSetupProbeSucceeded('chat-completions', {
      choices: [{ message: { content: 'I refuse to reply exactly with COPILOT_PROXY_SETUP_OK.' } }],
    })).toThrow('required COPILOT_PROXY_SETUP_OK')
  })

  test('generates current Claude, Codex, and SDK configuration', () => {
    const claude = buildClientSetupArtifact({
      baseUrl: 'http://127.0.0.1:4399',
      choice: selectSetupModel('claude', MODELS),
      client: 'claude',
      shell: 'bash',
    })
    expect(claude.content).toStartWith(`'claude' '--settings'`)
    expect(claude.content).toContain('"ANTHROPIC_BASE_URL":"http://127.0.0.1:4399"')
    expect(claude.content).toContain('"ANTHROPIC_DEFAULT_OPUS_MODEL":"claude-direct"')
    expect(claude.notes.join(' ')).toContain('does not edit ~/.claude/settings.json')

    const codex = buildClientSetupArtifact({
      baseUrl: 'http://127.0.0.1:4399',
      choice: selectSetupModel('codex', MODELS),
      client: 'codex',
      codexCatalog: CODEX_CATALOG,
      shell: 'bash',
      pathOptions: {
        env: {},
        homeDir: '/home/test',
        platform: 'linux',
      },
      runtimeCommand: 'node',
    })
    expect(codex.content).toContain('wire_api = "responses"')
    expect(codex.content).toContain('supports_websockets = true')
    expect(codex.content).toContain('[model_providers.copilot-proxy.auth]')
    expect(codex.content).toContain('command = "node"')
    expect(codex.content).toContain(`args = ["-e", "process.stdout.write('dummy')"]`)
    expect(codex.content).not.toContain('env_key')
    expect(codex.suggestedPath).toBe('/home/test/.codex/copilot-proxy-home/copilot-proxy.config.toml')
    expect(codex.launchCommand).toBe(`'env' 'CODEX_HOME=/home/test/.codex/copilot-proxy-home' 'codex' '--profile' 'copilot-proxy'`)
    expect(codex.notes.join(' ')).toContain('Do not append it to /home/test/.codex/config.toml')
    expect(codex.notes.join(' ')).toContain('/home/test/.codex/copilot-proxy.config.toml')
    expect(codex.notes.join(' ')).toContain('/home/test/.codex/copilot-proxy-home/config.toml')
    expect(codex.notes).toContain('This is normal-home base-config isolation, not full Codex config isolation. A trusted current project\'s .codex/config.toml and the system /etc/codex/config.toml can still override model_catalog_json or [model_providers.copilot-proxy]; remove conflicting settings from those higher-priority layers.')
    expect(codex.notes).toContain('If Codex does not request the proxy /v1/models catalog or reports a model metadata fallback, check the current project\'s .codex/config.toml and /etc/codex/config.toml for a conflicting model_catalog_json or copilot-proxy provider definition.')
    expect(codex.notes.join(' ')).toContain('Codex 0.134.0 or newer')
    expect(codex.notes.join(' ')).toContain('installed Codex 0.144.6')

    const sdk = buildClientSetupArtifact({
      baseUrl: 'http://127.0.0.1:4399',
      choice: selectSetupModel('openai-sdk', MODELS),
      client: 'openai-sdk',
      shell: 'bash',
    })
    expect(sdk.content).toContain('OPENAI_BASE_URL=\'http://127.0.0.1:4399/v1\'')
  })

  testPosix('keeps a conflicting user base config outside the generated Codex launch', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-codex-isolation-'))
    const codexHome = path.join(fixtureRoot, 'user Codex home (safe)&meta')
    const binDir = path.join(fixtureRoot, 'bin')
    const baseConfigPath = path.join(codexHome, 'config.toml')
    const baseConfig = [
      'model_catalog_json = "/user-owned/catalog.json"',
      '',
      '[model_providers.copilot-proxy]',
      'env_key = "USER_OWNED_TOKEN"',
      '',
    ].join('\n')
    fs.mkdirSync(binDir, { recursive: true })
    fs.mkdirSync(codexHome, { recursive: true })
    fs.writeFileSync(baseConfigPath, baseConfig)
    const codexStub = path.join(binDir, 'codex')
    fs.writeFileSync(codexStub, [
      '#!/usr/bin/env node',
      `process.stdout.write(JSON.stringify({ args: process.argv.slice(2), codexHome: process.env.CODEX_HOME }))`,
    ].join('\n'))
    fs.chmodSync(codexStub, 0o755)

    try {
      const artifact = buildClientSetupArtifact({
        baseUrl: 'http://127.0.0.1:4399',
        choice: selectSetupModel('codex', MODELS),
        client: 'codex',
        codexCatalog: CODEX_CATALOG,
        pathOptions: {
          env: { CODEX_HOME: codexHome },
          homeDir: fixtureRoot,
          platform: process.platform,
        },
        runtimeCommand: 'node',
        shell: 'bash',
      })
      if (!artifact.launchCommand || !artifact.suggestedPath)
        throw new Error('Codex setup artifact is incomplete')
      fs.mkdirSync(path.dirname(artifact.suggestedPath), { recursive: true })
      fs.writeFileSync(artifact.suggestedPath, artifact.content)

      const result = spawnSync('bash', ['-c', artifact.launchCommand], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          USER_OWNED_TOKEN: 'must-not-be-used',
        },
      })

      expect({
        error: result.error?.message,
        status: result.status,
        stderr: result.stderr,
      }).toEqual({
        error: undefined,
        status: 0,
        stderr: '',
      })
      expect(JSON.parse(result.stdout)).toEqual({
        args: ['--profile', 'copilot-proxy'],
        codexHome: path.join(codexHome, 'copilot-proxy-home'),
      })
      expect(fs.readFileSync(baseConfigPath, 'utf8')).toBe(baseConfig)
    }
    finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true })
    }
  })

  test('refuses to merge an unexpected base config inside the dedicated Codex home', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-codex-isolated-base-'))
    const codexHome = path.join(fixtureRoot, 'codex')
    const isolatedBaseConfig = path.join(codexHome, 'copilot-proxy-home', 'config.toml')
    fs.mkdirSync(path.dirname(isolatedBaseConfig), { recursive: true })
    fs.writeFileSync(isolatedBaseConfig, 'model_catalog_json = "/unexpected/catalog.json"\n')

    try {
      expect(() => buildClientSetupArtifact({
        baseUrl: 'http://127.0.0.1:4399',
        choice: selectSetupModel('codex', MODELS),
        client: 'codex',
        codexCatalog: CODEX_CATALOG,
        pathOptions: {
          env: { CODEX_HOME: codexHome },
          homeDir: fixtureRoot,
          platform: process.platform,
        },
        runtimeCommand: 'node',
        shell: 'bash',
      })).toThrow(`Cannot generate an isolated Codex profile while ${isolatedBaseConfig} exists`)
      expect(fs.readFileSync(isolatedBaseConfig, 'utf8')).toBe('model_catalog_json = "/unexpected/catalog.json"\n')
    }
    finally {
      fs.rmSync(fixtureRoot, { force: true, recursive: true })
    }
  })

  testLiveCodexProfileIsolation('loads the generated isolated profile with a real Codex catalog refresh', async () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-live-codex-isolation-'))
    const userCodexHome = path.join(fixtureRoot, 'user-codex-home')
    const bundledResult = spawnSync('codex', ['debug', 'models', '--bundled'], {
      encoding: 'utf8',
    })
    expect(bundledResult.status).toBe(0)
    const bundledCatalog = JSON.parse(bundledResult.stdout) as {
      models: Array<Record<string, unknown> & { slug?: string }>
    }
    const installedCatalog = await inspectCodexClientCatalog()
    const selectedModel = installedCatalog.modelSlugs.find(slug => (
      bundledCatalog.models.some(item => item.slug === slug)
    ))
    if (!selectedModel)
      throw new Error('Installed Codex bundled catalog has no model slug for the live isolation test')

    const catalogRequests: Array<{ authorization?: string, status: number, url: string }> = []
    let responsesRequests = 0
    const catalogServer = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method === 'GET' && requestUrl.pathname === '/v1/models') {
        catalogRequests.push({
          ...(typeof request.headers.authorization === 'string' && { authorization: request.headers.authorization }),
          status: 200,
          url: requestUrl.pathname + requestUrl.search,
        })
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(bundledResult.stdout)
        return
      }
      if (request.method === 'POST' && requestUrl.pathname === '/v1/responses') {
        responsesRequests++
        request.resume()
        const outputText = 'CODEX_PROFILE_ISOLATION_OK'
        const message = {
          id: 'msg_profile_isolation',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: outputText,
            annotations: [],
            logprobs: [],
          }],
        }
        const completedResponse = {
          id: 'resp_profile_isolation',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          error: null,
          incomplete_details: null,
          instructions: null,
          max_output_tokens: null,
          model: selectedModel,
          output: [message],
          parallel_tool_calls: true,
          previous_response_id: null,
          reasoning: { effort: 'medium', summary: null },
          store: false,
          temperature: 1,
          text: { format: { type: 'text' } },
          tool_choice: 'auto',
          tools: [],
          top_p: 1,
          truncation: 'disabled',
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }
        const inProgressResponse = {
          ...completedResponse,
          status: 'in_progress',
          output: [],
        }
        const frames = [
          { type: 'response.created', sequence_number: 0, response: inProgressResponse },
          { type: 'response.in_progress', sequence_number: 1, response: inProgressResponse },
          {
            type: 'response.output_item.added',
            sequence_number: 2,
            output_index: 0,
            item: { ...message, status: 'in_progress', content: [] },
          },
          {
            type: 'response.content_part.added',
            sequence_number: 3,
            output_index: 0,
            content_index: 0,
            item_id: message.id,
            part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
          },
          {
            type: 'response.output_text.delta',
            sequence_number: 4,
            output_index: 0,
            content_index: 0,
            item_id: message.id,
            delta: outputText,
            logprobs: [],
          },
          {
            type: 'response.output_text.done',
            sequence_number: 5,
            output_index: 0,
            content_index: 0,
            item_id: message.id,
            text: outputText,
            logprobs: [],
          },
          {
            type: 'response.content_part.done',
            sequence_number: 6,
            output_index: 0,
            content_index: 0,
            item_id: message.id,
            part: message.content[0],
          },
          {
            type: 'response.output_item.done',
            sequence_number: 7,
            output_index: 0,
            item: message,
          },
          { type: 'response.completed', sequence_number: 8, response: completedResponse },
        ]
        response.writeHead(200, {
          'Cache-Control': 'no-cache',
          'Content-Type': 'text/event-stream',
        })
        for (const frame of frames)
          response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
        response.end()
        return
      }
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end('{"error":{"message":"unexpected live isolation test route"}}')
    })

    try {
      await new Promise<void>((resolve, reject) => {
        catalogServer.once('error', reject)
        catalogServer.listen(0, '127.0.0.1', resolve)
      })
      const address = catalogServer.address()
      if (!address || typeof address === 'string')
        throw new Error('Live Codex isolation server did not expose a TCP address')

      fs.mkdirSync(userCodexHome, { recursive: true })
      const poisonedCatalogPath = path.join(fixtureRoot, 'base-only-catalog.json')
      const poisonedModel = {
        ...bundledCatalog.models[0],
        slug: 'base-config-only-model',
      }
      fs.writeFileSync(poisonedCatalogPath, JSON.stringify({ models: [poisonedModel] }))
      const userBaseConfig = [
        `model_catalog_json = ${JSON.stringify(poisonedCatalogPath)}`,
        '',
        '[model_providers.copilot-proxy]',
        'name = "conflicting user provider"',
        'base_url = "http://127.0.0.1:1/v1"',
        'wire_api = "responses"',
        'env_key = "USER_OWNED_TOKEN"',
        '',
      ].join('\n')
      const userBaseConfigPath = path.join(userCodexHome, 'config.toml')
      fs.writeFileSync(userBaseConfigPath, userBaseConfig)

      const artifact = buildClientSetupArtifact({
        baseUrl: `http://127.0.0.1:${address.port}`,
        choice: {
          api: 'responses',
          model: model(selectedModel, ['/responses']),
          supportsWebSockets: false,
        },
        client: 'codex',
        codexCatalog: installedCatalog,
        pathOptions: {
          env: { CODEX_HOME: userCodexHome },
          homeDir: fixtureRoot,
          platform: process.platform,
        },
        runtimeCommand: 'node',
        shell: 'bash',
      })
      if (!artifact.launchCommand || !artifact.suggestedPath)
        throw new Error('Live Codex setup artifact is incomplete')
      fs.mkdirSync(path.dirname(artifact.suggestedPath), { recursive: true })
      fs.writeFileSync(artifact.suggestedPath, artifact.content)

      const result = await runCommand('bash', ['-c', `${artifact.launchCommand} exec --skip-git-repo-check --json 'Reply with exactly CODEX_PROFILE_ISOLATION_OK.'`], {
        ...process.env,
        CODEX_HOME: userCodexHome,
        USER_OWNED_TOKEN: 'must-not-be-used',
      }, fixtureRoot)
      if (result.status !== 0) {
        throw new Error(
          `Generated Codex launch exited ${String(result.status)}: ${result.stderr || result.stdout}`,
        )
      }
      expect(result.status).toBe(0)
      const combinedOutput = `${result.stderr}\n${result.stdout}`
      expect(combinedOutput).not.toMatch(/auth cannot be combined with env_key/i)
      expect(combinedOutput).not.toMatch(/model metadata.*not found|defaulting to fallback metadata|metadata fallback/i)
      expect(result.stdout).toContain('CODEX_PROFILE_ISOLATION_OK')
      expect(responsesRequests).toBe(1)
      expect(catalogRequests.length).toBeGreaterThan(0)
      for (const request of catalogRequests) {
        expect(request).toEqual({
          authorization: 'Bearer dummy',
          status: 200,
          url: `/v1/models?client_version=${installedCatalog.version}`,
        })
      }
      expect(result.stdout).not.toContain('base-config-only-model')
      expect(fs.readFileSync(userBaseConfigPath, 'utf8')).toBe(userBaseConfig)
    }
    finally {
      await new Promise<void>((resolve) => {
        catalogServer.close(() => resolve())
      })
      fs.rmSync(fixtureRoot, { force: true, recursive: true })
    }
  }, 30_000)

  test('resolves Codex profile paths from CODEX_HOME or the platform home', () => {
    expect(resolveCodexProfilePaths('copilot-proxy', {
      cwd: '/work',
      env: { CODEX_HOME: '/var/lib/codex' },
      homeDir: '/home/test',
      platform: 'linux',
    })).toEqual({
      baseConfigPath: '/var/lib/codex/config.toml',
      isolatedBaseConfigPath: '/var/lib/codex/copilot-proxy-home/config.toml',
      isolatedHomePath: '/var/lib/codex/copilot-proxy-home',
      legacyProfilePath: '/var/lib/codex/copilot-proxy.config.toml',
      suggestedPath: '/var/lib/codex/copilot-proxy-home/copilot-proxy.config.toml',
    })

    expect(resolveCodexProfilePaths('copilot-proxy', {
      cwd: 'C:\\work',
      env: {},
      homeDir: 'C:\\Users\\Test User',
      platform: 'win32',
    })).toEqual({
      baseConfigPath: 'C:\\Users\\Test User\\.codex\\config.toml',
      isolatedBaseConfigPath: 'C:\\Users\\Test User\\.codex\\copilot-proxy-home\\config.toml',
      isolatedHomePath: 'C:\\Users\\Test User\\.codex\\copilot-proxy-home',
      legacyProfilePath: 'C:\\Users\\Test User\\.codex\\copilot-proxy.config.toml',
      suggestedPath: 'C:\\Users\\Test User\\.codex\\copilot-proxy-home\\copilot-proxy.config.toml',
    })

    expect(resolveCodexProfilePaths('copilot-proxy', {
      cwd: 'C:\\work',
      env: { CODEX_HOME: 'D:\\Codex Data' },
      homeDir: 'C:\\Users\\Test User',
      platform: 'win32',
    }).suggestedPath).toBe('D:\\Codex Data\\copilot-proxy-home\\copilot-proxy.config.toml')

    expect(resolveCodexProfilePaths('copilot-proxy', {
      cwd: 'C:\\work',
      env: {
        HOME: '/c/Users/Wrong',
        USERPROFILE: 'C:\\Users\\Correct',
      },
      platform: 'win32',
    }).suggestedPath).toBe('C:\\Users\\Correct\\.codex\\copilot-proxy-home\\copilot-proxy.config.toml')
  })

  test('keeps the generated Codex profile filename aligned with --profile', () => {
    const codex = buildClientSetupArtifact({
      baseUrl: 'http://127.0.0.1:4399',
      choice: selectSetupModel('codex', MODELS),
      client: 'codex',
      codexCatalog: CODEX_CATALOG,
      pathOptions: {
        cwd: 'C:\\work',
        env: { CODEX_HOME: 'D:\\Codex Data' },
        homeDir: 'C:\\Users\\Test User',
        platform: 'win32',
      },
      runtimeCommand: 'node',
      shell: 'powershell',
    })

    expect(codex.suggestedPath).toBe('D:\\Codex Data\\copilot-proxy-home\\copilot-proxy.config.toml')
    if (!codex.launchCommand)
      throw new Error('Codex setup artifact is missing its launch command')
    expect(codex.launchCommand.length).toBeLessThan(7_500)
    const environmentScript = decodePowerShellCommand(codex.launchCommand)
    expect(environmentScript).toContain(`$env:CODEX_HOME = 'D:\\Codex Data\\copilot-proxy-home'`)
    expect(environmentScript).toContain(`$command = 'codex --profile copilot-proxy'`)
    expect(environmentScript).toContain(`& $env:ComSpec '/d' '/s' '/c' $command`)
    expect(environmentScript).not.toContain('-EncodedCommand')
    expect(codex.notes.join(' ')).toContain('D:\\Codex Data\\config.toml')
    expect(codex.notes.join(' ')).toContain('D:\\Codex Data\\copilot-proxy.config.toml')
    expect(codex.content).toContain('command = "node"')

    const bunCodex = buildClientSetupArtifact({
      baseUrl: 'http://127.0.0.1:4399',
      choice: selectSetupModel('codex', MODELS),
      client: 'codex',
      codexCatalog: CODEX_CATALOG,
      runtimeCommand: 'bun',
      shell: 'bash',
    })
    expect(bunCodex.content).toContain('command = "bun"')
    expect(bunCodex.notes.join(' ')).toContain('bun on PATH')
  })
})

function codexExecutorWithCatalog(catalog: string): CodexCommandExecutor {
  return async (_command, args) => args[0] === '--version'
    ? { stderr: '', stdout: 'codex-cli 0.144.6\n' }
    : { stderr: '', stdout: catalog }
}
