import { randomBytes } from 'node:crypto'
import process from 'node:process'
import { isDeepStrictEqual } from 'node:util'

const TERMINAL_EVENT_TYPES = new Set([
  'error',
  'response.completed',
  'response.failed',
  'response.incomplete',
])
const FIRST_PROMPT = 'Call remember_code exactly once with the code required by the tool description. Do not emit assistant text.'
const SECOND_PROMPT = 'What exact code was passed to remember_code? Reply with only that code.'

interface ResponsesStreamResult {
  frames: Array<Record<string, unknown>>
  terminal: Record<string, unknown>
}

interface FirstTurnEvidence {
  functionCallId: string
  observedItemIdFields: number
  output: Array<Record<string, unknown>>
  reasoningItems: number
}

async function run(): Promise<void> {
  const baseUrl = requiredEnvironmentVariable('ITEM_REPLAY_BASE_URL').replace(/\/$/, '')
  const model = requiredEnvironmentVariable('COPILOT_LIVE_RESPONSES_MODEL')
  const timeoutMs = parsePositiveInteger(
    process.env.ITEM_REPLAY_TIMEOUT_MS,
    180_000,
  )
  const expectedCode = randomBytes(8).toString('hex').toUpperCase()

  const first = await streamResponses(baseUrl, {
    model,
    input: [{ role: 'user', content: FIRST_PROMPT }],
    include: ['reasoning.encrypted_content'],
    max_output_tokens: 1024,
    reasoning: { effort: 'high', summary: 'detailed' },
    store: false,
    stream: true,
    tools: [{
      type: 'function',
      name: 'remember_code',
      description: `Record exactly this code: ${expectedCode}`,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string' },
        },
        required: ['code'],
        additionalProperties: false,
      },
      strict: true,
    }],
    tool_choice: { type: 'function', name: 'remember_code' },
  }, timeoutMs)
  const firstEvidence = validateFirstTurn(first, expectedCode)

  const replayRequest = buildReplayRequest(
    model,
    firstEvidence.output,
    firstEvidence.functionCallId,
    expectedCode,
  )
  const second = await streamResponses(baseUrl, replayRequest, timeoutMs)
  assertCompleted(second.terminal, 'second')
  const secondOutput = outputText(second.terminal)
  if (secondOutput !== expectedCode)
    throw new Error('The replayed response did not return the expected semantic sentinel')

  process.stdout.write(
    `responses_item_replay_client=passed first_output_items=${firstEvidence.output.length} reasoning_items=${firstEvidence.reasoningItems} observed_item_id_fields=${firstEvidence.observedItemIdFields} first_seen_ids_stable=true replay_output_deep_equal=true replay_previous_response_id_absent=true encrypted_reasoning_replayed=true semantic_depends_on_replayed_output=true second_terminal=response.completed second_output_matches_generated_code=true\n`,
  )
}

function buildReplayRequest(
  model: string,
  output: Array<Record<string, unknown>>,
  functionCallId: string,
  expectedCode: string,
): Record<string, unknown> {
  const request = {
    model,
    input: [
      { role: 'user', content: FIRST_PROMPT },
      ...output,
      {
        type: 'function_call_output',
        call_id: functionCallId,
        output: 'Code stored successfully.',
      },
      { role: 'user', content: SECOND_PROMPT },
    ],
    include: ['reasoning.encrypted_content'],
    max_output_tokens: 1024,
    reasoning: { effort: 'high', summary: 'detailed' },
    store: false,
    stream: true,
  }
  const wireRequest = JSON.parse(JSON.stringify(request)) as Record<string, unknown>
  const wireInput = Array.isArray(wireRequest.input) ? wireRequest.input : []
  const replayEnd = 1 + output.length
  const replayedOutput = wireInput.slice(1, replayEnd)

  if (!isDeepStrictEqual(replayedOutput, output))
    throw new Error('The second request did not preserve the complete first response output')
  if (Object.hasOwn(wireRequest, 'previous_response_id'))
    throw new Error('The stateless replay request must not use previous_response_id')
  const functionOutput = wireInput[replayEnd]
  if (
    !isRecord(functionOutput)
    || functionOutput.type !== 'function_call_output'
    || functionOutput.call_id !== functionCallId
  ) {
    throw new Error('The replay request did not preserve function-call ordering')
  }
  const nonReplayInput = [wireInput[0], ...wireInput.slice(replayEnd)]
  if (JSON.stringify(nonReplayInput).includes(expectedCode))
    throw new Error('The generated semantic sentinel escaped the replayed output slice')

  return wireRequest
}

function validateFirstTurn(
  result: ResponsesStreamResult,
  expectedCode: string,
): FirstTurnEvidence {
  const terminalResponse = assertCompleted(result.terminal, 'first')
  const output = readOutput(terminalResponse)
  const observations = new Map<number, Array<string>>()

  for (const frame of result.frames) {
    const outputIndex = readOutputIndex(frame.output_index)
    if (outputIndex !== undefined) {
      const item = isRecord(frame.item) ? frame.item : undefined
      addIdObservation(observations, outputIndex, item?.id)
      addIdObservation(observations, outputIndex, frame.item_id)
    }
  }
  for (const [index, item] of output.entries())
    addIdObservation(observations, index, item.id)

  let observedItemIdFields = 0
  for (const [index, item] of output.entries()) {
    const terminalId = readNonEmptyString(item.id)
    if (!terminalId)
      throw new Error('The first response returned an output item without an ID')
    const itemObservations = observations.get(index) ?? []
    observedItemIdFields += itemObservations.length
    if (itemObservations.length < 2)
      throw new Error('The first response did not expose enough item-ID lifecycle evidence')
    if (new Set(itemObservations).size !== 1 || itemObservations[0] !== terminalId)
      throw new Error('The client-visible item IDs were not stable through the complete lifecycle')
  }

  const reasoningItems = output.filter(item => item.type === 'reasoning')
  if (reasoningItems.length === 0)
    throw new Error('The first response did not return a reasoning item')
  if (!reasoningItems.every(item => readNonEmptyString(item.encrypted_content)))
    throw new Error('The first response reasoning item did not include encrypted_content')

  const functionCall = output.find(item =>
    item.type === 'function_call' && item.name === 'remember_code')
  const functionCallId = functionCall
    ? readNonEmptyString(functionCall.call_id)
    : undefined
  const rawArguments = functionCall
    ? readNonEmptyString(functionCall.arguments)
    : undefined
  if (!functionCallId || !rawArguments)
    throw new Error('The first response did not return the required function call')
  let toolArguments: unknown
  try {
    toolArguments = JSON.parse(rawArguments)
  }
  catch {
    throw new Error('The first response returned invalid function-call arguments')
  }
  if (!isRecord(toolArguments) || toolArguments.code !== expectedCode)
    throw new Error('The first response did not preserve the generated semantic sentinel')

  return {
    functionCallId,
    observedItemIdFields,
    output,
    reasoningItems: reasoningItems.length,
  }
}

async function streamResponses(
  baseUrl: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ResponsesStreamResult> {
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (response.status !== 200)
      throw new Error(`The item replay request failed with HTTP ${response.status}`)
    if (!response.headers.get('content-type')?.toLowerCase().includes('text/event-stream'))
      throw new Error('The item replay request did not return an SSE response')
    if (!response.body)
      throw new Error('The item replay request returned no response body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const frames: Array<Record<string, unknown>> = []
    let buffer = ''

    while (true) {
      const chunk = await reader.read()
      buffer += decoder.decode(chunk.value, { stream: !chunk.done })
      const parsed = consumeSSEBlocks(buffer)
      buffer = parsed.remaining

      for (const frame of parsed.frames) {
        frames.push(frame)
        const eventType = readNonEmptyString(frame.type)
        if (!eventType || !TERMINAL_EVENT_TYPES.has(eventType))
          continue

        await reader.cancel('item replay gate reached a terminal Responses event').catch(() => {})
        return { frames, terminal: frame }
      }

      if (chunk.done)
        throw new Error('The item replay SSE stream ended before a terminal event')
    }
  }
  catch (error) {
    if (timedOut)
      throw new Error(`The item replay request timed out after ${timeoutMs}ms`, { cause: error })
    throw error
  }
  finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

function consumeSSEBlocks(input: string): {
  frames: Array<Record<string, unknown>>
  remaining: string
} {
  const frames: Array<Record<string, unknown>> = []
  let remaining = input

  while (true) {
    const separator = /\r?\n\r?\n/.exec(remaining)
    if (!separator || separator.index === undefined)
      break

    const block = remaining.slice(0, separator.index)
    remaining = remaining.slice(separator.index + separator[0].length)
    const lines = block.split(/\r?\n/)
    const eventName = lines
      .find(line => line.startsWith('event:'))
      ?.slice(6)
      .replace(/^ /, '')
    const data = lines
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data || data === '[DONE]')
      continue

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    }
    catch {
      throw new Error('The item replay SSE stream contained invalid JSON')
    }
    if (!isRecord(parsed))
      throw new Error('The item replay SSE stream contained a non-object event')
    if (eventName && parsed.type !== eventName)
      throw new Error('The item replay SSE event name did not match its data type')
    frames.push(parsed)
  }

  return { frames, remaining }
}

function assertCompleted(
  terminal: Record<string, unknown>,
  turn: 'first' | 'second',
): Record<string, unknown> {
  if (terminal.type !== 'response.completed')
    throw new Error(`The ${turn} item replay turn ended with a non-completed event`)
  const response = isRecord(terminal.response) ? terminal.response : undefined
  if (!response || response.status !== 'completed')
    throw new Error(`The ${turn} item replay turn did not complete successfully`)
  return response
}

function outputText(terminal: Record<string, unknown>): string {
  const response = isRecord(terminal.response) ? terminal.response : undefined
  const output = response ? readOutput(response) : []
  const text: Array<string> = []

  for (const item of output) {
    if (item.type !== 'message' || !Array.isArray(item.content))
      continue
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string')
        text.push(part.text)
    }
  }
  return text.join('').trim()
}

function readOutput(response: Record<string, unknown>): Array<Record<string, unknown>> {
  if (!Array.isArray(response.output) || !response.output.every(isRecord))
    throw new Error('The item replay response did not contain a valid output array')
  return response.output
}

function addIdObservation(
  observations: Map<number, Array<string>>,
  outputIndex: number,
  value: unknown,
): void {
  const id = readNonEmptyString(value)
  if (!id)
    return
  const current = observations.get(outputIndex) ?? []
  current.push(id)
  observations.set(outputIndex, current)
}

function readOutputIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim()
  if (!value)
    throw new Error(`${name} is required for the item replay client`)
  return value
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value)
    return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error('ITEM_REPLAY_TIMEOUT_MS must be a positive safe integer')
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Unknown item replay failure'}\n`)
  process.exitCode = 1
})
