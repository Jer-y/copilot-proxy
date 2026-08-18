import type {
  AnthropicMessagesCapabilityProbe,
  LiveCopilotProbeConfig,
  RawAnthropicCapabilityProbe,
} from './live/copilot-capability-matrix'
import type { AnthropicAssistantContentBlock, AnthropicResponse } from '~/lib/translation/types'

import { describe, expect, test } from 'bun:test'

import {
  buildAnthropicPauseContinuation,
  copilotCapabilityProbes,
  findRetryableAnthropicServerToolErrorCode,
  mergeAnthropicProbeResponses,
} from './live/copilot-capability-matrix'

const CONFIG: LiveCopilotProbeConfig = {
  claudeModel: 'claude-opus-5',
  responsesModel: 'gpt-5.4',
  imageUrl: 'https://example.com/image.png',
  fileUrl: 'https://example.com/file.pdf',
}

describe('Claude capability probe boundaries', () => {
  test('excludes Anthropic platform control-plane APIs from the model matrix', () => {
    const ids = copilotCapabilityProbes.map(probe => probe.id)
    expect(ids).not.toContain('native-anthropic-models-api-unsupported')
    expect(ids).not.toContain('native-anthropic-batches-list-unsupported')
    expect(ids).not.toContain('native-anthropic-batches-create-unsupported')
    expect(ids).not.toContain('native-anthropic-files-api-unsupported')
    expect(copilotCapabilityProbes.some(probe => (probe.endpoint as string) === 'anthropic-files')).toBe(false)

    const rawAnthropicProbes = copilotCapabilityProbes.filter(
      (probe): probe is RawAnthropicCapabilityProbe => probe.endpoint === 'anthropic-raw',
    )
    const paths = rawAnthropicProbes.map(probe => probe.buildRequest(CONFIG).path)
    expect(paths).not.toContain('/v1/models')
    expect(paths).not.toContain('/v1/files')
    expect(paths).not.toContain('/v1/messages/batches')
    expect(paths).not.toContain('/v1/messages/batches?limit=1')
  })

  test('requires semantic code execution evidence', () => {
    const probe = anthropicProbe('native-anthropic-server-tool-code-execution')
    expect(probe.buildPayload(CONFIG).tools).toEqual([
      { type: 'code_execution_20260521', name: 'code_execution' },
    ])

    const valid = response([
      { type: 'text', text: 'I will calculate that.' },
      { type: 'server_tool_use', id: 'srv_probe', name: 'bash_code_execution', input: { command: 'python3 -V' } },
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'srv_probe',
        content: {
          type: 'bash_code_execution_result',
          stdout: 'Python 3.11\n',
          stderr: '',
          return_code: 0,
          content: [],
        },
      },
      { type: 'server_tool_use', id: 'srv_answer', name: 'bash_code_execution', input: { command: 'echo $((17*19))' } },
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'srv_answer',
        content: {
          type: 'bash_code_execution_result',
          stdout: '323\n',
          stderr: '',
          return_code: 0,
          content: [],
        },
      },
      { type: 'text', text: '323' },
    ], 'end_turn', {
      container: { id: 'container_1', expires_at: '2099-01-01T00:00:00Z' },
    })
    expect(probe.validateResponse?.(valid)).toBeUndefined()

    expect(probe.validateResponse?.(response([
      { type: 'text', text: '323' },
    ], 'end_turn'))).toContain('server_tool_use')

    expect(probe.validateResponse?.(response([
      { type: 'server_tool_use', id: 'srv_1', name: 'bash_code_execution', input: { command: 'echo 323' } },
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'srv_2',
        content: {
          type: 'bash_code_execution_result',
          stdout: '323\n',
          stderr: '',
          return_code: 0,
          content: [],
        },
      },
      { type: 'text', text: '323' },
    ], 'end_turn', {
      container: { id: 'container_1', expires_at: '2099-01-01T00:00:00Z' },
    }))).toContain('linked')

    expect(probe.validateResponse?.(response([
      { type: 'server_tool_use', id: 'srv_1', name: 'bash_code_execution', input: { command: 'echo 323' } },
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'srv_1',
        content: { type: 'bash_code_execution_tool_result_error', error_code: 'unavailable' },
      },
      { type: 'text', text: '323' },
    ], 'end_turn', {
      container: { id: 'container_1', expires_at: '2099-01-01T00:00:00Z' },
    }))).toContain('unavailable')

    expect(probe.validateResponse?.(response([
      { type: 'server_tool_use', id: 'srv_1', name: 'bash_code_execution', input: { command: 'echo 323' } },
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'srv_1',
        content: {
          type: 'bash_code_execution_result',
          stdout: '323\n',
          stderr: '',
          return_code: 0,
          content: [],
        },
      },
      { type: 'text', text: '323' },
    ], 'end_turn', {
      container: { id: '', expires_at: 'not-a-date' },
    }))).toContain('container')
  })

  test('classifies bash, text editor, and memory as client tool calls', () => {
    const clientTools = [
      ['native-anthropic-client-tool-bash', 'bash', { command: 'printf CLIENT_BASH_OK' }],
      ['native-anthropic-client-tool-text-editor', 'str_replace_based_edit_tool', { command: 'view', path: '/tmp/probe.txt' }],
      ['native-anthropic-client-tool-memory', 'memory', { command: 'view', path: '/memories' }],
    ] as const

    for (const [id, toolName, input] of clientTools) {
      const probe = anthropicProbe(id)
      expect(probe.buildPayload(CONFIG).tool_choice).toEqual({ type: 'tool', name: toolName })
      expect(probe.validateResponse?.(response([
        { type: 'tool_use', id: 'toolu_1', name: toolName, input },
      ], 'tool_use'))).toBeUndefined()
      expect(probe.validateResponse?.(response([
        { type: 'tool_use', id: 'toolu_1', name: toolName, input: {} },
      ], 'tool_use'))).toContain('input')
      expect(probe.title).toContain('client tool call')
    }

    const bashProbe = anthropicProbe('native-anthropic-client-tool-bash')
    for (const command of [
      'printf %s CLIENT_BASH_OK',
      'printf \'%s\' \'CLIENT_BASH_OK\'',
      'printf \"%s\" \"CLIENT_BASH_OK\"',
      'printf \'%s\\n\' CLIENT_BASH_OK',
      'printf \"%s\\n\" CLIENT_BASH_OK',
      'printf \'CLIENT_BASH_OK\\n\'',
      'printf \"CLIENT_BASH_OK\\n\"',
      '/usr/bin/printf CLIENT_BASH_OK',
      '/bin/printf \'%s\\n\' CLIENT_BASH_OK',
    ]) {
      expect(bashProbe.validateResponse?.(response([
        { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command } },
      ], 'tool_use'))).toBeUndefined()
    }
    expect(bashProbe.validateResponse?.(response([
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'true # CLIENT_BASH_OK' } },
    ], 'tool_use'))).toContain('input')
    expect(bashProbe.validateResponse?.(response([
      { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'printf CLIENT_BASH_OK; true' } },
    ], 'tool_use'))).toContain('input')

    const malformedBashToolUse = {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'bash',
      input: null,
    } as unknown as AnthropicAssistantContentBlock
    expect(bashProbe.validateResponse?.(response([
      malformedBashToolUse,
    ], 'tool_use'))).toContain('input must be an object')

    const ids = copilotCapabilityProbes.map(probe => probe.id)
    expect(ids).not.toContain('native-anthropic-server-tool-bash')
    expect(ids).not.toContain('native-anthropic-server-tool-text-editor')
    expect(ids).not.toContain('native-anthropic-server-tool-memory')
  })

  test('keeps web search and requires completed semantic evidence when supported', () => {
    const probe = anthropicProbe('native-anthropic-server-tool-web-search')
    expect(probe.buildPayload(CONFIG).tools).toEqual([
      { type: 'web_search_20260318', name: 'web_search' },
    ])
    const valid = response([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'site:example.com H1' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_1',
        content: [{ type: 'web_search_result', title: 'Example Domain', url: 'https://example.com/' }],
      },
      {
        type: 'text',
        text: 'Example Domain',
        citations: [{ type: 'web_search_result_location', url: 'https://example.com/' }],
      },
    ], 'end_turn')
    expect(probe.validateResponse?.(valid)).toBeUndefined()

    expect(probe.validateResponse?.(response([
      { type: 'text', text: 'I will search example.com.' },
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'site:example.com H1' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_1',
        content: [{ type: 'web_search_result', title: 'Example Domain', url: 'https://example.com/' }],
      },
      { type: 'text', text: 'Example ' },
      {
        type: 'text',
        text: 'Domain',
        citations: [{ type: 'web_search_result_location', url: 'https://example.com/' }],
      },
    ], 'end_turn'))).toBeUndefined()

    expect(probe.validateResponse?.(response([
      { type: 'text', text: 'Example Domain' },
    ], 'end_turn'))).toContain('server_tool_use')

    expect(probe.validateResponse?.(response([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'site:example.com H1' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_1',
        content: [{ type: 'web_search_result', title: 'Example Domain', url: 'https://example.com/' }],
      },
      { type: 'text', text: 'The H1 heading is not Example Domain.' },
    ], 'end_turn'))).toContain('equal Example Domain')

    expect(probe.validateResponse?.(response([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'site:example.com H1' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_1',
        content: { type: 'web_search_tool_result_error', error_code: 'unavailable' },
      },
      {
        type: 'text',
        text: 'Example Domain',
        citations: [{ type: 'web_search_result_location', url: 'https://example.com/' }],
      },
    ], 'end_turn'))).toContain('unavailable')

    expect(probe.validateResponse?.(response([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'https://example.com/ H1' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_1',
        content: [{ type: 'web_search_result', title: 'Other', url: 'https://other.test/' }],
      },
      { type: 'text', text: 'Example Domain' },
    ], 'end_turn'))).toContain('example.com URL')

    expect(probe.validateResponse?.(response([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'https://example.com/ H1' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_1',
        content: [{
          type: 'web_search_result',
          title: 'Mentions https://example.com/ but is not that source',
          url: 'https://other.test/',
        }],
      },
      { type: 'text', text: 'Example Domain' },
    ], 'end_turn'))).toContain('example.com URL')

    expect(probe.validateResponse?.(response([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'site:example.com H1' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srv_2',
        content: [{ type: 'web_search_result', title: 'Example Domain', url: 'https://example.com/' }],
      },
      { type: 'text', text: 'Example Domain' },
    ], 'end_turn'))).toContain('linked')
  })

  test('replaces bounded pause_turn continuation history', () => {
    const probe = anthropicProbe('native-anthropic-server-tool-web-search')
    const payload = probe.buildPayload(CONFIG)
    const paused = response([
      { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'site:example.com H1' } },
    ], 'pause_turn')

    const continuation = buildAnthropicPauseContinuation(payload, paused)

    expect(continuation.messages).toEqual([
      ...payload.messages,
      { role: 'assistant', content: paused.content },
    ])
    expect(continuation.tools).toBe(payload.tools)
    expect(payload.messages).toHaveLength(1)

    const laterPause = response([
      { type: 'server_tool_use', id: 'srv_2', name: 'web_search', input: { query: 'site:example.com title' } },
    ], 'pause_turn')
    expect(buildAnthropicPauseContinuation(payload, laterPause).messages).toEqual([
      ...payload.messages,
      { role: 'assistant', content: laterPause.content },
    ])
  })

  test('merges pause_turn evidence before semantic validation', () => {
    const probe = anthropicProbe('native-anthropic-server-tool-code-execution')
    const paused = response([
      { type: 'server_tool_use', id: 'srv_1', name: 'bash_code_execution', input: { command: 'printf 323' } },
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'srv_1',
        content: {
          type: 'bash_code_execution_result',
          stdout: '323\n',
          stderr: '',
          return_code: 0,
          content: [],
        },
      },
    ], 'pause_turn', {
      container: { id: 'container_1', expires_at: '2099-01-01T00:00:00Z' },
    })
    const completed = response([{ type: 'text', text: '323' }], 'end_turn')

    const merged = mergeAnthropicProbeResponses([paused, completed])

    expect(merged.stop_reason).toBe('end_turn')
    expect(merged.content).toEqual([...paused.content, ...completed.content])
    expect((merged as unknown as Record<string, unknown>).container).toEqual({
      id: 'container_1',
      expires_at: '2099-01-01T00:00:00Z',
    })
    expect(probe.validateResponse?.(merged)).toBeUndefined()
  })

  test('identifies only transient server-tool result errors as retryable', () => {
    for (const errorCode of ['unavailable', 'too_many_requests']) {
      expect(findRetryableAnthropicServerToolErrorCode(
        serverToolErrorResponse(errorCode),
        `Web search returned error_code=${errorCode}`,
      )).toBe(errorCode)
    }

    for (const errorCode of ['invalid_tool_input', 'max_uses_exceeded', 'execution_time_exceeded']) {
      expect(findRetryableAnthropicServerToolErrorCode(
        serverToolErrorResponse(errorCode),
        `Web search returned error_code=${errorCode}`,
      )).toBeUndefined()
    }

    expect(findRetryableAnthropicServerToolErrorCode(
      serverToolErrorResponse('unavailable'),
      'Expected final assistant text to equal Example Domain',
    )).toBeUndefined()
  })
})

function anthropicProbe(id: string): AnthropicMessagesCapabilityProbe {
  const probe = copilotCapabilityProbes.find(candidate => candidate.id === id)
  if (!probe || probe.endpoint !== 'anthropic-messages') {
    throw new Error(`Missing Anthropic messages probe: ${id}`)
  }
  return probe
}

function response(
  content: AnthropicAssistantContentBlock[],
  stopReason: AnthropicResponse['stop_reason'],
  extra: Record<string, unknown> = {},
): AnthropicResponse {
  return {
    id: 'msg_probe',
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-opus-5',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  }
}

function serverToolErrorResponse(errorCode: string): AnthropicResponse {
  return response([
    { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'example.com' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srv_1',
      content: { type: 'web_search_tool_result_error', error_code: errorCode },
    },
  ], 'end_turn')
}
