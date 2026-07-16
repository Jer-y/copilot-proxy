import type { Buffer } from 'node:buffer'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import process from 'node:process'
import WebSocket from 'ws'

import { openCopilotResponsesWebSocketAttempt } from '~/services/copilot/responses-websocket'
import { closeServerGracefully, createAppServer } from '~/start'

const listener = createAppServer({ host: '127.0.0.1', port: 0 })
let listenerClosed = false

try {
  await listener.ready()
  assert.equal(listener.runtime, 'node')
  assert.ok(listener.url, 'srvx did not expose its bound Node.js listener URL')
  const listenerUrl = listener.url

  const response = await fetch(listener.url)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'Server running')

  const websocketUrl = `${listener.url.replace(/^http/, 'ws')}v1/responses`
  const websocket = new WebSocket(websocketUrl)
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Node.js Responses WebSocket upgrade timed out')), 5_000)
    websocket.once('open', () => {
      clearTimeout(timeout)
      resolve()
    })
    websocket.once('error', reject)
  })
  websocket.close(1000, 'smoke complete')
  await new Promise<void>((resolve) => {
    websocket.once('close', () => resolve())
  })

  await verifyRejectedHandshakeDoesNotEmitUnhandledError()
  await verifyAbortedHandshakeDoesNotEmitUnhandledError()
  await verifyForcedShutdownTerminatesNonAcknowledgingWebSocket(listener)
  listenerClosed = true

  process.stdout.write(`Node.js HTTP and WebSocket listener smoke passed at ${listenerUrl}\n`)
}
finally {
  if (!listenerClosed)
    await closeServerGracefully(listener)
}

async function verifyForcedShutdownTerminatesNonAcknowledgingWebSocket(
  server: ReturnType<typeof createAppServer>,
): Promise<void> {
  const socket = await openRawWebSocket(`${server.url!.replace(/^http/, 'ws')}v1/responses`)
  const socketClosed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
  })

  const result = await closeServerGracefully(server, 100)
  assert.equal(result, 'forced')
  await Promise.race([
    socketClosed,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Forced Node.js shutdown left an upgraded socket open')), 1_000)
    }),
  ])
  assert.equal(socket.destroyed, true)
}

async function openRawWebSocket(url: string): Promise<import('node:net').Socket> {
  const target = new URL(url)
  const socket = createConnection({
    host: target.hostname,
    port: Number(target.port),
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })

  const key = randomBytes(16).toString('base64')
  socket.write([
    `GET ${target.pathname} HTTP/1.1`,
    `Host: ${target.host}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${key}`,
    '',
    '',
  ].join('\r\n'))

  await new Promise<void>((resolve, reject) => {
    let response = ''
    const timeout = setTimeout(onTimeout, 5_000)

    function cleanup() {
      clearTimeout(timeout)
      socket.off('data', onData)
      socket.off('error', onError)
    }
    function onData(chunk: Buffer) {
      response += chunk.toString('latin1')
      if (!response.includes('\r\n\r\n'))
        return
      cleanup()
      if (!/^HTTP\/1\.1 101\b/.test(response)) {
        reject(new Error(`Raw Node.js WebSocket upgrade failed: ${response.split('\r\n', 1)[0]}`))
        return
      }
      resolve()
    }
    function onError(error: Error) {
      cleanup()
      reject(error)
    }
    function onTimeout() {
      cleanup()
      reject(new Error('Raw Node.js WebSocket upgrade timed out'))
    }

    socket.on('data', onData)
    socket.once('error', onError)
  })

  return socket
}

async function verifyRejectedHandshakeDoesNotEmitUnhandledError(): Promise<void> {
  const server = createServer()
  server.on('upgrade', (_request, socket) => {
    socket.end([
      'HTTP/1.1 401 Unauthorized',
      'Content-Type: text/plain',
      'Content-Length: 12',
      'Connection: close',
      '',
      'Unauthorized',
    ].join('\r\n'))
  })
  const url = await listen(server)
  try {
    const result = await openCopilotResponsesWebSocketAttempt(url.replace(/^http/, 'ws'), {})
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.response.status, 401)
      assert.equal(await result.response.text(), 'Unauthorized')
    }
  }
  finally {
    await closeHttpServer(server)
  }
}

async function verifyAbortedHandshakeDoesNotEmitUnhandledError(): Promise<void> {
  const server = createServer()
  const upgradedSockets = new Set<Duplex>()
  server.on('upgrade', (_request, socket) => {
    upgradedSockets.add(socket)
    socket.once('close', () => upgradedSockets.delete(socket))
  })
  const url = await listen(server)
  const controller = new AbortController()
  try {
    const attempt = openCopilotResponsesWebSocketAttempt(url.replace(/^http/, 'ws'), {}, controller.signal)
    setTimeout(() => controller.abort('node smoke abort'), 10)
    await assert.rejects(attempt, { name: 'AbortError' })
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  finally {
    for (const socket of upgradedSockets)
      socket.destroy()
    await closeHttpServer(server)
  }
}

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/`
}

async function closeHttpServer(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error)
        reject(error)
      else
        resolve()
    })
  })
}
