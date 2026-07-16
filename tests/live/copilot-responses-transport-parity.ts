import type { ResponsesPayload } from '~/services/copilot/create-responses'

export type ResponsesParityFeature
  = | 'function_tool_control'
    | 'json_object'
    | 'json_schema'
    | 'web_search'
    | 'web_search_preview'
    | 'mcp'
    | 'file_search'

export type ResponsesTransportOutcomeCategory
  = | 'supported'
    | 'explicit_capability_unsupported'
    | 'resource_unavailable'
    | 'dependency_unavailable'
    | 'validation_failed'
    | 'transport_error'

export interface ResponsesTransportErrorDetails {
  code?: string
  message?: string
  param?: string | null
  status?: number
  type?: string
}

export interface ResponsesTransportProbeResultLike {
  completed: boolean
  error?: ResponsesTransportErrorDetails
  eventTypes: Array<string>
  frames: Array<Record<string, unknown>>
  outputItems: Array<Record<string, unknown>>
  outputText: string
  response?: Record<string, unknown>
  terminalEvent: Record<string, unknown>
  terminalType: string
  toolEventTypes: Array<string>
}

export interface ResponsesTransportParityConfig {
  fileSearchSentinel?: string
  mcpServerUrl: string
  model: string
  vectorStoreId?: string
}

export interface ResponsesTransportParityScenario {
  feature: ResponsesParityFeature
  fileSearchSentinel?: string
  payload: ResponsesPayload
  syntheticMissingResource?: boolean
  title: string
  validate: (result: ResponsesTransportProbeResultLike) => string | undefined
}

export interface ResponsesTransportAttempt {
  error?: unknown
  result?: ResponsesTransportProbeResultLike
  transport: 'sse' | 'websocket'
}

export interface ResponsesTransportOutcome {
  capabilityCode?: string
  capabilityFingerprint?: string
  capabilityMessage?: string
  capabilityParam?: string
  category: ResponsesTransportOutcomeCategory
  detail?: string
  transport: 'sse' | 'websocket'
}

export interface ResponsesTransportPairVerdict {
  detail: string
  status: 'confirmed' | 'inconclusive' | 'failed'
}

const DMCP_ROLL_TOOL_NAME = 'roll'
const DMCP_ROLL_ARGUMENT = '1d1'
const MAX_DETAIL_LENGTH = 240

export function buildResponsesTransportParityScenarios(
  config: ResponsesTransportParityConfig,
): Array<ResponsesTransportParityScenario> {
  if (Boolean(config.vectorStoreId) !== Boolean(config.fileSearchSentinel)) {
    throw new TypeError(
      'Positive file_search parity requires COPILOT_LIVE_VECTOR_STORE_ID and COPILOT_LIVE_FILE_SEARCH_SENTINEL together.',
    )
  }

  const base = {
    model: config.model,
    store: false,
  } as const
  const vectorStoreId = config.vectorStoreId ?? 'vs_live_probe_missing'
  const fileSearchPrompt = config.fileSearchSentinel
    ? `Search the configured vector store for the exact sentinel ${JSON.stringify(config.fileSearchSentinel)} and return it verbatim with a file citation.`
    : 'Search the configured vector store, return one specific fact from it, and cite the source file.'

  return [
    {
      feature: 'function_tool_control',
      title: 'function tool control',
      payload: {
        ...base,
        input: `Call parity_marker exactly once with value "transport-parity". Do not answer in text.`,
        max_output_tokens: 512,
        tool_choice: 'required',
        tools: [{
          type: 'function',
          name: 'parity_marker',
          description: 'Records the transport parity sentinel.',
          parameters: {
            type: 'object',
            properties: {
              value: { type: 'string' },
            },
            required: ['value'],
            additionalProperties: false,
          },
        }],
      },
      validate: validateFunctionToolControl,
    },
    {
      feature: 'json_object',
      title: 'text.format json_object',
      payload: {
        ...base,
        input: 'Return a JSON object with ok=true and transport="parity". Output JSON only.',
        max_output_tokens: 128,
        text: { format: { type: 'json_object' } },
      },
      validate: validateJsonObject,
    },
    {
      feature: 'json_schema',
      title: 'text.format json_schema',
      payload: {
        ...base,
        input: 'What is 2+2? Return the answer using the supplied JSON schema.',
        max_output_tokens: 128,
        text: {
          format: {
            type: 'json_schema',
            name: 'transport_parity_math_answer',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                answer: { type: 'string', enum: ['4'] },
              },
              required: ['answer'],
              additionalProperties: false,
            },
          },
        },
      },
      validate: validateJsonSchema,
    },
    ...(['web_search', 'web_search_preview'] as const).map(toolType => ({
      feature: toolType,
      title: `${toolType} hosted tool`,
      payload: {
        ...base,
        input: 'Use the web search tool to find https://example.com. Report its H1 heading exactly and cite the source.',
        include: ['web_search_call.action.sources'],
        max_output_tokens: 512,
        max_tool_calls: 1,
        tool_choice: 'required' as const,
        tools: [{ type: toolType }],
      },
      validate: validateWebSearch,
    })),
    {
      feature: 'mcp',
      title: 'remote MCP tool call',
      payload: {
        ...base,
        input: `Use the dmcp roll tool exactly once with diceRollExpression=${JSON.stringify(DMCP_ROLL_ARGUMENT)}. Then reply with only the numeric result.`,
        max_output_tokens: 256,
        max_tool_calls: 1,
        tool_choice: 'required',
        tools: [{
          type: 'mcp',
          server_label: 'dmcp',
          server_description: 'A deterministic dice roller used only for transport parity validation.',
          server_url: config.mcpServerUrl,
          allowed_tools: [DMCP_ROLL_TOOL_NAME],
          require_approval: 'never',
        }],
      },
      validate: validateMcp,
    },
    {
      feature: 'file_search',
      title: 'file_search hosted tool',
      fileSearchSentinel: config.fileSearchSentinel,
      syntheticMissingResource: !config.vectorStoreId,
      payload: {
        ...base,
        input: fileSearchPrompt,
        include: ['file_search_call.results'],
        max_output_tokens: 512,
        max_tool_calls: 1,
        tool_choice: 'required',
        tools: [{
          type: 'file_search',
          vector_store_ids: [vectorStoreId],
        }],
      },
      validate: result => validateFileSearch(result, config.fileSearchSentinel),
    },
  ]
}

export function classifyResponsesTransportAttempt(
  scenario: ResponsesTransportParityScenario,
  attempt: ResponsesTransportAttempt,
): ResponsesTransportOutcome {
  if (attempt.error !== undefined) {
    const evidence = collectThrownErrorEvidence(attempt.error)
    return classifyFailureEvidence(
      scenario,
      attempt.transport,
      evidence,
      collectThrownErrorDetails(attempt.error),
    )
  }

  if (!attempt.result) {
    return {
      category: 'transport_error',
      detail: 'Probe returned neither a result nor an error.',
      transport: attempt.transport,
    }
  }

  const evidence = collectResultErrorEvidence(attempt.result)
  const mcpFailureCategory = classifyMcpResultFailure(scenario, attempt.result, evidence)
  if (mcpFailureCategory) {
    return outcome(
      mcpFailureCategory,
      attempt.transport,
      evidence || 'MCP list/call emitted a failed event or error item.',
    )
  }
  if (isExplicitCapabilityUnsupported(scenario, evidence)) {
    return capabilityUnsupportedOutcome(
      scenario,
      attempt.transport,
      evidence,
      attempt.result.error,
    )
  }
  if (isFileSearchResourceUnavailable(scenario, evidence)) {
    return outcome('resource_unavailable', attempt.transport, evidence)
  }
  if (!attempt.result.completed) {
    return outcome('transport_error', attempt.transport, evidence || 'Response did not complete successfully.')
  }

  const validationError = scenario.validate(attempt.result)
  if (validationError) {
    return {
      category: 'validation_failed',
      detail: truncate(validationError, MAX_DETAIL_LENGTH),
      transport: attempt.transport,
    }
  }

  return {
    category: 'supported',
    transport: attempt.transport,
  }
}

export function evaluateResponsesTransportPair(
  sse: ResponsesTransportOutcome,
  websocket: ResponsesTransportOutcome,
): ResponsesTransportPairVerdict {
  if (sse.category === 'validation_failed' || websocket.category === 'validation_failed') {
    return {
      status: 'failed',
      detail: `semantic validation failed (${formatOutcome(sse)}; ${formatOutcome(websocket)})`,
    }
  }

  if (sse.category === 'transport_error' || websocket.category === 'transport_error') {
    return {
      status: 'failed',
      detail: `transport/API failure (${formatOutcome(sse)}; ${formatOutcome(websocket)})`,
    }
  }

  if (sse.category !== websocket.category) {
    return {
      status: 'failed',
      detail: `category mismatch (${formatOutcome(sse)}; ${formatOutcome(websocket)})`,
    }
  }

  if (sse.category === 'supported') {
    return {
      status: 'confirmed',
      detail: 'both transports passed the same semantic validator',
    }
  }

  if (sse.category === 'explicit_capability_unsupported') {
    if (
      !sse.capabilityFingerprint
      || !websocket.capabilityFingerprint
      || sse.capabilityFingerprint !== websocket.capabilityFingerprint
    ) {
      return {
        status: 'failed',
        detail: `capability rejection mismatch (${formatOutcome(sse)}; ${formatOutcome(websocket)})`,
      }
    }
    if (sse.capabilityCode !== websocket.capabilityCode) {
      return {
        status: 'failed',
        detail: `capability rejection code mismatch (${formatOutcome(sse)}; ${formatOutcome(websocket)})`,
      }
    }
    if (sse.capabilityParam !== websocket.capabilityParam) {
      return {
        status: 'failed',
        detail: `capability rejection parameter mismatch (${formatOutcome(sse)}; ${formatOutcome(websocket)})`,
      }
    }
    if (sse.capabilityMessage !== websocket.capabilityMessage) {
      return {
        status: 'failed',
        detail: `capability rejection message mismatch (${formatOutcome(sse)}; ${formatOutcome(websocket)})`,
      }
    }
    return {
      status: 'confirmed',
      detail: 'both transports returned explicit capability-unsupported errors',
    }
  }

  return {
    status: 'inconclusive',
    detail: `both transports were ${sse.category}; no positive support claim`,
  }
}

function validateFunctionToolControl(result: ResponsesTransportProbeResultLike): string | undefined {
  const commonError = validateCompletedEventSequence(result)
  if (commonError)
    return commonError

  const calls = outputItemsOfType(result, 'function_call')
  if (calls.length !== 1)
    return `Expected exactly one function_call output item, got ${calls.length}.`

  const call = calls[0]
  if (call.name !== 'parity_marker')
    return `Expected parity_marker, got ${String(call.name)}.`
  if (typeof call.call_id !== 'string' || call.call_id.length === 0)
    return 'Expected a non-empty function call_id.'
  if (call.status !== undefined && call.status !== 'completed')
    return `Expected a completed function call, got ${String(call.status)}.`

  const args = parseJsonRecord(call.arguments)
  if (!args || args.value !== 'transport-parity')
    return 'Function arguments did not preserve value="transport-parity".'

  return undefined
}

function validateJsonObject(result: ResponsesTransportProbeResultLike): string | undefined {
  const commonError = validateTextResponse(result)
  if (commonError)
    return commonError

  const parsed = parseJsonRecord(result.outputText)
  if (!parsed)
    return 'json_object output was not a valid JSON object.'
  if (parsed.ok !== true || parsed.transport !== 'parity')
    return 'json_object output did not preserve ok=true and transport="parity".'

  return undefined
}

function validateJsonSchema(result: ResponsesTransportProbeResultLike): string | undefined {
  const commonError = validateTextResponse(result)
  if (commonError)
    return commonError

  const parsed = parseJsonRecord(result.outputText)
  if (!parsed)
    return 'json_schema output was not a valid JSON object.'
  if (parsed.answer !== '4')
    return 'json_schema output did not contain answer="4".'
  if (Object.keys(parsed).length !== 1)
    return 'json_schema output violated additionalProperties=false.'

  return undefined
}

function validateWebSearch(result: ResponsesTransportProbeResultLike): string | undefined {
  const commonError = validateTextResponse(result)
  if (commonError)
    return commonError

  const calls = outputItemsOfType(result, 'web_search_call')
  if (calls.length === 0)
    return 'Expected a web_search_call output item.'
  if (!calls.some(call => call.status === 'completed'))
    return 'Expected a completed web_search_call output item.'
  if (!result.eventTypes.includes('response.web_search_call.completed'))
    return 'Expected response.web_search_call.completed in the streaming event sequence.'
  if (!reportsExampleDomainHeading(result.outputText))
    return 'Web search output did not affirm that the H1 heading is Example Domain.'
  if (!hasExampleDomainCitationOrSource(result))
    return 'Web search output had no URL citation or action source pointing to example.com.'

  return undefined
}

function validateMcp(result: ResponsesTransportProbeResultLike): string | undefined {
  const commonError = validateTextResponse(result)
  if (commonError)
    return commonError

  const lists = outputItemsOfType(result, 'mcp_list_tools')
  const calls = outputItemsOfType(result, 'mcp_call')
  if (lists.length === 0)
    return 'Expected an mcp_list_tools output item.'
  if (!lists.some(list => (list.status === undefined || list.status === 'completed')
    && list.server_label === 'dmcp'
    && arrayHasNamedTool(list.tools, DMCP_ROLL_TOOL_NAME))) {
    return 'MCP tool import did not expose dmcp.roll.'
  }
  if (calls.length === 0)
    return 'Expected an mcp_call output item.'

  const rollCall = calls.find(call => call.server_label === 'dmcp' && call.name === DMCP_ROLL_TOOL_NAME)
  if (!rollCall)
    return 'Expected a dmcp.roll MCP call.'
  if (rollCall.status !== undefined && rollCall.status !== 'completed')
    return `Expected a completed dmcp.roll MCP call, got ${String(rollCall.status)}.`
  if (rollCall.error !== null && rollCall.error !== undefined)
    return 'dmcp.roll returned an MCP error.'

  const args = parseJsonRecord(rollCall.arguments)
  if (!args || normalizeDiceExpression(args.diceRollExpression) !== DMCP_ROLL_ARGUMENT)
    return `dmcp.roll arguments did not preserve ${DMCP_ROLL_ARGUMENT}.`
  if (!hasDeterministicMcpResultOne(rollCall.output))
    return 'dmcp.roll output was not the deterministic numeric result 1.'
  if (result.outputText.trim() !== '1')
    return 'The assistant did not return exactly the deterministic numeric MCP result 1.'
  if (!result.eventTypes.includes('response.mcp_list_tools.completed'))
    return 'Expected response.mcp_list_tools.completed in the streaming event sequence.'
  if (!result.eventTypes.includes('response.mcp_call.completed'))
    return 'Expected response.mcp_call.completed in the streaming event sequence.'

  return undefined
}

function validateFileSearch(
  result: ResponsesTransportProbeResultLike,
  sentinel: string | undefined,
): string | undefined {
  if (!sentinel)
    return 'Positive file_search validation requires a configured vector-store sentinel.'

  const commonError = validateTextResponse(result)
  if (commonError)
    return commonError

  const calls = outputItemsOfType(result, 'file_search_call')
  if (calls.length === 0)
    return 'Expected a file_search_call output item.'
  const completed = calls.find(call => call.status === 'completed')
  if (!completed)
    return 'Expected a completed file_search_call output item.'
  if (!result.eventTypes.includes('response.file_search_call.completed'))
    return 'Expected response.file_search_call.completed in the streaming event sequence.'
  if (!Array.isArray(completed.queries) || completed.queries.length === 0)
    return 'file_search_call did not report a search query.'

  const results = Array.isArray(completed.results)
    ? completed.results
    : Array.isArray(completed.search_results)
      ? completed.search_results
      : undefined
  if (!results || results.length === 0)
    return 'file_search_call.results was empty despite include=["file_search_call.results"].'
  const resultEvidence = serializeForEvidence(results)
  if (!resultEvidence.includes(sentinel))
    return 'File-search results did not contain the configured sentinel.'
  if (!hasMatchingFileCitation(result, results, sentinel))
    return 'File-search citation did not reference a result containing the configured sentinel.'

  return undefined
}

function validateTextResponse(result: ResponsesTransportProbeResultLike): string | undefined {
  const sequenceError = validateCompletedEventSequence(result)
  if (sequenceError)
    return sequenceError
  if (result.outputText.trim().length === 0)
    return 'Expected non-empty output text.'
  if (outputItemsOfType(result, 'message').length === 0)
    return 'Expected an assistant message output item.'
  if (!result.eventTypes.includes('response.output_text.done'))
    return 'Expected response.output_text.done in the streaming event sequence.'

  const terminalText = extractTerminalOutputText(result)
  if (terminalText && terminalText !== result.outputText)
    return 'Streamed output text did not match the terminal response output text.'

  return undefined
}

function validateCompletedEventSequence(result: ResponsesTransportProbeResultLike): string | undefined {
  if (!result.completed)
    return 'Probe did not report a completed response.'
  if (result.terminalType !== 'response.completed')
    return `Expected response.completed, got ${result.terminalType}.`
  if (result.response?.status !== 'completed')
    return `Expected terminal response status=completed, got ${String(result.response?.status)}.`
  if (result.error)
    return `Completed response unexpectedly carried error ${result.error.code ?? result.error.type ?? 'unknown'}.`
  if (!result.eventTypes.includes('response.created'))
    return 'Expected response.created in the streaming event sequence.'
  if (!result.eventTypes.includes('response.completed'))
    return 'Expected response.completed in the streaming event sequence.'
  if (result.eventTypes.some(type => type === 'error' || type === 'response.failed' || type === 'response.incomplete'))
    return 'Successful event sequence contained an error, failed, or incomplete terminal event.'

  const terminalCount = result.eventTypes.filter(type =>
    type === 'error'
    || type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete').length
  if (terminalCount !== 1)
    return `Expected exactly one terminal event, got ${terminalCount}.`

  let previousSequence: number | undefined
  for (const frame of result.frames) {
    const sequence = frame.sequence_number
    if (typeof sequence !== 'number' || !Number.isInteger(sequence))
      return `Event ${String(frame.type)} omitted an integer sequence_number.`
    if (previousSequence !== undefined && sequence <= previousSequence)
      return 'Responses event sequence_number values were not strictly increasing.'
    previousSequence = sequence
  }

  // Copilot currently emits a distinct opaque event-local ID in each lifecycle
  // snapshot. Require a usable terminal ID, but do not apply OpenAI's stable-ID
  // expectation here because this gate compares feature semantics by transport.
  const terminalId = typeof result.response?.id === 'string' ? result.response.id : undefined
  if (!terminalId)
    return 'response.completed omitted a response ID.'

  return undefined
}

function classifyFailureEvidence(
  scenario: ResponsesTransportParityScenario,
  transport: 'sse' | 'websocket',
  evidence: string,
  error?: ResponsesTransportErrorDetails,
): ResponsesTransportOutcome {
  if (isExplicitCapabilityUnsupported(scenario, evidence))
    return capabilityUnsupportedOutcome(scenario, transport, evidence, error)
  if (isFileSearchResourceUnavailable(scenario, evidence))
    return outcome('resource_unavailable', transport, evidence)
  if (scenario.feature === 'mcp' && looksLikeMcpDependencyFailure(evidence))
    return outcome('dependency_unavailable', transport, evidence)

  return outcome('transport_error', transport, evidence || 'Unknown probe error.')
}

function isExplicitCapabilityUnsupported(
  scenario: ResponsesTransportParityScenario,
  evidence: string,
): boolean {
  const normalized = evidence.toLowerCase()
  const featureTerms = featureTermsFor(scenario.feature)
  if (!featureTerms.some(term => normalized.includes(term)))
    return false
  if (scenario.feature === 'mcp' && normalized.includes('server') && normalized.includes('does not support'))
    return false

  return [
    'model does not support',
    'model doesn\'t support',
    'not supported for this model',
    'is not supported',
    'unsupported tool type',
    'unsupported feature',
    'feature is unavailable',
    'feature not available',
    'not enabled for this model',
    'not permitted for this model',
    'allowedpartnermodelfeatures',
    'disallowed feature',
    'organization policy constraint',
  ].some(term => normalized.includes(term))
}

function isFileSearchResourceUnavailable(
  scenario: ResponsesTransportParityScenario,
  evidence: string,
): boolean {
  if (scenario.feature !== 'file_search')
    return false

  const normalized = evidence.toLowerCase()
  if (normalized.includes('vector_store_not_found') || normalized.includes('vector store not found'))
    return true
  return /\bvector[_ ]store\b.{1,120}\b(?:was\s+)?(?:not found|does not exist)\b/.test(normalized)
    || /\b(?:no such|unknown)\s+vector[_ ]store\b/.test(normalized)
}

function classifyMcpResultFailure(
  scenario: ResponsesTransportParityScenario,
  result: ResponsesTransportProbeResultLike,
  evidence: string,
): Extract<ResponsesTransportOutcomeCategory, 'dependency_unavailable' | 'validation_failed'> | undefined {
  if (scenario.feature !== 'mcp')
    return undefined

  const hasFailedEvent = result.eventTypes.includes('response.mcp_list_tools.failed')
    || result.eventTypes.includes('response.mcp_call.failed')
  const hasFailedCall = result.eventTypes.includes('response.mcp_call.failed')
    || result.outputItems.some(item => item.type === 'mcp_call'
      && item.error !== null && item.error !== undefined)
  if (hasFailedCall)
    return 'validation_failed'

  const mcpItems = result.outputItems.filter(item => item.type === 'mcp_list_tools')
  const hasErrorItem = mcpItems.some(item => item.error !== null && item.error !== undefined)

  if (looksLikeMcpDependencyFailure(evidence))
    return 'dependency_unavailable'

  return hasFailedEvent || hasErrorItem ? 'validation_failed' : undefined
}

function looksLikeMcpDependencyFailure(evidence: string): boolean {
  const normalized = evidence.toLowerCase()
  const mentionsMcpDependency = normalized.includes('mcp')
    || normalized.includes('server_url')
    || normalized.includes('list tools')
    || normalized.includes('list_tools')
  if (!mentionsMcpDependency)
    return false

  return /\b(?:connection|connect|connected|connecting|dns|fetch|unreachable)\b/.test(normalized)
    || [
      'failed to list',
      'list_tools failed',
      'mcp protocol',
      'timed out',
      'timeout',
    ].some(term => normalized.includes(term))
}

function collectResultErrorEvidence(result: ResponsesTransportProbeResultLike): string {
  const values: Array<unknown> = [
    result.error?.status === undefined ? undefined : `status=${result.error.status}`,
    result.error?.type,
    result.error?.code,
    result.error?.param,
    result.error?.message,
    result.terminalEvent.status === undefined ? undefined : `status=${String(result.terminalEvent.status)}`,
    isRecord(result.response?.error) ? result.response.error : undefined,
    isRecord(result.response?.incomplete_details) ? result.response.incomplete_details : undefined,
  ]

  for (const item of result.outputItems) {
    if (item.error !== null && item.error !== undefined)
      values.push(item.error)
  }

  return truncate(flattenEvidence(values), MAX_DETAIL_LENGTH)
}

function collectThrownErrorEvidence(error: unknown): string {
  if (!(error instanceof Error))
    return truncate(flattenEvidence([error]), MAX_DETAIL_LENGTH)

  const extended = error as Error & {
    details?: unknown
    httpStatus?: unknown
    phase?: unknown
  }
  return truncate(flattenEvidence([
    error.name,
    error.message,
    extended.phase === undefined ? undefined : `phase=${String(extended.phase)}`,
    extended.httpStatus === undefined ? undefined : `httpStatus=${String(extended.httpStatus)}`,
    extended.details,
  ]), MAX_DETAIL_LENGTH)
}

function collectThrownErrorDetails(error: unknown): ResponsesTransportErrorDetails | undefined {
  if (!(error instanceof Error))
    return undefined

  const extended = error as Error & {
    details?: unknown
    httpStatus?: unknown
  }
  const details = isRecord(extended.details) ? extended.details : undefined
  return {
    code: typeof details?.code === 'string' ? details.code : undefined,
    message: typeof details?.message === 'string' ? details.message : error.message,
    param: typeof details?.param === 'string' || details?.param === null ? details.param : undefined,
    status: typeof details?.status === 'number'
      ? details.status
      : typeof extended.httpStatus === 'number'
        ? extended.httpStatus
        : undefined,
    type: typeof details?.type === 'string' ? details.type : undefined,
  }
}

function featureTermsFor(feature: ResponsesParityFeature): Array<string> {
  switch (feature) {
    case 'function_tool_control':
      return ['function', 'tool_choice', 'tool choice']
    case 'json_object':
      return ['json_object', 'json object', 'text.format']
    case 'json_schema':
      return ['json_schema', 'json schema', 'text.format']
    case 'web_search':
      return ['web_search', 'web search']
    case 'web_search_preview':
      return ['web_search_preview', 'web search preview']
    case 'mcp':
      return ['mcp', 'server_url', 'server_label']
    case 'file_search':
      return ['file_search', 'file search', 'vector_store', 'vector store']
  }
}

function outcome(
  category: ResponsesTransportOutcomeCategory,
  transport: 'sse' | 'websocket',
  detail: string,
): ResponsesTransportOutcome {
  return {
    category,
    detail: detail ? truncate(detail, MAX_DETAIL_LENGTH) : undefined,
    transport,
  }
}

function capabilityUnsupportedOutcome(
  scenario: ResponsesTransportParityScenario,
  transport: 'sse' | 'websocket',
  detail: string,
  error?: ResponsesTransportErrorDetails,
): ResponsesTransportOutcome {
  return {
    ...outcome('explicit_capability_unsupported', transport, detail),
    capabilityCode: normalizeCapabilityCode(error?.code),
    capabilityFingerprint: capabilityFingerprint(scenario, detail),
    capabilityMessage: normalizeCapabilityEvidence(error?.message ?? detail),
    capabilityParam: normalizeCapabilityParam(scenario, error?.param, error?.message ?? detail),
  }
}

function normalizeCapabilityCode(value: string | undefined): string | undefined {
  const normalized = normalizeCapabilityEvidence(value)
  if (!normalized)
    return 'unsupported'
  if (normalized === 'bad_request' || normalized === 'unsupported_value')
    return 'unsupported'
  return normalized
}

function normalizeCapabilityParam(
  scenario: ResponsesTransportParityScenario,
  value: string | null | undefined,
  message: string,
): string {
  const normalized = normalizeCapabilityEvidence(value ?? undefined)
  if (normalized?.includes('tool_choice'))
    return 'tool_choice'
  if (normalized?.startsWith('tools'))
    return 'tools'
  if (normalized?.includes('text.format') || normalized?.includes('text[format]'))
    return 'text.format'
  if (normalized)
    return normalized

  const normalizedMessage = message.toLowerCase()
  if (scenario.feature === 'function_tool_control'
    && (normalizedMessage.includes('tool_choice') || normalizedMessage.includes('tool choice'))) {
    return 'tool_choice'
  }
  if (scenario.feature === 'json_object' || scenario.feature === 'json_schema')
    return 'text.format'
  return 'tools'
}

function capabilityFingerprint(
  scenario: ResponsesTransportParityScenario,
  evidence: string,
): string {
  const normalized = evidence.toLowerCase()
  const matchedTerm = featureTermsFor(scenario.feature)
    .find(term => normalized.includes(term))
    ?.toLowerCase()
    .replaceAll(/[\s_.-]+/g, '')

  return `${scenario.feature}:${matchedTerm ?? 'feature'}`
}

function formatOutcome(outcome: ResponsesTransportOutcome): string {
  return `${outcome.transport}=${outcome.category}${outcome.detail ? `:${truncate(outcome.detail, 100)}` : ''}`
}

function outputItemsOfType(
  result: ResponsesTransportProbeResultLike,
  type: string,
): Array<Record<string, unknown>> {
  return result.outputItems.filter(item => item.type === type)
}

function extractTerminalOutputText(result: ResponsesTransportProbeResultLike): string {
  const output = Array.isArray(result.response?.output) ? result.response.output : []
  const parts: Array<string> = []
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content))
      continue
    for (const content of item.content) {
      if (isRecord(content) && content.type === 'output_text' && typeof content.text === 'string')
        parts.push(content.text)
    }
  }
  return parts.join('')
}

function reportsExampleDomainHeading(outputText: string): boolean {
  const normalized = outputText.trim().replaceAll(/\s+/g, ' ')
  const unwrapped = normalized
    .replace(/^#{1,6}\s*/, '')
    .replace(/^["'`*_“”‘’]+|["'`*_“”‘’]+$/g, '')

  if (/^example domain[.!]?$/i.test(unwrapped))
    return true

  const negativeClaim = /\b(?:not|never|isn't|wasn't|could not|couldn't|cannot|can't|unable to|failed to|did not|does not)\b[^.!?]{1,120}\bexample domain\b/i.test(normalized)
    || /\bexample domain\b[^.!?]{1,80}\b(?:is|was|does)\s+not\b/i.test(normalized)
  if (negativeClaim)
    return false

  return /\b(?:h1(?:\s+heading)?|heading)\b.{1,100}\bexample domain\b/i.test(normalized)
    || /\bexample domain\b.{1,100}\b(?:h1(?:\s+heading)?|heading)\b/i.test(normalized)
}

function hasExampleDomainCitationOrSource(result: ResponsesTransportProbeResultLike): boolean {
  for (const item of outputItemsOfType(result, 'message')) {
    if (!Array.isArray(item.content))
      continue
    for (const content of item.content) {
      if (!isRecord(content) || !Array.isArray(content.annotations))
        continue
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || annotation.type !== 'url_citation')
          continue
        if (isExampleDomainUrl(annotation.url))
          return true
        if (isRecord(annotation.url_citation) && isExampleDomainUrl(annotation.url_citation.url))
          return true
      }
    }
  }

  return outputItemsOfType(result, 'web_search_call').some((call) => {
    if (!isRecord(call.action))
      return false
    return Array.isArray(call.action.sources)
      && call.action.sources.some(source => isRecord(source) && isExampleDomainUrl(source.url))
  })
}

function isExampleDomainUrl(value: unknown): boolean {
  if (typeof value !== 'string')
    return false
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase()
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && (hostname === 'example.com' || hostname.endsWith('.example.com'))
  }
  catch {
    return false
  }
}

function hasMatchingFileCitation(
  result: ResponsesTransportProbeResultLike,
  results: unknown[],
  sentinel: string,
): boolean {
  const matchingFileIds = new Set<string>()
  const matchingFilenames = new Set<string>()
  for (const searchResult of results) {
    if (!isRecord(searchResult) || !serializeForEvidence(searchResult).includes(sentinel))
      continue
    if (typeof searchResult.file_id === 'string')
      matchingFileIds.add(searchResult.file_id)
    if (typeof searchResult.filename === 'string')
      matchingFilenames.add(searchResult.filename)
  }

  if (matchingFileIds.size === 0 && matchingFilenames.size === 0)
    return false

  for (const item of outputItemsOfType(result, 'message')) {
    if (!Array.isArray(item.content))
      continue
    for (const content of item.content) {
      if (!isRecord(content) || !Array.isArray(content.annotations))
        continue
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || annotation.type !== 'file_citation')
          continue
        if (matchingFileIds.size > 0) {
          if (typeof annotation.file_id === 'string' && matchingFileIds.has(annotation.file_id))
            return true
          continue
        }
        if (typeof annotation.filename === 'string' && matchingFilenames.has(annotation.filename))
          return true
      }
    }
  }
  return false
}

function normalizeCapabilityEvidence(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replaceAll(/\s+/g, ' ')
  return normalized || undefined
}

function arrayHasNamedTool(value: unknown, name: string): boolean {
  return Array.isArray(value)
    && value.some(tool => isRecord(tool) && tool.name === name)
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value))
    return value
  if (typeof value !== 'string')
    return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed : undefined
  }
  catch {
    return undefined
  }
}

function normalizeDiceExpression(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value.toLowerCase().replaceAll(/\s+/g, '')
    : undefined
}

function hasDeterministicMcpResultOne(value: unknown): boolean {
  const resultValues = collectMcpResultValues(value)
  return resultValues.length > 0
    && resultValues.every(result => result === 1 || result === '1')
}

function collectMcpResultValues(value: unknown, depth = 0): Array<number | string> {
  if (depth > 5)
    return []
  if (typeof value === 'number')
    return [value]
  if (typeof value === 'string') {
    const normalized = value.trim()
    const labelledResult = normalized.match(/^result\s*[:=]\s*(-?\d+(?:\.\d+)?)$/i)?.[1]
    if (labelledResult)
      return [Number(labelledResult)]
    try {
      return collectMcpResultValues(JSON.parse(normalized) as unknown, depth + 1)
    }
    catch {
      return [normalized]
    }
  }
  if (Array.isArray(value))
    return value.flatMap(item => collectMcpResultValues(item, depth + 1))
  if (!isRecord(value))
    return []

  return ['content', 'output', 'result', 'roll', 'text', 'total', 'value']
    .flatMap(key => Object.hasOwn(value, key)
      ? collectMcpResultValues(value[key], depth + 1)
      : [])
}

function flattenEvidence(values: Array<unknown>): string {
  return values
    .flatMap(value => evidenceStrings(value))
    .filter(Boolean)
    .join(' | ')
}

function evidenceStrings(value: unknown, depth = 0): Array<string> {
  if (value === undefined || value === null || depth > 3)
    return []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return [String(value)]
  if (Array.isArray(value))
    return value.flatMap(item => evidenceStrings(item, depth + 1))
  if (!isRecord(value))
    return []

  return Object.entries(value).flatMap(([key, nested]) => [
    key,
    ...evidenceStrings(nested, depth + 1),
  ])
}

function serializeForEvidence(value: unknown): string {
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`
}
