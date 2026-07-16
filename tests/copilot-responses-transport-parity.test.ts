import type { ResponsesTransportProbeResultLike } from './live/copilot-responses-transport-parity'

import { describe, expect, test } from 'bun:test'
import {
  buildResponsesTransportParityScenarios,
  classifyResponsesTransportAttempt,
  evaluateResponsesTransportPair,
} from './live/copilot-responses-transport-parity'

const scenarios = buildResponsesTransportParityScenarios({
  mcpServerUrl: 'https://dmcp-server.deno.dev/mcp',
  model: 'gpt-test',
})

describe('Responses SSE/WebSocket transport parity helpers', () => {
  test('builds a real MCP call and keeps missing file search resources explicit', () => {
    const mcp = scenario('mcp')
    const fileSearch = scenario('file_search')

    expect(mcp.payload).toMatchObject({
      store: false,
      tool_choice: 'required',
      tools: [{
        type: 'mcp',
        server_url: 'https://dmcp-server.deno.dev/mcp',
        allowed_tools: ['roll'],
        require_approval: 'never',
      }],
    })
    expect(fileSearch.syntheticMissingResource).toBe(true)
    expect(fileSearch.payload).toMatchObject({
      tools: [{
        type: 'file_search',
        vector_store_ids: ['vs_live_probe_missing'],
      }],
    })
  })

  test('requires vector-store IDs and sentinels together for positive file-search probes', () => {
    expect(() => buildResponsesTransportParityScenarios({
      mcpServerUrl: 'https://dmcp-server.deno.dev/mcp',
      model: 'gpt-test',
      vectorStoreId: 'vs_real',
    })).toThrow('COPILOT_LIVE_VECTOR_STORE_ID and COPILOT_LIVE_FILE_SEARCH_SENTINEL together')

    expect(() => buildResponsesTransportParityScenarios({
      fileSearchSentinel: 'sentinel',
      mcpServerUrl: 'https://dmcp-server.deno.dev/mcp',
      model: 'gpt-test',
    })).toThrow('COPILOT_LIVE_VECTOR_STORE_ID and COPILOT_LIVE_FILE_SEARCH_SENTINEL together')
  })

  test('requires the file-search sentinel in retrieved results rather than assistant text', () => {
    const [fileSearch] = buildResponsesTransportParityScenarios({
      fileSearchSentinel: 'SECRET_SENTINEL',
      mcpServerUrl: 'https://dmcp-server.deno.dev/mcp',
      model: 'gpt-test',
      vectorStoreId: 'vs_real',
    }).filter(candidate => candidate.feature === 'file_search')
    if (!fileSearch)
      throw new Error('Missing file_search scenario')

    const echoedOnly = completedToolTextResult({
      annotations: [{
        type: 'file_citation',
        file_id: 'file_unrelated',
        filename: 'unrelated.txt',
      }],
      outputText: 'SECRET_SENTINEL',
      toolEventTypes: ['response.file_search_call.completed'],
      toolItems: [{
        type: 'file_search_call',
        id: 'fs_test',
        status: 'completed',
        queries: ['SECRET_SENTINEL'],
        results: [{ file_id: 'file_unrelated', text: 'irrelevant result' }],
      }],
    })

    expect(classifyResponsesTransportAttempt(fileSearch, {
      result: echoedOnly,
      transport: 'websocket',
    }).category).toBe('validation_failed')

    const mismatchedCitation = completedToolTextResult({
      annotations: [{
        type: 'file_citation',
        file_id: 'file_other',
        filename: 'other.txt',
      }],
      outputText: 'SECRET_SENTINEL',
      toolEventTypes: ['response.file_search_call.completed'],
      toolItems: [{
        type: 'file_search_call',
        id: 'fs_test',
        status: 'completed',
        queries: ['SECRET_SENTINEL'],
        results: [{
          file_id: 'file_hit',
          filename: 'hit.txt',
          text: 'SECRET_SENTINEL',
        }],
      }],
    })
    const matchingCitation = completedToolTextResult({
      annotations: [{
        type: 'file_citation',
        file_id: 'file_hit',
        filename: 'hit.txt',
      }],
      outputText: 'SECRET_SENTINEL',
      toolEventTypes: ['response.file_search_call.completed'],
      toolItems: [{
        type: 'file_search_call',
        id: 'fs_test',
        status: 'completed',
        queries: ['SECRET_SENTINEL'],
        results: [{
          file_id: 'file_hit',
          filename: 'hit.txt',
          text: 'SECRET_SENTINEL',
        }],
      }],
    })
    const sameFilenameWrongId = completedToolTextResult({
      annotations: [{
        type: 'file_citation',
        file_id: 'file_other',
        filename: 'hit.txt',
      }],
      outputText: 'SECRET_SENTINEL',
      toolEventTypes: ['response.file_search_call.completed'],
      toolItems: [{
        type: 'file_search_call',
        id: 'fs_test',
        status: 'completed',
        queries: ['SECRET_SENTINEL'],
        results: [{
          file_id: 'file_hit',
          filename: 'hit.txt',
          text: 'SECRET_SENTINEL',
        }],
      }],
    })

    expect(classifyResponsesTransportAttempt(fileSearch, {
      result: mismatchedCitation,
      transport: 'sse',
    }).category).toBe('validation_failed')
    expect(classifyResponsesTransportAttempt(fileSearch, {
      result: matchingCitation,
      transport: 'sse',
    }).category).toBe('supported')
    expect(classifyResponsesTransportAttempt(fileSearch, {
      result: sameFilenameWrongId,
      transport: 'websocket',
    }).category).toBe('validation_failed')
  })

  test('requires json_schema output to obey the schema, not merely complete', () => {
    const jsonSchema = scenario('json_schema')
    const invalid = completedTextResult('{"answer":4}')
    const valid = completedTextResult('{"answer":"4"}')

    expect(classifyResponsesTransportAttempt(jsonSchema, {
      result: invalid,
      transport: 'sse',
    })).toMatchObject({
      category: 'validation_failed',
      transport: 'sse',
    })
    expect(classifyResponsesTransportAttempt(jsonSchema, {
      result: valid,
      transport: 'websocket',
    })).toEqual({
      category: 'supported',
      transport: 'websocket',
    })
  })

  test('does not classify a missing vector store as feature unsupported', () => {
    const fileSearch = scenario('file_search')
    const outcome = classifyResponsesTransportAttempt(fileSearch, {
      result: failedResult({
        code: 'vector_store_not_found',
        message: 'Vector store vs_live_probe_missing was not found',
        status: 404,
      }),
      transport: 'websocket',
    })

    expect(outcome).toMatchObject({
      category: 'resource_unavailable',
      transport: 'websocket',
    })
  })

  test('keeps bare file-search API and handshake 404s as hard transport failures', () => {
    const fileSearch = scenario('file_search')
    const api404 = classifyResponsesTransportAttempt(fileSearch, {
      result: failedResult({
        code: 'not_found',
        message: 'Not Found',
        status: 404,
      }),
      transport: 'sse',
    })
    const handshakeError = Object.assign(
      new Error('WebSocket Upgrade returned 404 Not Found'),
      { httpStatus: 404, phase: 'handshake' },
    )
    const handshake404 = classifyResponsesTransportAttempt(fileSearch, {
      error: handshakeError,
      transport: 'websocket',
    })

    expect(api404.category).toBe('transport_error')
    expect(handshake404.category).toBe('transport_error')
  })

  test('requires an affirmative Example Domain fact and matching example.com evidence', () => {
    const webSearch = scenario('web_search')
    const completedCall = {
      type: 'web_search_call',
      id: 'ws_test',
      status: 'completed',
      action: { sources: [] },
    }
    const valid = completedToolTextResult({
      annotations: [{
        type: 'url_citation',
        url: 'https://example.com/',
      }],
      outputText: 'The H1 heading is "Example Domain".',
      toolEventTypes: ['response.web_search_call.completed'],
      toolItems: [completedCall],
    })
    const validColonForm = completedToolTextResult({
      annotations: [{ type: 'url_citation', url: 'https://example.com/' }],
      outputText: 'H1 heading: **Example Domain**.',
      toolEventTypes: ['response.web_search_call.completed'],
      toolItems: [completedCall],
    })
    const negatedFact = completedToolTextResult({
      annotations: [{ type: 'url_citation', url: 'https://example.com/' }],
      outputText: 'The H1 heading is not Example Domain.',
      toolEventTypes: ['response.web_search_call.completed'],
      toolItems: [completedCall],
    })
    const validIncludedSource = completedToolTextResult({
      outputText: 'Example Domain',
      toolEventTypes: ['response.web_search_call.completed'],
      toolItems: [{
        ...completedCall,
        action: { sources: [{ type: 'url', url: 'https://example.com/' }] },
      }],
    })
    const unrelatedSource = completedToolTextResult({
      outputText: 'The H1 heading is Example Domain.',
      toolEventTypes: ['response.web_search_call.completed'],
      toolItems: [{
        ...completedCall,
        action: { sources: [{ type: 'url', url: 'https://example.net/' }] },
      }],
    })

    expect(classifyResponsesTransportAttempt(webSearch, {
      result: valid,
      transport: 'sse',
    }).category).toBe('supported')
    expect(classifyResponsesTransportAttempt(webSearch, {
      result: validColonForm,
      transport: 'websocket',
    }).category).toBe('supported')
    expect(classifyResponsesTransportAttempt(webSearch, {
      result: negatedFact,
      transport: 'sse',
    }).category).toBe('validation_failed')
    expect(classifyResponsesTransportAttempt(webSearch, {
      result: validIncludedSource,
      transport: 'websocket',
    }).category).toBe('supported')
    expect(classifyResponsesTransportAttempt(webSearch, {
      result: unrelatedSource,
      transport: 'websocket',
    }).category).toBe('validation_failed')
  })

  test('requires the exact deterministic MCP result instead of matching 1d1 text', () => {
    const mcp = scenario('mcp')
    const listTools = {
      type: 'mcp_list_tools',
      id: 'mcp_list_test',
      status: 'completed',
      server_label: 'dmcp',
      tools: [{ name: 'roll' }],
    }
    const rollCall = {
      type: 'mcp_call',
      id: 'mcp_call_test',
      status: 'completed',
      server_label: 'dmcp',
      name: 'roll',
      arguments: JSON.stringify({ diceRollExpression: '1d1' }),
      output: [{ type: 'text', text: '1' }],
    }
    const valid = completedToolTextResult({
      outputText: '1',
      toolEventTypes: ['response.mcp_list_tools.completed', 'response.mcp_call.completed'],
      toolItems: [listTools, rollCall],
    })
    const falsePositive = completedToolTextResult({
      outputText: 'The 1d1 result is unavailable.',
      toolEventTypes: ['response.mcp_list_tools.completed', 'response.mcp_call.completed'],
      toolItems: [{ ...listTools }, {
        ...rollCall,
        output: 'wrong result 2 for request 1d1',
      }],
    })

    expect(classifyResponsesTransportAttempt(mcp, {
      result: valid,
      transport: 'sse',
    }).category).toBe('supported')
    expect(classifyResponsesTransportAttempt(mcp, {
      result: falsePositive,
      transport: 'websocket',
    }).category).toBe('validation_failed')
  })

  test('separates explicit model capability rejection from MCP dependency failure', () => {
    const webSearch = scenario('web_search')
    const mcp = scenario('mcp')
    const unsupported = classifyResponsesTransportAttempt(webSearch, {
      result: failedResult({
        code: 'bad_request',
        message: 'The requested tool web_search is not supported.',
        status: 400,
      }),
      transport: 'sse',
    })
    const dependency = classifyResponsesTransportAttempt(mcp, {
      result: {
        ...failedResult({ message: 'MCP server failed to list tools', status: 502 }),
        eventTypes: ['response.created', 'response.mcp_list_tools.failed', 'response.failed'],
      },
      transport: 'websocket',
    })
    const executionFailure = classifyResponsesTransportAttempt(mcp, {
      result: {
        ...failedResult({
          message: 'MCP roll execution returned the wrong semantic result',
          status: 422,
        }),
        eventTypes: ['response.created', 'response.mcp_call.failed', 'response.failed'],
        outputItems: [{
          type: 'mcp_call',
          server_label: 'dmcp',
          name: 'roll',
          error: { message: 'expected deterministic result 1, got 2' },
        }],
      },
      transport: 'sse',
    })
    const invalidParamsCall = classifyResponsesTransportAttempt(mcp, {
      result: {
        ...failedResult({
          message: 'MCP server error: invalid params',
          status: 422,
        }),
        eventTypes: ['response.created', 'response.mcp_call.failed', 'response.failed'],
        outputItems: [{
          type: 'mcp_call',
          server_label: 'dmcp',
          name: 'roll',
          error: { message: 'MCP server error: invalid params' },
        }],
      },
      transport: 'websocket',
    })

    expect(unsupported.category).toBe('explicit_capability_unsupported')
    expect(dependency.category).toBe('dependency_unavailable')
    expect(executionFailure.category).toBe('validation_failed')
    expect(invalidParamsCall.category).toBe('validation_failed')
  })

  test('keeps an entered MCP call failure hard even when its message says unsupported', () => {
    const mcp = scenario('mcp')
    const result = {
      ...failedResult({
        message: 'MCP roll is not supported by this server',
        status: 422,
      }),
      eventTypes: ['response.created', 'response.mcp_call.failed', 'response.failed'],
      outputItems: [{
        type: 'mcp_call',
        server_label: 'dmcp',
        name: 'roll',
        error: { message: 'MCP roll is not supported by this server' },
      }],
    }

    expect(classifyResponsesTransportAttempt(mcp, {
      result,
      transport: 'sse',
    }).category).toBe('validation_failed')
    expect(classifyResponsesTransportAttempt(mcp, {
      result,
      transport: 'websocket',
    }).category).toBe('validation_failed')
  })

  test('does not treat API-level model rejection as feature-specific parity', () => {
    const jsonSchema = scenario('json_schema')
    const sse = classifyResponsesTransportAttempt(jsonSchema, {
      result: failedResult({
        code: 'unsupported_api_for_model',
        message: 'model gpt-4o is not supported via Responses API',
        status: 400,
      }),
      transport: 'sse',
    })
    const websocket = classifyResponsesTransportAttempt(jsonSchema, {
      result: failedResult({
        code: 'unsupported_api_for_model',
        message: 'model gpt-4o is not supported via Responses API',
        status: 400,
      }),
      transport: 'websocket',
    })

    expect(sse.category).toBe('transport_error')
    expect(websocket.category).toBe('transport_error')
    expect(evaluateResponsesTransportPair(sse, websocket).status).toBe('failed')
  })

  test('fails parity when transports reject different feature parameters', () => {
    const functionControl = scenarios.find(candidate => candidate.feature === 'function_tool_control')
    if (!functionControl)
      throw new Error('Missing function_tool_control scenario')
    const sse = classifyResponsesTransportAttempt(functionControl, {
      result: failedResult({
        code: 'unsupported_tool',
        message: 'function feature is not supported',
        param: 'tools[0].type',
        status: 400,
      }),
      transport: 'sse',
    })
    const websocket = classifyResponsesTransportAttempt(functionControl, {
      result: failedResult({
        code: 'unsupported_choice',
        message: 'function feature is not supported',
        param: 'tool_choice',
        status: 400,
      }),
      transport: 'websocket',
    })

    expect(sse.category).toBe('explicit_capability_unsupported')
    expect(websocket.category).toBe('explicit_capability_unsupported')
    expect(evaluateResponsesTransportPair(sse, websocket).status).toBe('failed')
  })

  test('fails parity when transports return different capability error codes', () => {
    const webSearch = scenario('web_search')
    const sse = classifyResponsesTransportAttempt(webSearch, {
      result: failedResult({
        code: 'unsupported_tool',
        message: 'web_search is not supported',
        param: 'tools[0].type',
        status: 400,
      }),
      transport: 'sse',
    })
    const websocket = classifyResponsesTransportAttempt(webSearch, {
      result: failedResult({
        code: 'organization_policy_denied',
        message: 'web_search is not supported',
        param: 'tools[0].type',
        status: 400,
      }),
      transport: 'websocket',
    })

    expect(sse.category).toBe('explicit_capability_unsupported')
    expect(websocket.category).toBe('explicit_capability_unsupported')
    expect(evaluateResponsesTransportPair(sse, websocket).status).toBe('failed')
  })

  test('compares structured rejection details from thrown transport probes', () => {
    const functionControl = scenarios.find(candidate => candidate.feature === 'function_tool_control')
    if (!functionControl)
      throw new Error('Missing function_tool_control scenario')
    const sseError = Object.assign(new Error('function feature is not supported'), {
      details: {
        code: 'unsupported_tool',
        message: 'function feature is not supported',
        param: 'tools[0].type',
        status: 400,
      },
      httpStatus: 400,
    })
    const websocketError = Object.assign(new Error('function feature is not supported'), {
      details: {
        code: 'unsupported_choice',
        message: 'function feature is not supported',
        param: 'tool_choice',
        status: 400,
      },
      httpStatus: 400,
    })
    const sse = classifyResponsesTransportAttempt(functionControl, {
      error: sseError,
      transport: 'sse',
    })
    const websocket = classifyResponsesTransportAttempt(functionControl, {
      error: websocketError,
      transport: 'websocket',
    })

    expect(sse.category).toBe('explicit_capability_unsupported')
    expect(websocket.category).toBe('explicit_capability_unsupported')
    expect(evaluateResponsesTransportPair(sse, websocket).status).toBe('failed')
  })

  test('compares plain thrown rejection messages conservatively', () => {
    const webSearch = scenario('web_search')
    const sse = classifyResponsesTransportAttempt(webSearch, {
      error: new Error('web_search is not supported for this model'),
      transport: 'sse',
    })
    const websocket = classifyResponsesTransportAttempt(webSearch, {
      error: new Error('web_search is not supported because organization policy constraint'),
      transport: 'websocket',
    })

    expect(sse.category).toBe('explicit_capability_unsupported')
    expect(websocket.category).toBe('explicit_capability_unsupported')
    expect(evaluateResponsesTransportPair(sse, websocket).status).toBe('failed')
  })

  test('passes only matching supported/unsupported pairs and reports prerequisites as inconclusive', () => {
    expect(evaluateResponsesTransportPair(
      { category: 'supported', transport: 'sse' },
      { category: 'supported', transport: 'websocket' },
    )).toMatchObject({ status: 'confirmed' })

    expect(evaluateResponsesTransportPair(
      { capabilityFingerprint: 'web_search:websearch', category: 'explicit_capability_unsupported', transport: 'sse' },
      { capabilityFingerprint: 'web_search:websearch', category: 'explicit_capability_unsupported', transport: 'websocket' },
    )).toMatchObject({ status: 'confirmed' })

    expect(evaluateResponsesTransportPair(
      { capabilityFingerprint: 'function_tool_control:function', category: 'explicit_capability_unsupported', transport: 'sse' },
      { capabilityFingerprint: 'function_tool_control:toolchoice', category: 'explicit_capability_unsupported', transport: 'websocket' },
    )).toMatchObject({ status: 'failed' })

    expect(evaluateResponsesTransportPair(
      { category: 'resource_unavailable', transport: 'sse' },
      { category: 'resource_unavailable', transport: 'websocket' },
    )).toMatchObject({ status: 'inconclusive' })

    expect(evaluateResponsesTransportPair(
      { category: 'supported', transport: 'sse' },
      { category: 'explicit_capability_unsupported', transport: 'websocket' },
    )).toMatchObject({ status: 'failed' })

    expect(evaluateResponsesTransportPair(
      { category: 'validation_failed', detail: 'schema mismatch', transport: 'sse' },
      { category: 'validation_failed', detail: 'schema mismatch', transport: 'websocket' },
    )).toMatchObject({ status: 'failed' })
  })
})

function scenario(feature: Parameters<typeof findScenario>[0]) {
  const found = findScenario(feature)
  if (!found)
    throw new Error(`Missing test scenario ${feature}`)
  return found
}

function findScenario(feature: 'json_schema' | 'web_search' | 'mcp' | 'file_search') {
  return scenarios.find(candidate => candidate.feature === feature)
}

function completedTextResult(outputText: string): ResponsesTransportProbeResultLike {
  return completedToolTextResult({ outputText })
}

function completedToolTextResult(options: {
  annotations?: Array<Record<string, unknown>>
  outputText: string
  toolEventTypes?: Array<string>
  toolItems?: Array<Record<string, unknown>>
}): ResponsesTransportProbeResultLike {
  const toolEventTypes = options.toolEventTypes ?? []
  const toolItems = options.toolItems ?? []
  const message = {
    type: 'message',
    id: 'msg_test',
    status: 'completed',
    role: 'assistant',
    content: [{
      type: 'output_text',
      text: options.outputText,
      annotations: options.annotations ?? [],
    }],
  }
  const response = {
    id: 'resp_test',
    object: 'response',
    status: 'completed',
    output: [...toolItems, message],
  }
  const frames: Array<Record<string, unknown>> = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: { ...response, status: 'in_progress', output: [] },
    },
    ...toolEventTypes.map((type, index) => ({
      type,
      sequence_number: index + 1,
    })),
    {
      type: 'response.output_text.done',
      sequence_number: toolEventTypes.length + 1,
      text: options.outputText,
    },
    {
      type: 'response.completed',
      sequence_number: toolEventTypes.length + 2,
      response,
    },
  ]
  return {
    completed: true,
    eventTypes: frames.map(frame => String(frame.type)),
    frames,
    outputItems: [...toolItems, message],
    outputText: options.outputText,
    response,
    terminalEvent: frames.at(-1)!,
    terminalType: 'response.completed',
    toolEventTypes,
  }
}

function failedResult(error: {
  code?: string
  message: string
  param?: string
  status?: number
}): ResponsesTransportProbeResultLike {
  const terminalEvent = {
    type: 'error',
    sequence_number: 0,
    status: error.status,
    error,
  }
  return {
    completed: false,
    error,
    eventTypes: ['error'],
    frames: [terminalEvent],
    outputItems: [],
    outputText: '',
    terminalEvent,
    terminalType: 'error',
    toolEventTypes: [],
  }
}
