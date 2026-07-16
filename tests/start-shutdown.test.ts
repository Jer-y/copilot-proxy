import type { ServerWithWSOptions } from 'crossws'
import type { IncomingMessage } from 'node:http'
import type { Server } from 'srvx'

import { get as httpGet } from 'node:http'
import { describe, expect, mock, test } from 'bun:test'
import WebSocket from 'ws'

import { closeServerGracefully, createAppServer, getActiveHttpRequestCountForTests } from '~/start'

describe('createAppServer', () => {
  test('prepares WebSockets before registering them with the listener', () => {
    const events: string[] = []
    const appServer = {} as Server
    const websocketOptions = {}
    let receivedOptions: ServerWithWSOptions | undefined

    const result = createAppServer({ host: '127.0.0.1', port: 4399 }, {
      prepareResponsesWebSocketServer: () => {
        events.push('prepare')
      },
      responsesWebSocketOptions: websocketOptions,
      serve: (options) => {
        events.push('serve')
        receivedOptions = options
        return appServer
      },
    })

    expect(result).toBe(appServer)
    expect(events).toEqual(['prepare', 'serve'])
    expect(receivedOptions?.websocket).toBe(websocketOptions)
    expect(receivedOptions?.hostname).toBe('127.0.0.1')
    expect(receivedOptions?.port).toBe(4399)
    expect(receivedOptions?.gracefulShutdown).toBe(false)
    expect(receivedOptions?.bun?.idleTimeout).toBe(0)
  })
})

describe('closeServerGracefully', () => {
  test('drains active requests and WebSockets before closing', async () => {
    const close = mock(async () => {})
    const closeWebSockets = mock(async () => {})
    const forceCloseWebSockets = mock(() => {})

    await expect(closeServerGracefully({ close }, 20, {
      closeResponsesWebSocketsGracefully: closeWebSockets,
      forceCloseResponsesWebSockets: forceCloseWebSockets,
    })).resolves.toBe('graceful')
    expect(close).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledWith(false)
    expect(closeWebSockets).toHaveBeenCalledTimes(1)
    expect(forceCloseWebSockets).not.toHaveBeenCalled()
  })

  test('forces active connections closed only after the deadline', async () => {
    const events: string[] = []
    const close = mock((force?: boolean) => {
      events.push(force ? 'http:force' : 'http:graceful')
      return force ? Promise.resolve() : new Promise<void>(() => {})
    })
    const closeWebSockets = mock(() => {
      events.push('ws:graceful')
      return new Promise<void>(() => {})
    })
    const forceCloseWebSockets = mock(() => {
      events.push('ws:force')
    })

    await expect(closeServerGracefully({ close }, 10, {
      closeResponsesWebSocketsGracefully: closeWebSockets,
      forceCloseResponsesWebSockets: forceCloseWebSockets,
    })).resolves.toBe('forced')
    expect(close).toHaveBeenCalledTimes(2)
    expect(close.mock.calls.map(call => call[0])).toEqual([false, true])
    expect(closeWebSockets).toHaveBeenCalledTimes(1)
    expect(forceCloseWebSockets).toHaveBeenCalledTimes(1)
    expect(events).toEqual([
      'ws:graceful',
      'http:graceful',
      'ws:force',
      'http:force',
    ])
  })

  test('finalizes a drained Bun listener without misclassifying it as forced', async () => {
    const events: string[] = []
    const stop = mock(async (_force?: boolean) => {
      events.push('runtime:finalize')
    })
    const runtimeServer = { pendingRequests: 1, stop }
    const close = mock((force?: boolean) => {
      events.push(force ? 'http:unexpected-force' : 'http:graceful')
      return Promise.resolve()
    })
    const closeWebSockets = mock(async () => {
      events.push('ws:graceful')
    })
    const forceCloseWebSockets = mock(() => {})
    setTimeout(() => {
      runtimeServer.pendingRequests = 0
    }, 5)

    const result = await closeServerGracefully({
      runtime: 'bun',
      bun: { server: runtimeServer },
      close,
    } as unknown as Server, 100, {
      closeResponsesWebSocketsGracefully: closeWebSockets,
      forceCloseResponsesWebSockets: forceCloseWebSockets,
    })

    expect(result).toBe('graceful')
    expect(close).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledWith(true)
    expect(forceCloseWebSockets).not.toHaveBeenCalled()
    expect(events).toEqual(['ws:graceful', 'runtime:finalize'])
  })

  test('does not finalize Bun while an HTTP request is still pending', async () => {
    const stop = mock(async (_force?: boolean) => {})
    const runtimeServer = { pendingRequests: 1, stop }
    const close = mock((force?: boolean) => {
      if (force)
        throw new Error('Bun force-close must bypass the stuck srvx wrapper')
      return new Promise<void>(() => {})
    })
    const closeWebSockets = mock(async () => {})
    const forceCloseWebSockets = mock(() => {})

    const result = await closeServerGracefully({
      runtime: 'bun',
      bun: { server: runtimeServer },
      close,
    } as unknown as Server, 10, {
      closeResponsesWebSocketsGracefully: closeWebSockets,
      forceCloseResponsesWebSockets: forceCloseWebSockets,
    })

    expect(result).toBe('forced')
    expect(close).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledWith(true)
    expect(forceCloseWebSockets).toHaveBeenCalledTimes(1)
  })

  test('force-stops a real Bun HTTP stream after the shutdown deadline', async () => {
    const appServer = createAppServer(
      { host: '127.0.0.1', port: 0 },
      undefined,
      () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('stream-started'))
        },
      })),
    )
    await appServer.ready()
    const response = await openHttpStream(appServer.url!)
    expect(response.statusCode).toBe(200)
    await new Promise<void>((resolve, reject) => {
      response.once('data', () => {
        response.pause()
        resolve()
      })
      response.once('error', reject)
    })
    expect(getActiveHttpRequestCountForTests(appServer)).toBe(1)
    const streamTerminated = new Promise<'closed' | 'ended' | 'errored'>((resolve) => {
      response.once('aborted', () => resolve('closed'))
      response.once('close', () => resolve('closed'))
      response.once('end', () => resolve('ended'))
      response.once('error', () => resolve('errored'))
    })
    let serverClosed = false

    try {
      await expect(closeServerGracefully(appServer, 100, {
        closeResponsesWebSocketsGracefully: async () => {},
        forceCloseResponsesWebSockets: () => {},
      })).resolves.toBe('forced')
      serverClosed = true
      const streamOutcome = await Promise.race([
        streamTerminated,
        Bun.sleep(200).then(() => 'pending'),
      ])
      expect(streamOutcome).not.toBe('pending')
    }
    finally {
      if (!serverClosed)
        await appServer.bun?.server?.stop(true)
      response.destroy()
    }
  })

  test('closes a real Bun Responses WebSocket gracefully before finalizing the listener', async () => {
    const appServer = createAppServer({ host: '127.0.0.1', port: 0 })
    await appServer.ready()
    const websocket = new WebSocket(`${appServer.url}v1/responses`)

    try {
      await new Promise<void>((resolve, reject) => {
        websocket.once('open', resolve)
        websocket.once('error', reject)
      })
      const closed = new Promise<void>((resolve) => {
        websocket.once('close', () => resolve())
      })

      await expect(closeServerGracefully(appServer, 1_000)).resolves.toBe('graceful')
      await closed
      expect(websocket.readyState).toBe(WebSocket.CLOSED)
    }
    finally {
      await appServer.close(true)
    }
  })

  test('forces close when graceful close rejects', async () => {
    const close = mock((force?: boolean) => force ? Promise.resolve() : Promise.reject(new Error('close failed')))
    const closeWebSockets = mock(async () => {})
    const forceCloseWebSockets = mock(() => {})

    await expect(closeServerGracefully({ close }, 20, {
      closeResponsesWebSocketsGracefully: closeWebSockets,
      forceCloseResponsesWebSockets: forceCloseWebSockets,
    })).resolves.toBe('forced')
    expect(close.mock.calls.map(call => call[0])).toEqual([false, true])
    expect(closeWebSockets).toHaveBeenCalledTimes(1)
    expect(forceCloseWebSockets).toHaveBeenCalledTimes(1)
  })

  test('forces close when graceful close throws synchronously', async () => {
    const close = mock((force?: boolean) => {
      if (!force)
        throw new Error('synchronous close failure')
      return Promise.resolve()
    })
    const closeWebSockets = mock(async () => {})
    const forceCloseWebSockets = mock(() => {})

    await expect(closeServerGracefully({ close }, 20, {
      closeResponsesWebSocketsGracefully: closeWebSockets,
      forceCloseResponsesWebSockets: forceCloseWebSockets,
    })).resolves.toBe('forced')
    expect(close.mock.calls.map(call => call[0])).toEqual([false, true])
    expect(closeWebSockets).toHaveBeenCalledTimes(1)
    expect(forceCloseWebSockets).toHaveBeenCalledTimes(1)
  })

  test('forces close when WebSocket draining rejects', async () => {
    const close = mock(async (_force?: boolean) => {})
    const closeWebSockets = mock(async () => {
      throw new Error('WebSocket close failed')
    })
    const forceCloseWebSockets = mock(() => {})

    await expect(closeServerGracefully({ close }, 20, {
      closeResponsesWebSocketsGracefully: closeWebSockets,
      forceCloseResponsesWebSockets: forceCloseWebSockets,
    })).resolves.toBe('forced')
    expect(close.mock.calls.map(call => call[0])).toEqual([false, true])
    expect(forceCloseWebSockets).toHaveBeenCalledTimes(1)
  })
})

async function openHttpStream(url: string): Promise<IncomingMessage> {
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const request = httpGet(url, resolve)
    request.once('error', reject)
  })
}
