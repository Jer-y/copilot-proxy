import { request as httpRequest } from 'node:http'
import { describe, expect, mock, test } from 'bun:test'
import consola from 'consola'
import { Hono } from 'hono'

import { requestLogger } from '~/lib/request-logger'
import { closeServerGracefully, createAppServer } from '~/start'

describe('request logger', () => {
  test('logs method, path, status, and timing without query names or values', async () => {
    const messages: string[] = []
    const timestamps = [1_000, 1_012]
    const app = new Hono()

    app.use(requestLogger(
      message => messages.push(message),
      () => timestamps.shift()!,
    ))
    app.get('/livez', c => c.text('ok'))

    const response = await app.request(
      '/livez?api_key=fake-api-key&token=fake-token&prompt=fake-prompt',
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
    expect(messages).toEqual([
      '<-- GET /livez',
      '--> GET /livez 200 12ms',
    ])

    const output = messages.join('\n')
    for (const sensitiveText of [
      'api_key',
      'fake-api-key',
      'token',
      'fake-token',
      'prompt',
      'fake-prompt',
    ]) {
      expect(output).not.toContain(sensitiveText)
    }
  })

  test('does not change query handling for the route', async () => {
    const messages: string[] = []
    const app = new Hono()

    app.use(requestLogger(message => messages.push(message)))
    app.get('/models', c => c.json({
      clientVersion: c.req.query('client_version'),
    }))

    const response = await app.request('/models?client_version=0.144.6')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ clientVersion: '0.144.6' })
    expect(messages).toHaveLength(2)
    expect(messages.every(message => message.includes('/models'))).toBe(true)
    expect(messages.every(message => !message.includes('?'))).toBe(true)
    expect(messages.join('\n')).not.toContain('0.144.6')
  })

  test('escapes decoded terminal control characters before logging rejected paths', async () => {
    const messages: string[] = []
    const app = new Hono()

    app.use(requestLogger(message => messages.push(message)))
    app.get('*', c => c.text('not found', 404))

    const response = await app.request('/\u001B[2Jfake?token=fake-secret')

    expect(response.status).toBe(404)
    const output = messages.join('\n')
    expect(output).toContain('/\\u001b[2Jfake')
    expect(output).not.toContain('\u001B')
    expect(output).not.toContain('fake-secret')
    expect(output).not.toContain('?token')
  })

  test('escapes encoded terminal controls through the real production listener', async () => {
    const messages: string[] = []
    const originalLog = consola.log
    consola.log = mock((message: unknown): void => {
      messages.push(String(message))
    }) as unknown as typeof consola.log
    const listener = createAppServer({ host: '127.0.0.1', port: 0, silent: true })

    try {
      await listener.ready()
      const url = new URL(String(listener.url))
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          host: url.hostname,
          path: '/%1B%5B2Jfake?token=fake-secret',
          port: Number(url.port),
        }, (response) => {
          response.resume()
          response.once('end', () => resolve(response.statusCode ?? 0))
        })
        request.once('error', reject)
        request.end()
      })

      expect(status).toBe(404)
      const output = messages.join('\n')
      expect(output).toContain('/\\u001b[2Jfake')
      expect(output).not.toContain('\u001B')
      expect(output).not.toContain('fake-secret')
      expect(output).not.toContain('?token')
    }
    finally {
      await closeServerGracefully(listener)
      consola.log = originalLog
    }
  })
})
