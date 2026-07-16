import type WebSocket from 'ws'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'

import { describe, expect, test } from 'bun:test'

import {
  DirectCopilotResponsesWebSocketProbeError,
  exchangeResponseCreate,
  extractResponsesWebSocketError,
  summarizeResponsesWebSocketFrames,
} from './copilot-responses-websocket'

class LateErrorAfterTerminateSocket extends EventEmitter {
  private terminated = false

  close(): void {}

  send(): void {}

  terminate(): void {
    if (this.terminated)
      return
    this.terminated = true
    setTimeout(() => {
      this.emit('error', new Error('late Node ws terminate error'))
      this.emit('close', 1006, Buffer.alloc(0))
    }, 0)
  }
}

describe('direct Copilot Responses WebSocket live probe helpers', () => {
  test('summarizes a completed response without losing hosted-tool output items', () => {
    const terminalEvent = {
      type: 'response.completed',
      response: {
        id: 'resp_123',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'web_search_call',
            id: 'ws_123',
            status: 'completed',
            action: { type: 'search', query: 'example' },
          },
          {
            type: 'message',
            id: 'msg_123',
            content: [{ type: 'output_text', text: 'final fallback' }],
          },
        ],
      },
    }
    const frames = [
      { type: 'response.created' },
      { type: 'response.web_search_call.in_progress' },
      { type: 'response.output_text.delta', delta: 'semantic ' },
      { type: 'response.output_text.delta', delta: 'answer' },
      terminalEvent,
    ]

    const result = summarizeResponsesWebSocketFrames(
      frames,
      terminalEvent,
      { code: 1000, reason: 'live probe complete' },
    )

    expect(result.completed).toBe(true)
    expect(result.outputText).toBe('semantic answer')
    expect(result.outputItemTypes).toEqual(['web_search_call', 'message'])
    expect(result.toolEventTypes).toEqual(['response.web_search_call.in_progress'])
    expect(result.response?.id).toBe('resp_123')
    expect(result.response?.status).toBe('completed')
    expect(result.terminalEvent).toBe(terminalEvent)
    expect(result.frames).toBe(frames)
  })

  test('falls back to final output text and preserves protocol error details', () => {
    const completed = {
      type: 'response.completed',
      response: {
        id: 'resp_fallback',
        status: 'completed',
        output: [{
          type: 'message',
          content: [
            { type: 'output_text', text: 'part one' },
            { type: 'output_text', text: ' and two' },
          ],
        }],
      },
    }
    const completedResult = summarizeResponsesWebSocketFrames(
      [completed],
      completed,
      { code: 1000, reason: '' },
    )
    expect(completedResult.outputText).toBe('part one and two')

    const errorEvent = {
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        code: 'unsupported_value',
        message: 'file_search is unavailable',
        param: 'tools[0].type',
      },
    }
    const errorResult = summarizeResponsesWebSocketFrames(
      [errorEvent],
      errorEvent,
      { code: 1000, reason: '' },
    )

    expect(errorResult.completed).toBe(false)
    expect(errorResult.terminalType).toBe('error')
    expect(errorResult.error).toEqual({
      type: 'invalid_request_error',
      code: 'unsupported_value',
      message: 'file_search is unavailable',
      param: 'tools[0].type',
      status: 400,
    })
    expect(extractResponsesWebSocketError(errorEvent)).toEqual(errorResult.error)
  })

  test('retains an error guard until close after a timed-out Node-style socket is terminated', async () => {
    const socket = new LateErrorAfterTerminateSocket()

    const error = await exchangeResponseCreate(
      socket as unknown as WebSocket,
      { type: 'response.create', model: 'gpt-test', input: 'hello' },
      1,
    ).catch(error => error)

    expect(error).toBeInstanceOf(DirectCopilotResponsesWebSocketProbeError)
    expect((error as DirectCopilotResponsesWebSocketProbeError).phase).toBe('timeout')
    expect(socket.listenerCount('error')).toBe(1)

    await new Promise(resolve => setTimeout(resolve, 10))
    expect(socket.listenerCount('error')).toBe(0)
  })
})
