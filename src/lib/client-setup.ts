import type { ShellName } from './shell'
import type { Model } from '~/services/copilot/get-models'

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { getBundledModelConfig } from '~/lib/model-config'
import { getUserHomeDir } from '~/lib/paths'
import { toAnthropicClientModelName } from '~/routes/messages/model-normalization'
import { generateEnvScript, generateShellCommand } from './shell'

export const SETUP_CLIENTS = ['claude', 'codex', 'openai-sdk'] as const

export type SetupClient = typeof SETUP_CLIENTS[number]
export type SetupProbeApi = 'anthropic-messages' | 'chat-completions' | 'responses'

export interface SetupModelChoice {
  api: SetupProbeApi
  model: Model
  supportsWebSockets: boolean
}

export interface ClientSetupArtifact {
  client: SetupClient
  content: string
  format: 'env-command' | 'toml'
  launchCommand?: string
  notes: string[]
  suggestedPath?: string
}

export interface ClientSetupPathOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  platform?: NodeJS.Platform
}

export interface CodexProfilePaths {
  baseConfigPath: string
  isolatedBaseConfigPath: string
  isolatedHomePath: string
  legacyProfilePath: string
  suggestedPath: string
}

export interface SetupProbeRequest {
  body: Record<string, unknown>
  path: '/v1/chat/completions' | '/v1/messages' | '/v1/responses'
}

export interface CodexClientCatalog {
  command: string
  modelSlugs: string[]
  version: string
}

export interface CodexCommandResult {
  stderr: string
  stdout: string
}

export type CodexCommandExecutor = (
  command: string,
  args: string[],
) => Promise<CodexCommandResult>

const SETUP_SENTINEL = 'COPILOT_PROXY_SETUP_OK'
export const MINIMUM_CODEX_SETUP_VERSION = '0.134.0'
const CODEX_COMMAND_TIMEOUT_MS = 10_000
const CODEX_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set(['.bat', '.cmd', '.com', '.exe'])
const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g
const CODEX_INSPECTION_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'BUN_INSTALL',
  'BUN_INSTALL_BIN',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
] as const

export function isSetupClient(value: string): value is SetupClient {
  return SETUP_CLIENTS.includes(value as SetupClient)
}

export function modelSupportsEndpoint(model: Model, endpoint: SetupProbeApi): boolean {
  const liveEndpoints = model.supported_endpoints
  if (!liveEndpoints?.length)
    return getBundledModelConfig(model.id).supportedApis.includes(endpoint)

  return liveEndpoints.some((raw) => {
    const normalized = raw.trim().toLowerCase().replace(/^https?:/, '').replace(/^\/+/, '').replace(/^v1\//, '').replace(/\/+$/, '')
    if (/^wss?:/.test(raw.trim().toLowerCase()))
      return false
    if (endpoint === 'anthropic-messages')
      return normalized === 'messages'
    if (endpoint === 'chat-completions')
      return normalized === 'chat/completions'
    return normalized === 'responses'
  })
}

export function modelSupportsResponsesWebSocket(model: Model): boolean {
  return model.supported_endpoints?.some((raw) => {
    const normalized = raw.trim().toLowerCase().replace(/^wss?:/, '').replace(/^\/+/, '').replace(/^v1\//, '').replace(/\/+$/, '')
    return /^wss?:/.test(raw.trim().toLowerCase()) && normalized === 'responses'
  }) ?? false
}

export function compatibleModelsForClient(
  client: SetupClient,
  models: Model[],
  codexCatalog?: CodexClientCatalog,
): SetupModelChoice[] {
  const candidates = models.filter(model => model.model_picker_enabled !== false)
  if (client === 'claude') {
    return candidates
      .filter(model => modelSupportsEndpoint(model, 'anthropic-messages'))
      .map(model => ({ api: 'anthropic-messages', model, supportsWebSockets: false }))
  }

  const responses = candidates
    .filter(model => modelSupportsEndpoint(model, 'responses'))
    .map(model => ({
      api: 'responses' as const,
      model,
      supportsWebSockets: modelSupportsResponsesWebSocket(model),
    }))
  if (client === 'codex') {
    if (!codexCatalog)
      return responses

    const codexModels = new Set(codexCatalog.modelSlugs)
    return responses.filter(choice => codexModels.has(choice.model.id))
  }

  const chatCompletions = candidates
    .filter(model => modelSupportsEndpoint(model, 'chat-completions'))
    .map(model => ({ api: 'chat-completions' as const, model, supportsWebSockets: false }))
  const seenModelIds = new Set<string>()
  return [...responses, ...chatCompletions].filter((choice) => {
    if (seenModelIds.has(choice.model.id))
      return false
    seenModelIds.add(choice.model.id)
    return true
  })
}

export function selectSetupModel(
  client: SetupClient,
  models: Model[],
  requestedModel?: string,
  codexCatalog?: CodexClientCatalog,
): SetupModelChoice {
  const compatible = compatibleModelsForClient(client, models, codexCatalog)
  if (compatible.length === 0)
    throw new Error(`No current Copilot model can serve ${client} through a faithful direct route.`)

  if (requestedModel) {
    const selected = compatible.find(choice => choice.model.id === requestedModel)
    if (!selected)
      throw new Error(`Model ${requestedModel} is not a direct ${client} model in the current Copilot catalog.`)
    return selected
  }

  return compatible.find(choice => !choice.model.preview) ?? compatible[0]
}

export async function inspectCodexClientCatalog(options: {
  command?: string
  env?: NodeJS.ProcessEnv
  execute?: CodexCommandExecutor
} = {}): Promise<CodexClientCatalog> {
  const command = options.command ?? 'codex'
  const execute = options.execute
    ?? ((executable, args) => executeCodexCommand(executable, args, options.env))
  let versionResult: CodexCommandResult
  try {
    versionResult = await execute(command, ['--version'])
  }
  catch (error) {
    if (isMissingCommandError(error)) {
      throw new Error(
        `Codex executable ${JSON.stringify(command)} was not found on PATH. setup codex requires Codex ${MINIMUM_CODEX_SETUP_VERSION} or newer so it can validate the target client's bundled model metadata.`,
        { cause: error },
      )
    }
    throw new Error(
      `Failed to run ${command} --version while validating the target Codex client: ${errorMessage(error)}.`,
      { cause: error },
    )
  }

  const version = parseCodexVersion(versionResult.stdout)
  if (!version) {
    throw new Error(
      `Codex returned an unrecognized version string ${JSON.stringify(versionResult.stdout.trim())}; expected codex-cli <major>.<minor>.<patch>.`,
    )
  }
  if (!isCodexVersionAtLeast(version, MINIMUM_CODEX_SETUP_VERSION)) {
    throw new Error(
      `Installed Codex ${version} is too old for the generated standalone profile; setup codex requires Codex ${MINIMUM_CODEX_SETUP_VERSION} or newer.`,
    )
  }

  let catalogResult: CodexCommandResult
  try {
    catalogResult = await execute(command, ['debug', 'models', '--bundled'])
  }
  catch (error) {
    throw new Error(
      `Failed to read the bundled model catalog from Codex ${version} with ${command} debug models --bundled: ${errorMessage(error)}.`,
      { cause: error },
    )
  }

  const modelSlugs = parseUsableCodexModelSlugs(catalogResult.stdout, version)
  return { command, modelSlugs, version }
}

export function assertCodexClientModelMetadata(
  model: string,
  catalog: CodexClientCatalog,
): void {
  if (catalog.modelSlugs.includes(model))
    return

  throw new Error(
    `Model ${model} cannot be configured for installed Codex ${catalog.version}: its bundled catalog has no usable metadata for that slug. Choose a model listed by both the current Copilot catalog and ${catalog.command} debug models --bundled.`,
  )
}

export function buildSetupProbeRequest(choice: SetupModelChoice): SetupProbeRequest {
  if (choice.api === 'anthropic-messages') {
    return {
      path: '/v1/messages',
      body: {
        model: choice.model.id,
        max_tokens: 512,
        messages: [{ role: 'user', content: `Reply with exactly ${SETUP_SENTINEL}.` }],
      },
    }
  }

  if (choice.api === 'chat-completions') {
    return {
      path: '/v1/chat/completions',
      body: {
        model: choice.model.id,
        max_tokens: 512,
        messages: [{ role: 'user', content: `Reply with exactly ${SETUP_SENTINEL}.` }],
      },
    }
  }

  return {
    path: '/v1/responses',
    body: {
      model: choice.model.id,
      input: `Reply with exactly ${SETUP_SENTINEL}.`,
      // Reasoning models may spend a small output budget before emitting text.
      // Keep setup bounded while leaving enough room for the semantic sentinel.
      max_output_tokens: 512,
      store: false,
    },
  }
}

export function assertSetupProbeSucceeded(api: SetupProbeApi, response: unknown): void {
  if (api === 'responses') {
    if (!response || typeof response !== 'object' || Array.isArray(response) || (response as Record<string, unknown>).status !== 'completed')
      throw new Error('The setup Responses probe did not reach completed status.')
  }
  const text = extractSetupProbeText(api, response)
  if (text.trim() !== SETUP_SENTINEL)
    throw new Error(`The setup probe completed without the required ${SETUP_SENTINEL} response.`)
}

export function buildClaudeLaunchCommand(options: {
  baseUrl: string
  model: string
  shell?: ShellName
  smallModel: string
}): string {
  const env = {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: 'dummy',
    ANTHROPIC_MODEL: options.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: options.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: options.model,
    ANTHROPIC_SMALL_FAST_MODEL: options.smallModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: options.smallModel,
    DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  }
  return generateShellCommand(
    'claude',
    ['--settings', JSON.stringify({ env })],
    { shell: options.shell },
  )
}

export function buildClientSetupArtifact(options: {
  baseUrl: string
  choice: SetupModelChoice
  client: SetupClient
  codexCatalog?: CodexClientCatalog
  pathOptions?: ClientSetupPathOptions
  runtimeCommand?: 'bun' | 'node'
  shell?: ShellName
  smallModel?: string
}): ClientSetupArtifact {
  const apiBaseUrl = `${options.baseUrl}/v1`
  if (options.client === 'claude') {
    const model = toAnthropicClientModelName(options.choice.model.id)
    const smallModel = toAnthropicClientModelName(options.smallModel ?? options.choice.model.id)
    const command = buildClaudeLaunchCommand({
      baseUrl: options.baseUrl,
      model,
      shell: options.shell,
      smallModel,
    })
    return {
      client: options.client,
      content: command,
      format: 'env-command',
      launchCommand: command,
      notes: [
        'This launch command does not edit ~/.claude/settings.json.',
        'Launch Claude Code only after the proxy is ready.',
      ],
    }
  }

  if (options.client === 'codex') {
    if (!options.codexCatalog)
      throw new Error('Codex setup artifact generation requires validated bundled client metadata.')
    assertCodexClientModelMetadata(options.choice.model.id, options.codexCatalog)
    const profileName = 'copilot-proxy'
    const {
      baseConfigPath,
      isolatedBaseConfigPath,
      isolatedHomePath,
      legacyProfilePath,
      suggestedPath,
    } = resolveCodexProfilePaths(
      profileName,
      options.pathOptions,
    )
    if (fs.existsSync(isolatedBaseConfigPath)) {
      throw new Error(
        `Cannot generate an isolated Codex profile while ${isolatedBaseConfigPath} exists. Move or remove that dedicated-home base config first; setup will not read or modify it.`,
      )
    }
    const launchCommand = buildIsolatedCodexLaunchCommand(
      profileName,
      isolatedHomePath,
      options.shell,
      options.pathOptions?.platform ?? process.platform,
    )
    const runtimeCommand = options.runtimeCommand
      ?? (typeof process.versions.bun === 'string' ? 'bun' : 'node')
    const authScript = `process.stdout.write('dummy')`
    const content = [
      `model = ${quoteToml(options.choice.model.id)}`,
      'model_provider = "copilot-proxy"',
      '',
      '[model_providers.copilot-proxy]',
      'name = "GitHub Copilot via copilot-proxy"',
      `base_url = ${quoteToml(apiBaseUrl)}`,
      'wire_api = "responses"',
      `supports_websockets = ${options.choice.supportsWebSockets}`,
      '',
      '[model_providers.copilot-proxy.auth]',
      `command = ${quoteToml(runtimeCommand)}`,
      `args = ["-e", ${quoteToml(authScript)}]`,
    ].join('\n')
    return {
      client: options.client,
      content,
      format: 'toml',
      launchCommand,
      notes: [
        `Save this as the profile at ${suggestedPath}; create its parent directory if needed. Do not append it to ${baseConfigPath} or save it at the legacy layered path ${legacyProfilePath}.`,
        `If ${suggestedPath} already exists, back it up before replacing it manually. Setup never overwrites it.`,
        `The launch command scopes CODEX_HOME to the dedicated directory ${isolatedHomePath}. Keep ${isolatedBaseConfigPath} absent: this keeps the normal-home base config at ${baseConfigPath} out of the child launch. Setup checks only whether the dedicated-home base file exists; it never reads or modifies either base config.`,
        `This is normal-home base-config isolation, not full Codex config isolation. A trusted current project's .codex/config.toml and the system /etc/codex/config.toml can still override model_catalog_json or [model_providers.copilot-proxy]; remove conflicting settings from those higher-priority layers.`,
        `If Codex does not request the proxy /v1/models catalog or reports a model metadata fallback, check the current project's .codex/config.toml and /etc/codex/config.toml for a conflicting model_catalog_json or copilot-proxy provider definition.`,
        `Validated ${options.choice.model.id} against the bundled metadata in installed Codex ${options.codexCatalog.version}.`,
        `Codex ${MINIMUM_CODEX_SETUP_VERSION} or newer and ${runtimeCommand} on PATH are required. The generated isolated profile and command-backed auth make Codex refresh the proxy-filtered model catalog with only a non-secret placeholder token.`,
        `Launch with the generated command: ${launchCommand}.`,
      ],
      suggestedPath,
    }
  }

  const command = generateEnvScript({
    OPENAI_BASE_URL: apiBaseUrl,
    OPENAI_API_KEY: 'dummy',
    OPENAI_MODEL: options.choice.model.id,
  }, '', { shell: options.shell })
  return {
    client: options.client,
    content: command,
    format: 'env-command',
    notes: [
      'Setup prints process-scoped environment assignments; it does not edit shell profiles or SDK config files.',
      `Use ${options.choice.api === 'responses' ? 'the Responses API' : 'Chat Completions'} with OPENAI_MODEL.`,
      'Start the SDK application only after the proxy is ready.',
    ],
  }
}

export function resolveCodexProfilePaths(
  profileName: string,
  options: ClientSetupPathOptions = {},
): CodexProfilePaths {
  if (!/^[\w-]+$/.test(profileName))
    throw new TypeError('Codex profile name must contain only letters, numbers, underscores, or hyphens')

  const platform = options.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? (
    platform === 'win32'
      ? env.COPILOT_PROXY_TEST_HOME || env.USERPROFILE || getUserHomeDir(env)
      : getUserHomeDir(env)
  )
  const configuredCodexHome = env.CODEX_HOME?.trim()
  const codexHome = pathApi.resolve(
    options.cwd ?? process.cwd(),
    configuredCodexHome || pathApi.join(homeDir, '.codex'),
  )
  const isolatedHomePath = pathApi.join(codexHome, `${profileName}-home`)

  return {
    baseConfigPath: pathApi.join(codexHome, 'config.toml'),
    isolatedBaseConfigPath: pathApi.join(isolatedHomePath, 'config.toml'),
    isolatedHomePath,
    legacyProfilePath: pathApi.join(codexHome, `${profileName}.config.toml`),
    suggestedPath: pathApi.join(isolatedHomePath, `${profileName}.config.toml`),
  }
}

function buildIsolatedCodexLaunchCommand(
  profileName: string,
  isolatedHomePath: string,
  shell: ShellName | undefined,
  platform: NodeJS.Platform,
): string {
  const usesNativeWindowsShell = platform === 'win32'
    && (shell === undefined || shell === 'cmd' || shell === 'powershell' || shell === 'pwsh')
  if (usesNativeWindowsShell) {
    // Run one disposable PowerShell child which scopes CODEX_HOME and delegates
    // directly to cmd.exe. This selects an npm codex.cmd shim even when the
    // caller is PowerShell with script execution disabled, and avoids nesting
    // generateShellCommand's encoded PowerShell wrapper inside another encoded
    // command (which can exceed cmd.exe's command-line limit).
    return generateEnvScript(
      { CODEX_HOME: isolatedHomePath },
      `codex --profile ${profileName}`,
      { shell: 'cmd' },
    )
  }

  // POSIX env(1) scopes CODEX_HOME to this one process instead of exporting it
  // into the caller's shell. It also works for fish and PowerShell Core on Unix.
  return generateShellCommand(
    'env',
    [`CODEX_HOME=${isolatedHomePath}`, 'codex', '--profile', profileName],
    { shell },
  )
}

function extractSetupProbeText(api: SetupProbeApi, response: unknown): string {
  if (!response || typeof response !== 'object')
    return ''
  const body = response as Record<string, unknown>

  if (api === 'anthropic-messages') {
    return Array.isArray(body.content)
      ? body.content.map(readTextField).join('')
      : ''
  }

  if (api === 'chat-completions') {
    if (!Array.isArray(body.choices))
      return ''
    return body.choices.map((choice) => {
      if (!choice || typeof choice !== 'object')
        return ''
      const message = (choice as Record<string, unknown>).message
      return message && typeof message === 'object'
        ? String((message as Record<string, unknown>).content ?? '')
        : ''
    }).join('')
  }

  if (typeof body.output_text === 'string')
    return body.output_text
  if (!Array.isArray(body.output))
    return ''
  return body.output.map((item) => {
    if (!item || typeof item !== 'object')
      return ''
    const content = (item as Record<string, unknown>).content
    return Array.isArray(content) ? content.map(readTextField).join('') : ''
  }).join('')
}

function readTextField(value: unknown): string {
  if (!value || typeof value !== 'object')
    return ''
  const text = (value as Record<string, unknown>).text
  return typeof text === 'string' ? text : ''
}

function quoteToml(value: string): string {
  return JSON.stringify(value)
}

function executeCodexCommand(
  command: string,
  args: string[],
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Promise<CodexCommandResult> {
  const env = buildCodexInspectionEnvironment(sourceEnv)
  const invocation = resolveCodexCommandInvocation(command, args, env)
  return new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, {
      encoding: 'utf8',
      env,
      maxBuffer: CODEX_COMMAND_MAX_BUFFER_BYTES,
      timeout: CODEX_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stderr, stdout })
    })
  })
}

function resolveCodexCommandInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { args: string[], command: string } {
  if (process.platform !== 'win32')
    return { args, command }

  const resolvedCommand = resolveWindowsCommand(command, env)
  if (!resolvedCommand)
    return { args, command }

  const extension = path.win32.extname(resolvedCommand).toLowerCase()
  if (extension !== '.cmd' && extension !== '.bat')
    return { args, command: resolvedCommand }

  const comSpec = readEnvironmentValue(env, 'ComSpec')
    || path.win32.join(readEnvironmentValue(env, 'SystemRoot') || 'C:\\Windows', 'System32', 'cmd.exe')
  const commandLine = [
    escapeWindowsCmdToken(resolvedCommand),
    ...args.map(escapeWindowsCmdToken),
  ].join(' ')
  return {
    args: ['/d', '/v:off', '/s', '/c', commandLine],
    command: comSpec,
  }
}

function resolveWindowsCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const commandExtension = path.win32.extname(command).toLowerCase()
  const extensions = commandExtension
    ? ['']
    : windowsExecutableExtensions(env)
  const hasPathSeparator = /[\\/]/.test(command)
  const directories = hasPathSeparator
    ? ['']
    : (readEnvironmentValue(env, 'PATH') ?? '')
        .split(path.win32.delimiter)
        .map(value => value.trim().replace(/^"|"$/g, ''))
        .map(value => value || process.cwd())

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory
        ? path.win32.resolve(directory, `${command}${extension}`)
        : path.win32.resolve(`${command}${extension}`)
      try {
        if (fs.statSync(candidate).isFile())
          return candidate
      }
      catch {
        // Continue with the remaining PATH/PATHEXT candidates.
      }
    }
  }
}

function windowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = (readEnvironmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(value => value.trim().toLowerCase())
    .filter(value => WINDOWS_EXECUTABLE_EXTENSIONS.has(value))
  return [...new Set(configured)]
}

function readEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())
  return key ? env[key] : undefined
}

function buildCodexInspectionEnvironment(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of CODEX_INSPECTION_ENV_KEYS) {
    const value = process.platform === 'win32'
      ? readEnvironmentValue(sourceEnv, key)
      : sourceEnv[key]
    if (value !== undefined)
      env[key] = value
  }
  return env
}

function escapeWindowsCmdToken(value: string): string {
  return value.replace(WINDOWS_CMD_META_CHARS, '^$1')
}

function parseCodexVersion(output: string): string | undefined {
  const match = /^(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)$/i.exec(output.trim())
  return match?.[1]
}

function isCodexVersionAtLeast(version: string, minimum: string): boolean {
  const current = parseSemanticVersion(version)
  const required = parseSemanticVersion(minimum)
  if (!current || !required)
    return false

  for (let index = 0; index < 3; index++) {
    if (current.numbers[index]! > required.numbers[index]!)
      return true
    if (current.numbers[index]! < required.numbers[index]!)
      return false
  }
  return current.prerelease === undefined || required.prerelease !== undefined
}

function parseSemanticVersion(version: string): {
  numbers: [number, number, number]
  prerelease?: string
} | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9a-z.-]+))?$/i.exec(version)
  if (!match)
    return undefined
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] && { prerelease: match[4] }),
  }
}

function parseUsableCodexModelSlugs(output: string, version: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  }
  catch (error) {
    throw new Error(`Codex ${version} returned invalid bundled model catalog JSON.`, { cause: error })
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Codex ${version} returned an invalid bundled model catalog object.`)
  }
  const models = (parsed as { models?: unknown }).models
  if (!Array.isArray(models)) {
    throw new TypeError(`Codex ${version} bundled model catalog is missing its models array.`)
  }

  const modelSlugs = models.flatMap((value): string[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return []
    const model = value as Record<string, unknown>
    if (typeof model.slug !== 'string' || !model.slug.trim())
      return []
    if (typeof model.base_instructions !== 'string' || !model.base_instructions.trim())
      return []
    if (typeof model.context_window !== 'number'
      || !Number.isSafeInteger(model.context_window)
      || model.context_window <= 0) {
      return []
    }
    return [model.slug]
  })
  if (modelSlugs.length === 0) {
    throw new Error(
      `Codex ${version} bundled model catalog contains no entries with usable base instructions and context metadata.`,
    )
  }
  return [...new Set(modelSlugs)]
}

function isMissingCommandError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT',
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : String(error)
}
